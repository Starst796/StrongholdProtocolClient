package site.starst.stronghold.update;

import android.content.Context;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * The writable layer over the APK's payload: whatever an incremental update changed, on the device's own storage.
 *
 * An APK cannot rewrite its own {@code assets/public}, so an in-app update cannot replace files there. The changed
 * files are unpacked into
 *
 *   filesDir/overlay/active.json          { build, version, files, at }
 *   filesDir/overlay/&lt;build&gt;/…            the changed files, at their payload-relative paths
 *   filesDir/overlay/&lt;build&gt;/payload.json the 清单: the base payload's list with the changed entries replaced
 *
 * and two readers consult it before falling back to the assets:
 *
 *   * {@link OverlayRouteProcessor} — the WebView (Capacitor's local server asks it per request);
 *   * {@link site.starst.stronghold.host.OverlayStaticSource} — the LAN host, which serves the same payload.
 *
 * The base of every update stays the installed APK, trusted because Android verified its signature, so an overlay can
 * only ever *add* to a payload that is already there. That is also why an overlay whose build is not newer than the
 * APK's is discarded (see {@link #active()}) — a later full install must win over an older patch.
 *
 * A delta pack carries its own list beside the files:
 *
 *   payload/delta.json   { schema, from, to, version, files: { path: [size, sha256] } }
 *
 * and {@link #apply} refuses to activate anything that does not match it, file by file — a download cut short, a
 * truncated pack or a swapped CDN copy all fail before a single byte is served, and the previous state stays
 * untouched (files are unpacked into a staging directory that is renamed into place only at the very end).
 *
 * Only added and changed files are in a pack. Upstream *deleting* a file cannot be expressed as an overlay (the
 * APK's copy would keep being served), so tools/package-release.mjs withholds the incremental pack for releases that
 * delete payload files at all — those go out as a full installer instead.
 */
public final class OverlayStore {

    /** filesDir/overlay — one directory per build, plus active.json. */
    private static final String DIR = "overlay";
    private static final String ACTIVE = "active.json";
    /** The payload's own 清单, inside the overlay. */
    private static final String MANIFEST = "payload.json";
    /** Inside a delta pack: the files it carries, with the size and sha256 each one must have. */
    private static final String PACK_META = "payload/delta.json";
    private static final String PACK_ROOT = "payload/";
    /** A pack is ~75 MB; these are ceilings, not expectations. */
    private static final long MAX_PACK = 2L * 1024 * 1024 * 1024;
    private static final long MAX_FILE = 512L * 1024 * 1024;
    private static final int BUFFER = 64 * 1024;

    private static OverlayStore shared;

    private final Context context;
    private final File root;
    /** Resolved once per process; apply()/clear()/active() refresh it. */
    private Integer activeBuild;
    private Set<String> activeFiles;

    /** Progress of a long unpack, for the picker's hint line. */
    public interface Progress {
        void onProgress(int done, int total);
    }

    private OverlayStore(Context context) {
        this.context = context.getApplicationContext();
        this.root = new File(this.context.getFilesDir(), DIR);
    }

    /** One instance per process: the overlay is process-wide state, like the WebView that reads it. */
    public static synchronized OverlayStore get(Context context) {
        if (shared == null) shared = new OverlayStore(context);
        return shared;
    }

    /** Build the overlay is at, or 0 when there is none. */
    public int build() {
        JSONObject state = active();
        return state == null ? 0 : state.optInt("build", 0);
    }

    /** The payload version being served: the overlay's when there is one, otherwise the APK's. */
    public String version() {
        JSONObject state = active();
        if (state != null) {
            String version = state.optString("version", "");
            if (!version.isEmpty()) return version;
        }
        return apkString("version");
    }

    /**
     * Build the client is really running: the overlay when there is one, otherwise the APK's own
     * {@code assets/public/build.json}. An incremental update must be based on this — a pack built for another
     * build would leave the client running a mix of two versions.
     */
    public int installedBuild() {
        int overlay = build();
        return overlay > 0 ? overlay : apkInt("build");
    }

    /** Where the overlay files live, or null when there is no active overlay. */
    public File activeDir() {
        int build = build();
        return build > 0 ? new File(root, String.valueOf(build)) : null;
    }

    /** Is {@code rel} a file the overlay replaces? */
    public boolean has(String rel) {
        Set<String> files = activeFileSet();
        return files != null && files.contains(rel);
    }

    /** The overlay file for {@code rel}, or null when the asset copy is the one to serve. */
    public File resolve(String rel) {
        if (rel == null || rel.isEmpty() || !has(rel)) return null;
        File file = new File(activeDir(), rel);
        return file.isFile() ? file : null;
    }

    /** What the client can be told about the overlay (the picker shows it; also the first thing to check in a bug). */
    public JSObject status() {
        Set<String> files = activeFileSet();
        JSObject out = new JSObject();
        out.put("build", build());
        out.put("version", version());
        out.put("installedBuild", installedBuild());
        out.put("apkBuild", apkInt("build"));
        out.put("files", files == null ? 0 : files.size());
        return out;
    }

    /**
     * Unpack a verified delta pack over the current payload and make it live. Throws, with everything as it was, on
     * any mismatch.
     *
     * Read through {@link java.util.zip.ZipFile}, not ZipInputStream: the packs are written by the host's `tar`
     * (bsdtar), which stores each entry's sizes in a *trailing data descriptor* (general purpose flag bit 3). A
     * streaming reader has to scan for that descriptor, while ZipFile reads the central directory, where the sizes
     * and offsets are always real — the same reason this method can look up the pack's own list without unpacking
     * 75 MB first.
     *
     * @param pack     the downloaded {@code delta-<from>-<to>.zip}
     * @param expect   the build the pack must declare as its target (the caller has already checked {@code from})
     * @param progress optional: (files written, files expected)
     * @return how many files the overlay now holds
     */
    public int apply(File pack, int expect, Progress progress) throws IOException, JSONException {
        if (pack == null || !pack.isFile()) throw new IOException("增量包不存在");
        if (pack.length() <= 0 || pack.length() > MAX_PACK) throw new IOException("增量包大小异常，已放弃");
        File staging = new File(root, expect + ".staging");
        String version = "";
        int done;
        try {
            try (ZipFile zip = new ZipFile(pack)) {
                JSONObject meta = packMeta(zip);
                if (meta.optInt("schema") != 1) throw new IOException("增量包格式不认识（schema " + meta.optInt("schema") + "）");
                if (meta.optInt("to") != expect) throw new IOException("增量包不是给 build " + expect + " 的");
                JSONObject files = meta.optJSONObject("files");
                if (files == null || files.length() == 0) throw new IOException("增量包里没有文件清单");
                version = meta.optString("version", "");

                deleteTree(staging);
                if (!staging.mkdirs() && !staging.isDirectory()) throw new IOException("无法创建更新目录");
                done = unpack(zip, files, staging, progress);
                writeManifest(staging, meta, files);
            }
            File target = new File(root, String.valueOf(expect));
            deleteTree(target);
            if (!staging.renameTo(target)) throw new IOException("无法启用更新目录");
            activate(expect, version, done);
            prune(expect);
            return done;
        } catch (IOException | JSONException | RuntimeException e) {
            deleteTree(staging);
            throw e;
        }
    }

    /** Unpack every listed file, verifying size and sha256 as it is written. Returns how many landed. */
    private static int unpack(ZipFile zip, JSONObject files, File staging, Progress progress) throws IOException {
        byte[] buffer = new byte[BUFFER];
        int total = files.length();
        int done = 0;
        for (Enumeration<? extends ZipEntry> entries = zip.entries(); entries.hasMoreElements(); ) {
            ZipEntry entry = entries.nextElement();
            if (entry.isDirectory()) continue;
            String name = entry.getName();
            if (!name.startsWith(PACK_ROOT)) continue;
            String rel = name.substring(PACK_ROOT.length());
            // payload.json is written below from the merged list, never taken from the pack.
            if (PACK_META.equals(name) || MANIFEST.equals(rel)) continue;
            ensureSafe(rel);
            JSONArray want = files.optJSONArray(rel);
            if (want == null || want.length() != 2) throw new IOException("增量包里有清单外的文件：" + rel);
            long expectSize = want.optLong(0, -1);
            String expectHash = want.optString(1, "");
            if (expectSize < 0 || expectSize > MAX_FILE || expectHash.length() != 64) {
                throw new IOException("清单条目不可信：" + rel);
            }
            // The central directory already knows the size: refuse before writing anything when it disagrees.
            if (entry.getSize() >= 0 && entry.getSize() != expectSize) throw new IOException("文件长度不符：" + rel);
            File dest = new File(staging, rel);
            File parent = dest.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                throw new IOException("无法创建目录：" + rel);
            }
            try (InputStream in = zip.getInputStream(entry)) {
                if (copyVerified(in, dest, buffer, expectSize, expectHash, rel) != expectSize) {
                    throw new IOException("文件长度不符：" + rel);
                }
            }
            done++;
            if (progress != null && done % 200 == 0) progress.onProgress(done, total);
        }
        if (done != total) throw new IOException("增量包不完整（清单 " + total + " 个，实际 " + done + " 个）");
        return done;
    }

    /** Drop the overlay; the APK's payload is the truth again. */
    public void clear() {
        deleteTree(root);
        activeBuild = 0;
        activeFiles = null;
    }

    /** Read a stream into a string (the 清单 and the pack's own list are small text files). */
    private static String readText(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[BUFFER];
        for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
        return out.toString("UTF-8");
    }

    /** Copy exactly {@code size} bytes, verifying the sha256 while writing. Returns the bytes written. */
    private static long copyVerified(InputStream in, File dest, byte[] buffer, long size, String hash, String rel) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IOException("SHA-256 不可用");
        }
        long written = 0;
        try (OutputStream out = new FileOutputStream(dest)) {
            while (written < size) {
                int want = (int) Math.min(buffer.length, size - written);
                int n = in.read(buffer, 0, want);
                if (n <= 0) throw new IOException("增量包里 " + rel + " 提前结束");
                out.write(buffer, 0, n);
                digest.update(buffer, 0, n);
                written += n;
            }
        }
        if (!hex(digest.digest()).equalsIgnoreCase(hash)) throw new IOException("文件校验失败：" + rel);
        return written;
    }

    /**
     * The overlay's {@code payload.json}: the manifest of what is served, with this pack's entries replacing the
     * base's. Kept so anything reading the 清单 through the WebView (or the LAN host) sees a list matching the files
     * it can actually fetch — including a future client-side update check.
     */
    private void writeManifest(File staging, JSONObject meta, JSONObject files) throws IOException, JSONException {
        JSONObject base = currentManifest();
        JSONObject merged = base == null ? new JSONObject() : base.optJSONObject("files");
        if (merged == null) merged = new JSONObject();
        for (Iterator<String> it = files.keys(); it.hasNext(); ) {
            String rel = it.next();
            merged.put(rel, files.get(rel));
        }
        JSONObject manifest = new JSONObject();
        manifest.put("schema", meta.optInt("schema", 1));
        manifest.put("version", meta.optString("version", ""));
        manifest.put("build", meta.optInt("to", 0));
        manifest.put("files", merged);
        try (OutputStream out = new FileOutputStream(new File(staging, MANIFEST))) {
            out.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
        }
    }

    /** The 清单 of the payload as it is right now: the overlay's if there is one, otherwise the APK's. */
    private JSONObject currentManifest() {
        File overlay = new File(activeDir(), MANIFEST);
        if (overlay.isFile()) {
            try (InputStream in = new FileInputStream(overlay)) {
                return new JSONObject(readText(in));
            } catch (Exception ignored) {
                // fall through to the APK's copy
            }
        }
        try (InputStream in = context.getAssets().open("public/" + MANIFEST)) {
            return new JSONObject(readText(in));
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * The active overlay's state, or null. Resolved from disk once, then cached for the process — and the moment a
     * *newer* APK shows up, an older overlay is deleted instead of being served (the package's payload has to win).
     */
    private JSONObject active() {
        Integer cached = activeBuild;
        if (cached != null) {
            if (cached == 0) return null;
            return new File(root, String.valueOf(cached)).isDirectory() ? readActive() : null;
        }
        JSONObject state = readActive();
        int build = state == null ? 0 : state.optInt("build", 0);
        if (build > 0 && !new File(root, String.valueOf(build)).isDirectory()) {
            state = null;
            build = 0;
        }
        if (build > 0 && apkInt("build") >= build) {
            deleteTree(new File(root, String.valueOf(build)));
            deleteTree(new File(root, ACTIVE));
            state = null;
            build = 0;
        }
        activeBuild = build;
        return state;
    }

    private JSONObject readActive() {
        File file = new File(root, ACTIVE);
        if (!file.isFile()) return null;
        try (InputStream in = new FileInputStream(file)) {
            return new JSONObject(readText(in));
        } catch (Exception e) {
            return null;
        }
    }

    private void activate(int build, String version, int files) throws IOException {
        File temp = new File(root, ACTIVE + ".tmp");
        JSONObject state = new JSONObject();
        try {
            state.put("build", build);
            state.put("version", version);
            state.put("files", files);
            state.put("at", System.currentTimeMillis());
        } catch (JSONException e) {
            throw new IOException("无法写入更新状态");
        }
        try (OutputStream out = new FileOutputStream(temp)) {
            out.write(state.toString().getBytes(StandardCharsets.UTF_8));
        }
        File target = new File(root, ACTIVE);
        deleteTree(target);
        if (!temp.renameTo(target)) throw new IOException("无法写入更新状态");
        activeBuild = build;
        activeFiles = null;
    }

    /** Keep only the overlay just activated: an older one can never be the right base again. */
    private void prune(int keep) {
        File[] children = root.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (child.isDirectory() && !child.getName().equals(String.valueOf(keep))) deleteTree(child);
        }
    }

    /** The files the overlay replaces — read from disk once, because it is consulted on every request. */
    private Set<String> activeFileSet() {
        if (activeFiles != null) return activeFiles;
        File dir = activeDir();
        if (dir == null) return null;
        Set<String> files = new HashSet<>();
        Deque<File> stack = new ArrayDeque<>();
        stack.push(dir);
        while (!stack.isEmpty()) {
            File[] children = stack.pop().listFiles();
            if (children == null) continue;
            for (File child : children) {
                if (child.isDirectory()) {
                    stack.push(child);
                } else {
                    String rel = relativeTo(dir, child);
                    if (rel != null) files.add(rel);
                }
            }
        }
        activeFiles = files;
        return files;
    }

    private static String relativeTo(File root, File file) {
        String prefix = root.getAbsolutePath() + File.separator;
        String full = file.getAbsolutePath();
        if (!full.startsWith(prefix)) return null;
        return full.substring(prefix.length()).replace(File.separatorChar, '/');
    }

    /** The pack's own list, straight out of the archive's central directory. */
    private static JSONObject packMeta(ZipFile zip) throws IOException, JSONException {
        ZipEntry entry = zip.getEntry(PACK_META);
        if (entry == null) throw new IOException("增量包里没有 " + PACK_META);
        try (InputStream in = zip.getInputStream(entry)) {
            return new JSONObject(readText(in));
        }
    }

    /** No path from a downloaded pack may point outside the overlay. */
    static void ensureSafe(String rel) throws IOException {
        if (rel.isEmpty() || rel.startsWith("/") || rel.contains("\\") || rel.contains("..") || rel.contains(":")) {
            throw new IOException("增量包里的路径不能用：" + rel);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        }
        return out.toString();
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /** A field of the APK payload's own {@code build.json} — 0 / "" when it is missing (a very old build). */
    private int apkInt(String name) {
        JSONObject client = apkClient();
        return client == null ? 0 : client.optInt(name, 0);
    }

    private String apkString(String name) {
        JSONObject client = apkClient();
        return client == null ? "" : client.optString(name, "");
    }

    private JSONObject apkClient() {
        try (InputStream in = context.getAssets().open("public/build.json")) {
            return new JSONObject(readText(in)).optJSONObject("client");
        } catch (Exception e) {
            return null;
        }
    }
}

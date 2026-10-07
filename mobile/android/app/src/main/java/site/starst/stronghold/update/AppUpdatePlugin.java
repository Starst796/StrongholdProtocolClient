package site.starst.stronghold.update;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * In-app updates: read the release feed, download the APK it points at, and hand it to the system installer.
 *
 * The picker (shell/picker.js) drives this; everything a WebView cannot do lives here:
 *
 *  - {@code check}    reads the feed. Its origin is not the page's ({@code https://localhost}), so a renderer fetch
 *                     would be refused by CORS — the same reason the desktop shell reads it in Electron's main
 *                     process rather than in the page.
 *  - {@code download} streams the APK into the cache and verifies the feed's sha256 while writing, so nothing
 *                     unverified reaches the installer and ~200 MB never become a JS string or a byte array.
 *  - {@code install}  opens the system installer for that file through the app's FileProvider.
 *
 * Android never installs silently: the player confirms once in the system dialog. What this plugin adds is that the
 * download is verifiable and that installing is an *update* — the APK is signed with the key the installed app was
 * signed with and carries a higher versionCode (tools/release-meta.mjs), so Android replaces the app in place. That
 * is what keeps the player's localStorage save, which an uninstall would destroy.
 *
 * Only files this plugin downloaded may be installed (the path must be exactly cacheDir/update/&lt;name&gt;): the JS
 * side is not the only thing that can call a plugin method.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    /** Downloads live here — inside the app's own cache, which Android may clear when storage runs low. */
    private static final String DIR = "update";
    /** A feed is a few hundred bytes; stop reading rather than trust the server's Content-Length. */
    private static final int FEED_MAX = 64 * 1024;
    private static final int TIMEOUT_MS = 8000;
    private static final int COPY_BUFFER = 64 * 1024;
    /** Progress is for the picker's hint line, not a progress bar: one event per 2 MB is plenty. */
    private static final long PROGRESS_STEP = 2L * 1024 * 1024;
    private static final String SHA256_HEX = "[0-9a-f]{64}";

    private volatile boolean cancelled;
    private volatile HttpURLConnection downloading;

    @Override
    protected void handleOnDestroy() {
        cancelDownload();
        super.handleOnDestroy();
    }

    /** The update feed (latest.json). Resolves {@code { ok, text }} — failures are reported, never thrown at the page. */
    @PluginMethod
    public void check(PluginCall call) {
        String url = allowed(call.getString("url"));
        if (url == null) {
            call.resolve(new JSObject().put("ok", false).put("error", "不支持的地址"));
            return;
        }
        getBridge().execute(() -> {
            JSObject out = new JSObject();
            HttpURLConnection conn = null;
            try {
                conn = open(url);
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) out.put("ok", false).put("error", "HTTP " + code);
                else out.put("ok", true).put("text", readCapped(conn.getInputStream(), FEED_MAX));
            } catch (Exception e) {
                out.put("ok", false).put("error", message(e));
            } finally {
                if (conn != null) conn.disconnect();
            }
            resolve(call, out);
        });
    }

    /**
     * Download an APK and verify it before it can be installed. Resolves {@code { path, size, sha256 }} on success
     * and {@code { error }} otherwise, emitting {@code progress} events ({@code { received, total }}, total −1 when
     * the server does not say) while it runs.
     */
    @PluginMethod
    public void download(PluginCall call) {
        String url = allowed(call.getString("url"));
        String want = call.getString("sha256");
        String name = call.getString("name");
        if (url == null || want == null || name == null) {
            call.resolve(new JSObject().put("error", "download 需要 url / sha256 / name"));
            return;
        }
        final String expected = want.trim().toLowerCase(Locale.ROOT);
        if (!expected.matches(SHA256_HEX)) {
            call.resolve(new JSObject().put("error", "校验串格式不对"));
            return;
        }
        final File target;
        final File temp;
        try {
            target = new File(downloadDir(), safeName(name));
            temp = new File(target.getParentFile(), target.getName() + ".part");
        } catch (Exception e) {
            call.resolve(new JSObject().put("error", message(e)));
            return;
        }

        cancelled = false;
        getBridge().execute(() -> {
            JSObject out = new JSObject();
            HttpURLConnection conn = null;
            try {
                conn = open(url);
                downloading = conn;
                long total = conn.getContentLengthLong();
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long received = 0;
                long announced = 0;
                try (InputStream in = conn.getInputStream(); FileOutputStream file = new FileOutputStream(temp)) {
                    byte[] buf = new byte[COPY_BUFFER];
                    for (int n; (n = in.read(buf)) > 0; ) {
                        if (cancelled) throw new IOException("cancelled");
                        file.write(buf, 0, n);
                        digest.update(buf, 0, n);
                        received += n;
                        if (received - announced >= PROGRESS_STEP) {
                            announced = received;
                            emitProgress(received, total);
                        }
                    }
                    file.getFD().sync();
                }
                String got = hex(digest.digest());
                if (!got.equals(expected)) {
                    // A truncated or substituted download: delete it rather than offer it to the installer.
                    temp.delete();
                    out.put("error", "下载校验失败（文件可能不完整），请重试。");
                } else if (target.exists() && !target.delete()) {
                    out.put("error", "无法替换上一次的下载，请重试。");
                } else if (!temp.renameTo(target)) {
                    out.put("error", "无法保存下载的文件，请重试。");
                } else {
                    out.put("path", target.getAbsolutePath()).put("size", received).put("sha256", got);
                }
            } catch (Exception e) {
                temp.delete();
                out.put("error", cancelled ? "已取消下载。" : message(e));
            } finally {
                downloading = null;
                if (conn != null) conn.disconnect();
            }
            resolve(call, out);
        });
    }

    /**
     * Open the system installer for a downloaded APK. Resolves {@code { needPermission: true }} when the player has
     * not allowed this app to install packages yet (Android 8+) — the caller then opens the settings screen.
     */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        File file = path == null ? null : new File(path);
        // Only what this plugin downloaded: exactly cacheDir/update/<name>.
        File expected = file == null ? null : new File(downloadDir(), file.getName());
        if (file == null || expected == null || !file.isFile() || !file.getAbsolutePath().equals(expected.getAbsolutePath())) {
            call.resolve(new JSObject().put("error", "安装包不存在或不在下载目录里，请重新下载。"));
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            call.resolve(new JSObject().put("needPermission", true));
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.resolve(new JSObject().put("error", message(e)));
        }
    }

    /** The system screen where the player allows this app to install packages (Android 8+ can only be opened). */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            }
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.resolve(new JSObject().put("error", message(e)));
        }
    }

    /** Abort a download in flight (the page went away, or the player changed their mind). */
    @PluginMethod
    public void cancel(PluginCall call) {
        cancelDownload();
        call.resolve(new JSObject().put("ok", true));
    }

    private void cancelDownload() {
        cancelled = true;
        HttpURLConnection conn = downloading;
        if (conn != null) {
            try {
                conn.disconnect();
            } catch (Exception ignored) {
                // already gone
            }
        }
    }

    /** Where downloads land, created on demand. */
    private File downloadDir() {
        File dir = new File(getContext().getCacheDir(), DIR);
        if (!dir.exists() && !dir.mkdirs() && !dir.exists()) throw new IllegalStateException("无法创建下载目录");
        return dir;
    }

    /** https anywhere; http only against this device (a locally served test feed). Mirrors the picker's rule. */
    private String allowed(String url) {
        String s = url == null ? null : url.trim();
        if (s == null || s.isEmpty()) return null;
        try {
            URL parsed = new URL(s);
            String protocol = parsed.getProtocol();
            if ("https".equals(protocol)) return s;
            if (!"http".equals(protocol)) return null;
            String host = parsed.getHost();
            boolean local = "localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host);
            return local ? s : null;
        } catch (Exception e) {
            return null;
        }
    }

    private HttpURLConnection open(String url) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        // GitHub answers a release asset with a redirect to its CDN; HttpURLConnection follows it (and http → https).
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(TIMEOUT_MS);
        conn.setReadTimeout(TIMEOUT_MS);
        conn.setRequestProperty("Accept", "application/json, application/octet-stream, */*");
        return conn;
    }

    /** The first `max` bytes of a stream as text — a feed is small, and an endless answer is not a feed. */
    private String readCapped(InputStream in, int max) throws IOException {
        try (InputStream stream = in) {
            byte[] buf = new byte[8 * 1024];
            StringBuilder out = new StringBuilder();
            int left = max;
            for (int n; left > 0 && (n = stream.read(buf, 0, Math.min(buf.length, left))) > 0; ) {
                out.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                left -= n;
            }
            return out.toString();
        }
    }

    /** Keep an untrusted asset name inside the download directory. */
    private String safeName(String name) {
        String cleaned = new File(String.valueOf(name)).getName().replaceAll("[^A-Za-z0-9._-]", "_");
        return cleaned.isEmpty() || ".".equals(cleaned) || "..".equals(cleaned) ? "update.apk" : cleaned;
    }

    private void emitProgress(long received, long total) {
        JSObject event = new JSObject().put("received", received).put("total", total);
        // Capacitor's listener list is not thread-safe: events are delivered on the main thread, like the host's.
        getBridge().executeOnMainThread(() -> notifyListeners("progress", event));
    }

    /** Capacitor wants a PluginCall resolved on the main thread. */
    private void resolve(PluginCall call, JSObject out) {
        getBridge().executeOnMainThread(() -> call.resolve(out));
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format("%02x", b));
        return out.toString();
    }

    private static String message(Exception e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }
}

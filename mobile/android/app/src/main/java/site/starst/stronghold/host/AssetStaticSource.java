package site.starst.stronghold.host;

import android.content.res.AssetManager;

import java.io.IOException;
import java.io.InputStream;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Payload source over the APK's own assets — the phone-side counterpart of the desktop host serving
 * resources/www from disk. Nothing is copied out of the APK: a LAN guest reads the very files the WebView runs, so
 * hosting costs no extra device storage.
 *
 * The APK keeps most assets compressed, so {@code openFd()} usually fails on them. {@link #length} therefore answers
 * -1 for those files and {@link MiniHostServer} then ends the response by closing the connection (a legitimate HTTP/1.1
 * answer) instead of sending a wrong Content-Length.
 */
final class AssetStaticSource implements StaticSource {

    private final AssetManager assets;
    private final String prefix;
    /** Asset lookups are the hot path (every request); assets never change while the app runs, so cache them. */
    private final Map<String, Boolean> dirs = new ConcurrentHashMap<>();
    private final Map<String, Boolean> files = new ConcurrentHashMap<>();

    /**
     * @param assets   the app's asset manager
     * @param prefix   directory inside the assets holding the payload root (Capacitor: {@code public})
     */
    AssetStaticSource(AssetManager assets, String prefix) {
        this.assets = assets;
        this.prefix = prefix == null || prefix.isEmpty() ? "" : (prefix.endsWith("/") ? prefix : prefix + "/");
    }

    private String path(String rel) {
        return prefix + rel;
    }

    @Override
    public boolean exists(String rel) {
        if (rel.isEmpty()) return true; // the payload root is the assets prefix itself
        return isDirectory(rel) || isFile(rel);
    }

    @Override
    public boolean isDirectory(String rel) {
        return dirs.computeIfAbsent(rel, (key) -> {
            try {
                String[] children = assets.list(path(key));
                return children != null && children.length > 0;
            } catch (IOException e) {
                return false;
            }
        });
    }

    private boolean isFile(String rel) {
        return files.computeIfAbsent(rel, (key) -> {
            InputStream in = null;
            try {
                in = assets.open(path(key));
                return true;
            } catch (IOException e) {
                return false;
            } finally {
                closeQuietly(in);
            }
        });
    }

    @Override
    public long length(String rel) {
        // openFd() reports the real length but only works for stored (uncompressed) assets.
        try (android.content.res.AssetFileDescriptor afd = assets.openFd(path(rel))) {
            return afd.getLength();
        } catch (IOException e) {
            return -1;
        }
    }

    @Override
    public InputStream open(String rel) throws IOException {
        return assets.open(path(rel));
    }

    private static void closeQuietly(InputStream in) {
        if (in == null) return;
        try {
            in.close();
        } catch (IOException ignored) {
            // nothing to do
        }
    }
}

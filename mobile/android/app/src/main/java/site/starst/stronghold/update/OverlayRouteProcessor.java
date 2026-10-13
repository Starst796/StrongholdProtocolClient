package site.starst.stronghold.update;

import android.content.Context;

import com.getcapacitor.ProcessedRoute;
import com.getcapacitor.RouteProcessor;

import java.io.File;
import java.io.IOException;

/**
 * The seam that lets an incremental update reach the WebView.
 *
 * Capacitor serves the client's payload out of the APK ({@code https://localhost/...} → {@code assets/public/...}),
 * and it asks a {@link RouteProcessor} about every request before it opens anything. Returning a path with
 * {@code asset = false} makes it read that file from the filesystem instead — and its file handler is a plain
 * {@code new FileInputStream(new File(path))}, so an absolute path into the overlay works. That is the whole trick:
 * no Capacitor fork, no reflection, no copied-out payload.
 *
 * A miss returns the request's own path and {@code asset = true} — byte-for-byte the behaviour without a processor,
 * which is what keeps the 500 MB of unchanged files coming out of the APK.
 *
 * The {@code basePath} argument is Capacitor's, and it differs between the two call sites: the per-request handler
 * passes {@code ""} and then prefixes the asset path itself, while the directory request passes the payload's asset
 * directory and does *not* prefix. Both are answered the way Capacitor expects, which is why the asset path here is
 * {@code basePath + path} rather than just {@code path}.
 *
 * Installed in MainActivity before the first navigation (see {@code load()}); {@code test/overlay.test.js} pins that,
 * and pins the Capacitor internals this depends on so an upgrade that changes them fails the build rather than
 * white-screening an installed app.
 */
public final class OverlayRouteProcessor implements RouteProcessor {

    private final OverlayStore store;

    public OverlayRouteProcessor(Context context) {
        this.store = OverlayStore.get(context);
    }

    @Override
    public ProcessedRoute process(String basePath, String path) {
        ProcessedRoute route = new ProcessedRoute();
        String rel = relative(path);
        route.setAsset(true);
        route.setPath(assetPath(basePath, path));
        if (rel != null) {
            File file = overlay(rel);
            if (file != null) {
                route.setPath(file.getAbsolutePath());
                route.setAsset(false);
            }
        }
        return route;
    }

    /** The overlay's copy of a payload path, or null when the assets should serve it. */
    private File overlay(String rel) {
        try {
            OverlayStore.ensureSafe(rel);
        } catch (IOException e) {
            return null; // not a payload path at all: leave it to Capacitor
        }
        return store.resolve(rel);
    }

    /** {@code "/js/main.js"} → {@code "js/main.js"}; null when the path is not one (a query, a fragment, a blank). */
    private static String relative(String path) {
        if (path == null) return null;
        String rel = path;
        while (rel.startsWith("/")) rel = rel.substring(1);
        return rel.isEmpty() ? null : rel;
    }

    /**
     * What Capacitor should hand to its asset reader. With a base path (the directory request) the asset path is
     * base + path, because that call site does not add it; without one the path alone is expected.
     */
    private static String assetPath(String basePath, String path) {
        String clean = path == null ? "/" : path;
        String base = basePath == null ? "" : basePath;
        if (base.isEmpty()) return clean;
        return base.endsWith("/") ? base + (clean.startsWith("/") ? clean.substring(1) : clean) : base + clean;
    }
}

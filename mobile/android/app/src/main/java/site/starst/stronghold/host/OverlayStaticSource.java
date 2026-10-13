package site.starst.stronghold.host;

import java.io.IOException;
import java.io.InputStream;

/**
 * The LAN host's view of an incremental update: whatever the overlay replaces is read from the device, everything
 * else still comes straight out of the APK.
 *
 * The host serves the same payload the WebView runs, so it must see the same files. Without this, a guest would get
 * the old code while the host's own page ran the new one — the two sides of a match would disagree about the game.
 *
 * With no overlay active this is just the wrapped source (no extra lookups beyond one directory test).
 */
public final class OverlayStaticSource implements StaticSource {

    private final DirStaticSource overlay;
    private final StaticSource base;

    /**
     * @param overlay the active overlay directory, or null when there is none
     * @param base    the source to fall back to (the APK's assets)
     */
    public OverlayStaticSource(DirStaticSource overlay, StaticSource base) {
        this.overlay = overlay;
        this.base = base;
    }

    /** True when the overlay really holds a file at {@code rel} (a directory there does not shadow the assets). */
    private boolean overlayFile(String rel) {
        return overlay != null && overlay.exists(rel) && !overlay.isDirectory(rel);
    }

    @Override
    public boolean exists(String rel) {
        return overlayFile(rel) || base.exists(rel);
    }

    @Override
    public boolean isDirectory(String rel) {
        // A directory the overlay contributes is new (the pack never ships empty directories that the APK lacks),
        // so an overlay directory wins; otherwise the assets answer.
        return overlay != null && !overlayFile(rel) && overlay.isDirectory(rel) ? true : base.isDirectory(rel);
    }

    @Override
    public long length(String rel) {
        return overlayFile(rel) ? overlay.length(rel) : base.length(rel);
    }

    @Override
    public InputStream open(String rel) throws IOException {
        return overlayFile(rel) ? overlay.open(rel) : base.open(rel);
    }
}

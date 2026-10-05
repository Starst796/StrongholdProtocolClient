package site.starst.stronghold.host;

import java.io.IOException;
import java.io.InputStream;

/**
 * Where the LAN host reads the game payload from. Two implementations:
 *
 *   * {@link DirStaticSource} — a real directory (used by the JVM tests and any filesystem root);
 *   * the Android plugin's asset-backed one — reads straight out of the APK's {@code assets/public}, so hosting
 *     costs **no extra device storage** (nothing is copied out of the APK).
 *
 * Paths are relative and use '/' (e.g. {@code "index.html"}, {@code "js/main.js"}); no leading slash.
 */
public interface StaticSource {
    /** Is there a file (or directory) at {@code rel}? */
    boolean exists(String rel);

    /** Is {@code rel} a directory (or the empty root)? Directory requests resolve to its index.html. */
    boolean isDirectory(String rel);

    /** Size in bytes, or -1 when unknown (a compressed APK asset): the response is then closed-delimited. */
    long length(String rel);

    /** Open {@code rel} for reading. Throws when it is not a readable file. */
    InputStream open(String rel) throws IOException;
}

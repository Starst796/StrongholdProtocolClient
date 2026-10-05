package site.starst.stronghold.host;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/** A {@link StaticSource} over a real directory (JVM tests; a filesystem root). */
public final class DirStaticSource implements StaticSource {
    private final Path root;

    public DirStaticSource(Path root) {
        this.root = root.toAbsolutePath().normalize();
    }

    private Path resolve(String rel) {
        Path p = root.resolve(rel).normalize();
        return p.startsWith(root) ? p : null; // never escape the root
    }

    @Override
    public boolean exists(String rel) {
        Path p = resolve(rel);
        return p != null && Files.exists(p);
    }

    @Override
    public boolean isDirectory(String rel) {
        Path p = resolve(rel.isEmpty() ? "." : rel);
        return p != null && Files.isDirectory(p);
    }

    @Override
    public long length(String rel) {
        Path p = resolve(rel);
        try {
            return p != null && Files.isRegularFile(p) ? Files.size(p) : -1;
        } catch (IOException e) {
            return -1;
        }
    }

    @Override
    public InputStream open(String rel) throws IOException {
        Path p = resolve(rel);
        if (p == null) throw new IOException("outside root");
        return Files.newInputStream(p);
    }
}

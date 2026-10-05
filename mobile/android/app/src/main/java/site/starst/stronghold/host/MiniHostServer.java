package site.starst.stronghold.host;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The phone-side game host: one TCP port serving both the static game payload (so a LAN peer can just open
 * {@code http://<phone-ip>:<port>} in a browser) and the game's WebSocket at {@code /ws}.
 *
 * Pure Java on purpose (no Android APIs): the transport can be compiled and driven on a desktop JVM with a real
 * WebSocket client, and the Android side only supplies a {@link StaticSource} over the APK assets. The game logic
 * itself is NOT here — the WebView runs the payload's own server modules (server/net.js + lobby.js + match/…) and
 * this class only ferries frames to and from them through the Capacitor bridge.
 *
 * The WebSocket part implements the small RFC 6455 subset a browser/`ws` client needs: the handshake, text frames
 * (with continuation), ping/pong and close. Binary frames are refused (the game only speaks JSON text).
 */
public final class MiniHostServer implements Closeable {

    /** Callbacks fired on the server's own threads; implementations must not block for long. */
    public interface Listener {
        void onOpen(int id, String peer);

        void onMessage(int id, String text);

        /** A pong answered one of our pings (Network's heartbeat in the WebView watches for it). */
        void onPong(int id);

        void onClose(int id);
    }

    /** The JSON a LAN guest's page gets at /js/runtime-config.js: play on this host, skip the shell picker. */
    public static final String LAN_RUNTIME_CONFIG =
        "// Served by the Android LAN host — the guest plays on this server (its own origin).\n"
            + "globalThis.__SP_SERVER__ = '';\n"
            + "globalThis.__SP_OFFLINE__ = false;\n"
            + "globalThis.__SP_LAN_CLIENT__ = true;\n";

    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int MAX_HEADER_BYTES = 16 * 1024;
    private static final int MAX_PAYLOAD = 1 << 20;
    private static final int FIRST_REQUEST_TIMEOUT_MS = 30_000;
    private static final int KEEP_ALIVE_TIMEOUT_MS = 15_000;
    private static final byte[] CRLF = { '\r', '\n' };
    private static final byte[] LAST_CHUNK = { '0', '\r', '\n', '\r', '\n' };

    /** Extension → Content-Type (mirrors desktop/serve.mjs and the game server's table). */
    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("htm", "text/html; charset=utf-8");
        MIME.put("js", "text/javascript; charset=utf-8");
        MIME.put("mjs", "text/javascript; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("map", "application/json; charset=utf-8");
        MIME.put("webmanifest", "application/manifest+json; charset=utf-8");
        MIME.put("txt", "text/plain; charset=utf-8");
        MIME.put("md", "text/markdown; charset=utf-8");
        MIME.put("csv", "text/csv; charset=utf-8");
        MIME.put("xml", "application/xml; charset=utf-8");
        MIME.put("atlas", "text/plain; charset=utf-8");
        MIME.put("skel", "application/octet-stream");
        MIME.put("bin", "application/octet-stream");
        MIME.put("wasm", "application/wasm");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("gif", "image/gif");
        MIME.put("webp", "image/webp");
        MIME.put("avif", "image/avif");
        MIME.put("svg", "image/svg+xml; charset=utf-8");
        MIME.put("ico", "image/x-icon");
        MIME.put("mp3", "audio/mpeg");
        MIME.put("ogg", "audio/ogg");
        MIME.put("oga", "audio/ogg");
        MIME.put("opus", "audio/ogg");
        MIME.put("wav", "audio/wav");
        MIME.put("m4a", "audio/mp4");
        MIME.put("aac", "audio/aac");
        MIME.put("webm", "video/webm");
        MIME.put("mp4", "video/mp4");
        MIME.put("woff2", "font/woff2");
        MIME.put("woff", "font/woff");
        MIME.put("otf", "font/otf");
        MIME.put("ttf", "font/ttf");
    }

    private final StaticSource files;
    private final Listener listener;
    private final int requestedPort;
    private final int portSearch;

    /** `portSearch` value that binds only {@code requestedPort} (or 0 for the OS) and fails when it is taken. */
    public static final int STRICT = 0;

    private final AtomicInteger nextId = new AtomicInteger(1);
    private final Map<Integer, Ws> conns = new ConcurrentHashMap<>();
    /** Every connection currently being served (WebSocket or static), so a stop can drop them immediately. */
    private final java.util.Set<Socket> sockets = ConcurrentHashMap.newKeySet();
    private volatile boolean running = false;
    private ServerSocket server;
    private Thread acceptor;

    /**
     * @param files         payload source (assets on Android, a directory in tests)
     * @param listener      frame callbacks
     * @param port          preferred port (hosting uses 47822); 0 = let the OS pick
     * @param portSearch    how many consecutive ports to try before falling back to 0; {@link #STRICT} binds only
     *                      `port` (the player asked for that exact one — a busy port is reported, not worked around)
     */
    public MiniHostServer(StaticSource files, Listener listener, int port, int portSearch) {
        this.files = files;
        this.listener = listener;
        this.requestedPort = port;
        // STRICT means "only this port": keep it as 0 rather than clamping it up to 1.
        this.portSearch = portSearch <= STRICT ? STRICT : portSearch;
    }

    /** Bind and start accepting. @return the actual port */
    public synchronized int start() throws IOException {
        if (running) return server.getLocalPort();
        IOException last = null;
        int[] candidates = candidates();
        for (int p : candidates) {
            try {
                ServerSocket s = new ServerSocket();
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress(p), 64);
                server = s;
                last = null;
                break;
            } catch (IOException e) {
                last = e;
                // The OS-assigned candidate is the last resort; STRICT has no next candidate at all.
                if (p == 0 || portSearch == STRICT) throw e;
            }
        }
        if (server == null) throw last != null ? last : new IOException("no port");
        running = true;
        acceptor = new Thread(this::acceptLoop, "sp-host-accept");
        acceptor.setDaemon(true);
        acceptor.start();
        return server.getLocalPort();
    }

    private int[] candidates() {
        if (requestedPort <= 0) return new int[] { 0 };
        // STRICT: the one port the player asked for — a busy port is reported, never swapped for another one.
        if (portSearch == STRICT) return new int[] { requestedPort };
        List<Integer> out = new ArrayList<>();
        for (int i = 0; i < portSearch && requestedPort + i <= 65535; i++) out.add(requestedPort + i);
        out.add(0); // last resort: let the OS choose
        int[] arr = new int[out.size()];
        for (int i = 0; i < arr.length; i++) arr[i] = out.get(i);
        return arr;
    }

    public int port() {
        ServerSocket s = server;
        return s == null ? 0 : s.getLocalPort();
    }

    public boolean isRunning() {
        return running;
    }

    /** Send a text frame to a live connection; returns false when it is gone. */
    public boolean send(int id, String text) {
        Ws ws = conns.get(id);
        if (ws == null) return false;
        return ws.sendText(text);
    }

    /** Ping a connection (the game's Network heartbeat asks for this); returns false when it is gone. */
    public boolean ping(int id) {
        Ws ws = conns.get(id);
        if (ws == null) return false;
        return ws.sendPing();
    }

    /** Close one connection (the browser client asked for it, or the game dropped the session). */
    public void closeConn(int id) {
        Ws ws = conns.get(id);
        if (ws != null) ws.closeQuietly();
    }

    /**
     * Drop every live WebSocket connection. The page that drove the game logic is going away (a reload, or the app
     * closing), so the guests it was serving must be told the session ended instead of having their frames vanish.
     */
    public void closeConnections() {
        for (Ws ws : new ArrayList<>(conns.values())) ws.closeQuietly();
    }

    /** LAN IPv4 addresses of this machine (for the "share this address" line). */
    public static List<String> lanAddresses() {
        List<String> found = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (ni.isLoopback() || !ni.isUp()) continue;
                for (InetAddress addr : Collections.list(ni.getInetAddresses())) {
                    if (addr instanceof java.net.Inet4Address && !addr.isLoopbackAddress()) found.add(addr.getHostAddress());
                }
            }
        } catch (Exception ignored) {
            // no addresses is a valid answer
        }
        return privateFirst(found);
    }

    /**
     * A phone has several addresses at once (Wi-Fi, cellular, a VPN) and the picker shows the first one, so order
     * them the way a LAN peer would reach them: the usual home/office ranges first, carrier-grade NAT and anything
     * else after. Stable within a rank, so what the system listed first stays first.
     */
    static List<String> privateFirst(List<String> addresses) {
        List<String> out = new ArrayList<>(addresses);
        out.sort((a, b) -> Integer.compare(rank(a), rank(b))); // List.sort is stable
        return out;
    }

    private static int rank(String ip) {
        if (ip.startsWith("192.168.")) return 0;
        if (ip.startsWith("10.")) return 1;
        if (ip.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*")) return 2;
        if (ip.matches("^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\..*")) return 3; // CGNAT (Tailscale and friends)
        return 4;
    }

    private void acceptLoop() {
        while (running) {
            Socket socket;
            try {
                socket = server.accept();
            } catch (IOException e) {
                if (running) continue; // transient; stopped sockets throw on purpose
                break;
            }
            Thread t = new Thread(() -> handle(socket), "sp-host-conn");
            t.setDaemon(true);
            t.start();
        }
    }

    /**
     * One connection: serve requests until the peer goes away, or upgrade to WebSocket. Requests are read in a
     * loop so browsers keep reusing one TCP connection for the whole payload (the game pulls a lot of small files).
     */
    private void handle(Socket socket) {
        int id = -1;
        try {
            sockets.add(socket);
            if (!running) return; // a stop raced with the accept
            socket.setTcpNoDelay(true);
            socket.setSoTimeout(FIRST_REQUEST_TIMEOUT_MS);
            InputStream in = new BufferedInputStream(socket.getInputStream(), 16 * 1024);
            OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 32 * 1024);
            while (true) {
                byte[] head = readHead(in);
                if (head == null) return;
                if (!running) return; // stopping: do not serve the rest of a keep-alive connection
                String[] lines = new String(head, StandardCharsets.ISO_8859_1).split("\r\n");
                String[] requestLine = lines[0].split(" ");
                if (requestLine.length < 2) return;
                String method = requestLine[0].toUpperCase(Locale.ROOT);
                String path = requestLine[1];
                Map<String, String> headers = new HashMap<>();
                for (int i = 1; i < lines.length; i++) {
                    int c = lines[i].indexOf(':');
                    if (c > 0) headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
                }

                if ("websocket".equalsIgnoreCase(headers.getOrDefault("upgrade", "")) && pathEquals(path, "/ws")) {
                    id = nextId.getAndIncrement();
                    socket.setSoTimeout(0); // a game session may sit idle for a long time
                    Ws ws = new Ws(id, socket, in, out, headers);
                    conns.put(id, ws);
                    // getHostAddress(), not the address object: toString() prefixes a resolved hostname ("phone/192.168.1.7").
                    listener.onOpen(id, socket.getInetAddress().getHostAddress());
                    ws.handshakeAndPump();
                    return;
                }

                boolean clientWantsClose = !"HTTP/1.1".equals(requestLine.length > 2 ? requestLine[2] : "")
                    || headers.getOrDefault("connection", "").toLowerCase(Locale.ROOT).contains("close");
                if (!serveStatic(out, method, path, clientWantsClose, "HTTP/1.1".equals(requestLine.length > 2 ? requestLine[2] : ""))) return;
                socket.setSoTimeout(KEEP_ALIVE_TIMEOUT_MS);
            }
        } catch (Exception e) {
            // a broken/aborted connection is normal on a LAN; just drop it
        } finally {
            sockets.remove(socket);
            if (id != -1) {
                conns.remove(id);
                listener.onClose(id);
            }
            try {
                socket.close();
            } catch (IOException ignored) {
                // already closed
            }
        }
    }

    private static boolean pathEquals(String raw, String want) {
        String p = raw;
        int q = p.indexOf('?');
        if (q >= 0) p = p.substring(0, q);
        return p.equalsIgnoreCase(want);
    }

    /** Read up to and including the blank line; null when the peer sent nothing (or an oversized head). */
    private static byte[] readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(1024);
        int state = 0; // matched \r\n\r\n progress
        int b;
        while ((b = in.read()) != -1) {
            buf.write(b);
            if ((state == 0 || state == 2) && b == '\r') state++;
            else if ((state == 1 || state == 3) && b == '\n') state++;
            else state = b == '\r' ? 1 : 0;
            if (state == 4) return buf.toByteArray();
            if (buf.size() > MAX_HEADER_BYTES) return null;
        }
        return null;
    }

    // ---------------------------------------------------------------------------------------------
    // Static files
    // ---------------------------------------------------------------------------------------------

    /** Answer one static request. @return true when the connection may be reused for another request */
    private boolean serveStatic(OutputStream out, String method, String rawPath, boolean clientWantsClose, boolean http11) throws IOException {
        boolean reuse = !clientWantsClose;
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            writeSimple(out, 405, "text/plain; charset=utf-8", "method not allowed", "GET, HEAD", "HEAD".equals(method), reuse);
            return reuse;
        }
        String path = rawPath;
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        try {
            path = java.net.URLDecoder.decode(path, "UTF-8");
        } catch (Exception e) {
            writeSimple(out, 400, "text/plain; charset=utf-8", "bad request", null, false, false);
            return false;
        }

        // The LAN guest's runtime config: play on this host, skip the picker (see the desktop equivalent).
        if (path.equals("/js/runtime-config.js")) {
            byte[] body = LAN_RUNTIME_CONFIG.getBytes(StandardCharsets.UTF_8);
            byte[] head = responseHead(200, "text/javascript; charset=utf-8", "no-store", body.length, reuse, false).getBytes(StandardCharsets.ISO_8859_1);
            out.write(head);
            if (!"HEAD".equals(method)) out.write(body);
            out.flush();
            return reuse;
        }

        String rel = sanitize(path);
        if (rel == null) {
            writeSimple(out, 403, "text/plain; charset=utf-8", "forbidden", null, "HEAD".equals(method), reuse);
            return reuse;
        }
        if (rel.isEmpty() || files.isDirectory(rel)) rel = rel.isEmpty() ? "index.html" : rel + "/index.html";
        if (!files.exists(rel) || files.isDirectory(rel)) {
            writeSimple(out, 404, "text/plain; charset=utf-8", "not found", null, "HEAD".equals(method), reuse);
            return reuse;
        }

        long len = files.length(rel);
        String type = contentType(rel);
        // A source that cannot tell the length (compressed APK assets) is framed per chunk: the body still ends
        // explicitly, so the connection stays usable and no client has to guess by watching for a close. HTTP/1.0
        // peers (which have no chunked encoding) get the close-delimited form instead.
        boolean chunked = len < 0 && http11;
        boolean keepAlive = reuse && (len >= 0 || chunked);
        byte[] head = responseHead(200, type, cacheControl(rel), len, keepAlive, chunked).getBytes(StandardCharsets.ISO_8859_1);
        out.write(head);
        if (!"HEAD".equals(method)) {
            try (InputStream body = files.open(rel)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = body.read(buf)) != -1) {
                    if (chunked) out.write((Integer.toHexString(n) + "\r\n").getBytes(StandardCharsets.ISO_8859_1));
                    out.write(buf, 0, n);
                    if (chunked) out.write(CRLF);
                }
            }
            if (chunked) out.write(LAST_CHUNK);
        }
        out.flush();
        return keepAlive;
    }

    /** Strip the query, reject traversal/dotfiles, and return the payload-relative path ('' for the root). */
    private static String sanitize(String path) {
        if (!path.startsWith("/")) return null;
        String[] parts = path.split("/");
        List<String> keep = new ArrayList<>();
        for (String p : parts) {
            if (p.isEmpty()) continue;
            if (p.equals("..") || p.equals(".") || p.startsWith(".")) return null;
            keep.add(p);
        }
        return String.join("/", keep);
    }

    private static String contentType(String rel) {
        int dot = rel.lastIndexOf('.');
        String ext = dot < 0 ? "" : rel.substring(dot + 1).toLowerCase(Locale.ROOT);
        return MIME.getOrDefault(ext, "application/octet-stream");
    }

    private static String cacheControl(String rel) {
        if (rel.endsWith(".html") || rel.endsWith(".htm")) return "no-cache";
        if (rel.startsWith("assets/") || rel.startsWith("fonts/") || rel.startsWith("vendor/")) return "public, max-age=86400";
        return "no-cache";
    }

    private static String responseHead(int status, String type, String cache, long length, boolean keepAlive, boolean chunked) {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(status).append(status == 200 ? " OK" : status == 403 ? " Forbidden" : status == 404 ? " Not Found" : status == 405 ? " Method Not Allowed" : "").append("\r\n");
        sb.append("Content-Type: ").append(type).append("\r\n");
        if (cache != null) sb.append("Cache-Control: ").append(cache).append("\r\n");
        if (chunked) sb.append("Transfer-Encoding: chunked\r\n");
        else if (length >= 0) sb.append("Content-Length: ").append(length).append("\r\n");
        sb.append("X-Content-Type-Options: nosniff\r\n");
        if (!keepAlive) sb.append("Connection: close\r\n");
        sb.append("\r\n");
        return sb.toString();
    }

    private static void writeSimple(OutputStream out, int status, String type, String body, String allow, boolean head, boolean keepAlive) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(status).append("\r\n");
        if (allow != null) sb.append("Allow: ").append(allow).append("\r\n");
        sb.append("Content-Type: ").append(type).append("\r\n");
        if (!keepAlive) sb.append("Connection: close\r\n");
        sb.append("Content-Length: ").append(bytes.length).append("\r\n\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
        if (!head) out.write(bytes);
        out.flush();
    }

    @Override
    public void close() {
        running = false;
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
            // ignore
        }
        // Drop what is already connected: a stop must not leave sockets behind (the desktop host does the same with
        // closeAllConnections) — keep-alive HTTP connections would otherwise keep serving the payload.
        for (Socket s : new ArrayList<>(sockets)) {
            try {
                s.close();
            } catch (IOException ignored) {
                // already closed
            }
        }
        closeConnections();
        conns.clear();
    }

    // ---------------------------------------------------------------------------------------------
    // WebSocket
    // ---------------------------------------------------------------------------------------------

    /** One upgraded connection. Reads frames on the calling thread and writes under {@code this}. */
    private final class Ws {
        private final int id;
        private final Socket socket;
        private final InputStream in;
        private final OutputStream out;
        private volatile boolean open;
        private final ByteArrayOutputStream fragment = new ByteArrayOutputStream(4096);
        private int fragmentOpcode = -1;

        Ws(int id, Socket socket, InputStream in, OutputStream out, Map<String, String> headers) throws IOException {
            this.id = id;
            this.socket = socket;
            this.in = in;
            this.out = out;
            String key = headers.get("sec-websocket-key");
            if (key == null || key.isEmpty()) throw new IOException("no sec-websocket-key");
            String accept;
            try {
                MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
                accept = Base64.getEncoder().encodeToString(sha1.digest((key + WS_GUID).getBytes(StandardCharsets.ISO_8859_1)));
            } catch (Exception e) {
                throw new IOException("sha1 unavailable", e);
            }
            String response = "HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
            synchronized (this) {
                out.write(response.getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
            }
            open = true;
        }

        void handshakeAndPump() throws IOException {
            while (open && running) {
                if (!readFrame()) break;
            }
        }

        /** @return false when the connection ended */
        private boolean readFrame() throws IOException {
            int b0 = in.read();
            if (b0 == -1) return false;
            int b1 = in.read();
            if (b1 == -1) return false;
            boolean fin = (b0 & 0x80) != 0;
            int opcode = b0 & 0x0F;
            boolean masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7F;
            if (len == 126) {
                len = ((long) readByte() << 8) | readByte();
            } else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | readByte();
            }
            if (len < 0 || len > MAX_PAYLOAD) return false;
            if (!masked) {
                // RFC 6455: a client frame must be masked; browsers always do.
                sendFrame(0x8, new byte[] { 0x03, (byte) 0xEA }); // 1002 protocol error
                return false;
            }
            byte[] mask = new byte[4];
            readFully(mask, 4);
            byte[] payload = new byte[(int) len];
            readFully(payload, payload.length);
            for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

            switch (opcode) {
                case 0x1: // text
                case 0x0: // continuation
                    if (opcode == 0x1 && !fin) {
                        fragment.reset();
                        fragmentOpcode = 0x1;
                    } else if (opcode == 0x0 && fragmentOpcode != 0x1) {
                        return false; // continuation with nothing to continue
                    }
                    if (fragmentOpcode == 0x1 && !fin) {
                        fragment.write(payload);
                        return true;
                    }
                    String text = fragmentOpcode == 0x1 ? new String(concat(fragment.toByteArray(), payload), StandardCharsets.UTF_8) : new String(payload, StandardCharsets.UTF_8);
                    fragment.reset();
                    fragmentOpcode = -1;
                    listener.onMessage(id, text);
                    return true;
                case 0x8: // close
                    sendFrame(0x8, payload);
                    return false;
                case 0x9: // ping
                    sendFrame(0xA, payload);
                    return true;
                case 0xA: // pong
                    listener.onPong(id);
                    return true;
                default: // binary / reserved
                    sendFrame(0x8, new byte[] { 0x03, (byte) 0xEB }); // 1003 unsupported data
                    return false;
            }
        }

        private byte[] concat(byte[] a, byte[] b) {
            byte[] out = new byte[a.length + b.length];
            System.arraycopy(a, 0, out, 0, a.length);
            System.arraycopy(b, 0, out, a.length, b.length);
            return out;
        }

        private int readByte() throws IOException {
            int b = in.read();
            if (b == -1) throw new EOFException();
            return b;
        }

        private void readFully(byte[] buf, int n) throws IOException {
            int off = 0;
            while (off < n) {
                int r = in.read(buf, off, n - off);
                if (r == -1) throw new EOFException();
                off += r;
            }
        }

        boolean sendText(String text) {
            try {
                sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8));
                return true;
            } catch (IOException e) {
                closeQuietly();
                return false;
            }
        }

        boolean sendPing() {
            try {
                sendFrame(0x9, new byte[0]);
                return true;
            } catch (IOException e) {
                closeQuietly();
                return false;
            }
        }

        private synchronized void sendFrame(int opcode, byte[] payload) throws IOException {
            if (!open) return;
            ByteArrayOutputStream f = new ByteArrayOutputStream(payload.length + 10);
            f.write(0x80 | opcode);
            if (payload.length < 126) {
                f.write(payload.length);
            } else if (payload.length <= 0xFFFF) {
                f.write(126);
                f.write((payload.length >> 8) & 0xFF);
                f.write(payload.length & 0xFF);
            } else {
                f.write(127);
                long n = payload.length;
                for (int i = 7; i >= 0; i--) f.write((int) ((n >> (8 * i)) & 0xFF));
            }
            f.write(payload, 0, payload.length);
            out.write(f.toByteArray());
            out.flush();
        }

        void closeQuietly() {
            if (!open) return;
            try {
                sendFrame(0x8, new byte[0]); // sendFrame needs open == true
            } catch (IOException ignored) {
                // peer already gone
            }
            open = false;
            try {
                socket.close();
            } catch (IOException ignored) {
                // already closed
            }
        }
    }
}

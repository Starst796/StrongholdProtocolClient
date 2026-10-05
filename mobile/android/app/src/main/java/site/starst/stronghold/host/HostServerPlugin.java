package site.starst.stronghold.host;

import android.content.res.AssetManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;

/**
 * The bridge between the phone's LAN server and the game logic.
 *
 * {@link MiniHostServer} owns the sockets (one port: the payload served statically + the game's WebSocket), while
 * the game's server modules (server/net.js + server/lobby.js + match/…) run in the WebView, exactly as they do for
 * offline single-player. This plugin is the wire in between:
 *
 *  - native → JS: {@code open} / {@code frame} / {@code pong} / {@code close} events, one per socket
 *  - JS → native: {@code send} / {@code ping} / {@code closeConn}, addressed by the socket id from the event
 *
 * So the WebView drives every connection (its own client included) through the real transport, and no game logic is
 * duplicated in Java. Events are delivered on the main thread because Capacitor's listener list is not thread-safe
 * and the server's callbacks run on their own connection threads.
 */
@CapacitorPlugin(name = "HostServer")
public class HostServerPlugin extends Plugin {

    private static final int PORT_SEARCH = 16;

    private MiniHostServer server;

    @Override
    protected void handleOnDestroy() {
        stopServer();
        super.handleOnDestroy();
    }

    /**
     * Open the LAN listener. `port` comes from the picker's port field: 0/absent = let the OS pick, a number = that
     * exact port (a busy one is reported back, never silently swapped — the player may need it for port forwarding).
     * Binding and the first asset lookups run off the main thread (ANR-safe).
     */
    @PluginMethod
    public void start(PluginCall call) {
        if (server != null && server.isRunning()) {
            call.resolve(status());
            return;
        }
        Integer requested = call.getInt("port");
        int port = requested != null && requested >= 0 && requested <= 65535 ? requested : 0;
        boolean strict = port != 0;
        getBridge().execute(() -> {
            try {
                AssetManager assets = getContext().getAssets();
                MiniHostServer started = new MiniHostServer(
                    new AssetStaticSource(assets, "public"), listener(), port, strict ? MiniHostServer.STRICT : PORT_SEARCH);
                started.start();
                server = started;
                JSObject result = status();
                getBridge().executeOnMainThread(() -> call.resolve(result));
            } catch (IOException e) {
                getBridge().executeOnMainThread(() -> {
                    JSObject out = status();
                    out.put("error", strict
                        ? "端口 " + port + " 已被占用，请换一个端口再试。"
                        : "无法开启服务器：" + e.getMessage());
                    call.resolve(out);
                });
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopServer();
        call.resolve(status());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    /** One text frame to one socket (the game's reply). */
    @PluginMethod
    public void send(PluginCall call) {
        Integer id = call.getInt("id");
        String data = call.getString("data");
        if (id == null || data == null) {
            call.reject("send 需要 id 与 data");
            return;
        }
        MiniHostServer s = server;
        call.resolve(new JSObject().put("ok", s != null && s.send(id, data)));
    }

    /** Ping one socket — the game's Network heartbeat uses this to notice a peer that vanished. */
    @PluginMethod
    public void ping(PluginCall call) {
        Integer id = call.getInt("id");
        MiniHostServer s = server;
        call.resolve(new JSObject().put("ok", id != null && s != null && s.ping(id)));
    }

    /** Drop one socket (the game closed the session). */
    @PluginMethod
    public void closeConn(PluginCall call) {
        Integer id = call.getInt("id");
        MiniHostServer s = server;
        if (id != null && s != null) s.closeConn(id);
        call.resolve(new JSObject().put("ok", id != null && s != null));
    }

    /**
     * Drop every socket. The page that drives the game logic is going away (a reload, or the app closing), so the
     * guests it served get a clean disconnect instead of frames going nowhere. The listener itself stays up: the app
     * keeps hosting while a new page boots to talk to it.
     */
    @PluginMethod
    public void closeAll(PluginCall call) {
        MiniHostServer s = server;
        if (s != null) s.closeConnections();
        call.resolve(new JSObject().put("ok", s != null));
    }

    /** The shape shell/picker.js expects from `window.__SP_HOST__.status()` (see desktop/preload.cjs). */
    private JSObject status() {
        MiniHostServer s = server;
        boolean active = s != null && s.isRunning();
        int port = active ? s.port() : 0;
        JSObject out = new JSObject();
        out.put("active", active);
        out.put("port", active ? port : null);
        out.put("url", active ? "http://127.0.0.1:" + port : null);
        JSArray addresses = new JSArray();
        if (active) for (String a : MiniHostServer.lanAddresses()) addresses.put(a);
        out.put("addresses", addresses);
        return out;
    }

    /** Native socket events as Capacitor events, marshalled to the main thread. */
    private MiniHostServer.Listener listener() {
        return new MiniHostServer.Listener() {
            @Override
            public void onOpen(int id, String peer) {
                emit("open", new JSObject().put("id", id).put("peer", peer));
            }

            @Override
            public void onMessage(int id, String text) {
                emit("frame", new JSObject().put("id", id).put("data", text));
            }

            @Override
            public void onPong(int id) {
                emit("pong", new JSObject().put("id", id));
            }

            @Override
            public void onClose(int id) {
                emit("close", new JSObject().put("id", id));
            }
        };
    }

    private void emit(String event, JSObject data) {
        getBridge().executeOnMainThread(() -> notifyListeners(event, data));
    }

    private void stopServer() {
        MiniHostServer s = server;
        server = null;
        if (s != null) s.close();
    }
}

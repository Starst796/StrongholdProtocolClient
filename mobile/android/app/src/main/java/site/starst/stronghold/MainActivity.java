package site.starst.stronghold;

import android.app.AlertDialog;
import android.net.http.SslError;
import android.os.Bundle;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.util.HashSet;
import java.util.Set;

import site.starst.stronghold.host.HostServerPlugin;

/**
 * The game window: full screen, edge to edge.
 *
 * The template this project started from leaves the status and navigation bars visible, so the WebView is inset and
 * the game sits in a smaller rectangle with the system bars (and the display-cutout strip) around it — the black bars
 * along the top, bottom and side edges. The game is a landscape title with its own HUD, so it takes the whole display:
 *
 *  - {@code setDecorFitsSystemWindows(false)} lets the WebView draw under the system bars instead of being inset by
 *    them, and {@code hide(systemBars())} removes them (a swipe brings them back as a transient overlay).
 *  - The HUD keeps itself inside the notches: public/css/devices.css places every screen inside
 *    {@code env(safe-area-inset-*)} while the board stays full-bleed. The cutout is only reported to the WebView while
 *    the window may use that area — see {@code windowLayoutInDisplayCutoutMode} in res/values/styles.xml.
 *  - Android 15+ draws apps edge to edge whether or not they ask for it; hiding the bars is still up to the app.
 *
 * It also owns the client's TLS policy (see {@link TrustedCerts}): the game server is whatever the player types in
 * the picker, and a self-hosted one is very often behind a tunnel with a self-signed certificate, which the WebView
 * refuses outright. {@code onReceivedSslError} asks once per server instead of verifying nothing.
 */
public class MainActivity extends BridgeActivity {

    /** Hosts the player declined: not asked again until the page reloads (switching servers reloads it). */
    private final Set<String> declinedCerts = new HashSet<>();
    /** Hosts whose dialog is on screen: further failures wait for it instead of stacking dialogs. */
    private final Set<String> askingCerts = new HashSet<>();

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before super.onCreate(): Capacitor collects plugins while the bridge is being built.
        registerPlugin(HostServerPlugin.class);
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        applyImmersive();
        installCertificatePrompt();
    }

    /**
     * Trust-on-first-use for self-signed servers. Capacitor's own WebViewClient is kept (it serves the local
     * payload and drives the JS bridge) — only the SSL-error hook is overridden, so a self-hosted server becomes
     * reachable after the player accepts its certificate while everything else stays verified.
     */
    private void installCertificatePrompt() {
        if (bridge == null) return;
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                askAboutCertificate(handler, error);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                declinedCerts.clear();
                super.onPageFinished(view, url);
            }
        });
    }

    /** Is the certificate already trusted? Then go; otherwise ask, or refuse while the answer is pending. */
    private void askAboutCertificate(final SslErrorHandler handler, final SslError error) {
        final String host = TrustedCerts.hostKey(error.getUrl());
        final String fp = TrustedCerts.fingerprintOf(error.getCertificate());
        if (TrustedCerts.isTrusted(this, host, fp)) {
            handler.proceed();
            return;
        }
        if (host.isEmpty() || fp.isEmpty() || declinedCerts.contains(host) || askingCerts.contains(host) || isFinishing()) {
            handler.cancel();
            return;
        }
        askingCerts.add(host);
        new AlertDialog.Builder(this)
            .setTitle("无法验证服务器证书")
            .setMessage("无法验证 " + host + " 的证书。\n\n证书主题：" + TrustedCerts.subjectOf(error.getCertificate())
                + "\nSHA-256 指纹：" + TrustedCerts.shortFingerprint(fp)
                + "\n\n“仍然连接”只对这台服务器跳过证书校验（其它服务器照常校验）：网络上的其他人可能在冒充它，"
                + "请只在确认这是自己或信得过的人开的服务器时才继续。决定会记住，证书以后变了会再问一次。")
            .setCancelable(false)
            .setPositiveButton("仍然连接", (dialog, which) -> {
                askingCerts.remove(host);
                TrustedCerts.remember(this, host, fp);
                handler.proceed();
            })
            .setNegativeButton("取消", (dialog, which) -> {
                askingCerts.remove(host);
                declinedCerts.add(host);
                handler.cancel();
            })
            .show();
    }

    /** A dialog, the keyboard or a swipe can bring the bars back: hide them again whenever the window has focus. */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    private void applyImmersive() {
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }
}


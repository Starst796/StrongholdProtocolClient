package site.starst.stronghold;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.os.Build;
import android.os.Bundle;

import java.io.ByteArrayInputStream;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Locale;

/**
 * Trust-on-first-use store — the Android counterpart of {@code desktop/trust.mjs} (see docs/PACKAGING.md §5).
 *
 * A self-hosted server usually sits behind a tunnel or reverse proxy whose certificate is self-signed (SakuraFrp's
 * "automatic TLS", for one), and the WebView refuses those. {@code MainActivity} asks the player once per server and
 * remembers the exact certificate that was accepted here, so every other server is still verified normally and a
 * *changed* certificate asks again.
 */
final class TrustedCerts {

    private static final String PREFS = "stronghold_trusted_certs";
    /** {@link SslCertificate#saveState} key holding the DER bytes of the certificate (the API &lt; 29 path). */
    private static final String STATE_KEY = "x509-certificate";

    private TrustedCerts() {}

    /** {@code wss://frp-boy.com:60751/ws} → {@code frp-boy.com:60751} (host only, so every request to it is covered). */
    static String hostKey(String url) {
        try {
            String authority = Uri.parse(url).getAuthority();
            return authority == null ? "" : authority.toLowerCase(Locale.US);
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * The X.509 certificate behind an SSL error. {@code SslCertificate.getX509Certificate()} only exists from API 29,
     * so older devices go through the saved state — the same DER bytes the new API hands back.
     */
    static X509Certificate x509(SslCertificate cert) {
        if (cert == null) return null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return cert.getX509Certificate();
        Bundle state = SslCertificate.saveState(cert);
        byte[] der = state == null ? null : state.getByteArray(STATE_KEY);
        if (der == null) return null;
        try {
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
        } catch (Exception e) {
            return null;
        }
    }

    /** The certificate's SHA-256 fingerprint, written the way Electron writes it ({@code AA:BB:…}). */
    static String fingerprint(X509Certificate cert) {
        if (cert == null) return "";
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
            StringBuilder sb = new StringBuilder(digest.length * 3);
            for (int i = 0; i < digest.length; i++) {
                if (i > 0) sb.append(':');
                sb.append(String.format(Locale.US, "%02X", digest[i]));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    static String fingerprintOf(SslCertificate cert) {
        return fingerprint(x509(cert));
    }

    /** Who the certificate was issued to, for the prompt (works on every API level). */
    static String subjectOf(SslCertificate cert) {
        try {
            SslCertificate.DName name = cert == null ? null : cert.getIssuedTo();
            String cn = name == null ? null : name.getCName();
            return cn == null || cn.isEmpty() ? "(未知)" : cn;
        } catch (Exception e) {
            return "(未知)";
        }
    }

    /** {@code AA:BB:CC:…:DD:EE:FF}: enough to compare out loud, short enough for a dialog. */
    static String shortFingerprint(String fp) {
        if (fp == null) return "";
        String[] p = fp.split(":");
        if (p.length < 8) return fp;
        return p[0] + ":" + p[1] + ":" + p[2] + ":…:" + p[p.length - 3] + ":" + p[p.length - 2] + ":" + p[p.length - 1];
    }

    /** Is this exact certificate already trusted for this host? (A new fingerprint is a new question.) */
    static boolean isTrusted(Context ctx, String host, String fp) {
        return host != null && !host.isEmpty() && fp != null && !fp.isEmpty()
                && fp.equals(prefs(ctx).getString(host, null));
    }

    static void remember(Context ctx, String host, String fp) {
        prefs(ctx).edit().putString(host, fp).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}

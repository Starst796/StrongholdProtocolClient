package site.starst.stronghold;

import android.os.Bundle;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

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
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        applyImmersive();
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


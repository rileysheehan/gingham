package co.rileysheehan.gingham;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The whole app: the family frame's page, full screen, for as long as the device is on.
 *
 * What a kiosk browser was doing for the frame, and nothing else: start on boot (it is also the launcher), stay
 * full screen with the display awake, come back by itself when the network or the page fails, let the page dim the
 * backlight, and keep hands out of any settings. There is nothing to configure but one setup link, which the frame's
 * server issues, and one permission Android asks for only when someone first installs an update from Settings.
 */
public class FrameActivity extends Activity {
    private static final String PREFS = "frame", KEY_URL = "url";
    private static final long RETRY_MS = 20_000, CORNER_HOLD_MS = 4_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private TextView notice;
    private boolean failed;
    /** The wall's address as last loaded; read from the page's bridge thread, so volatile. */
    private volatile String wallUrl;
    /** While the play page is up: its address, and how long without a touch before the wall comes back. */
    private String playUrl;
    private long playReturnMs;
    /** While the play page is up: the corner hold that closes it, and the faint mark that says it is counting. */
    private PlayMath.CornerHold playCorner;
    private View playMark;
    /** The rest of a touch whose hold closed the play page, kept from the wall that replaced it. */
    private boolean swallowGesture;
    private ConnectivityManager.NetworkCallback networkCallback;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        acceptPairing(getIntent());
        start();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (acceptPairing(intent)) start();
    }

    /** "local" in place of an address: this tablet runs the household's server itself. */
    static final String LOCAL = "local";

    /** gingham://pair?url=<the setup link>, or gingham://local. Returns whether anything was stored. */
    private boolean acceptPairing(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"gingham".equals(data.getScheme())) return false;
        if (LOCAL.equals(data.getHost()) && BuildConfig.HAS_NODE) { prefs().edit().putString(KEY_URL, LOCAL).commit(); return true; }
        String link = data.getQueryParameter("url");
        if (!validLink(link)) return false;
        prefs().edit().putString(KEY_URL, link).commit();
        return true;
    }

    private static boolean validLink(String link) {
        if (link == null) return false;
        Uri uri = Uri.parse(link.trim());
        return ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) && uri.getHost() != null;
    }

    // Written with commit(), not apply(): a change of server may be followed at once by the end of this process, and
    // apply() only promises to reach the disk eventually.
    private SharedPreferences prefs() { return getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    private void start() {
        handler.removeCallbacksAndMessages(null);
        playUrl = null;
        String url = prefs().getString(KEY_URL, null);
        // No longer its own server, but the server is still running in here and cannot be stopped: start afresh.
        if (!LOCAL.equals(url) && NodeServer.isStarted()) { RestartActivity.restart(getApplicationContext()); return; }
        if (url == null) showSetup(); else if (LOCAL.equals(url)) startLocal(); else showFrame(url);
    }

    /** Start the server in this app, wait for it to answer, then show its page like any other. */
    private void startLocal() {
        root.removeAllViews();
        final TextView waiting = new TextView(this);
        waiting.setText("Starting\u2026");
        waiting.setTextColor(0xFFB8C0CC); waiting.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22); waiting.setGravity(Gravity.CENTER);
        root.addView(waiting, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        NodeServer.ensureStarted(getApplicationContext());
        new Thread(new Runnable() { @Override public void run() {
            for (int i = 0; i < 240 && !NodeServer.isUp(); i++) try { Thread.sleep(250); } catch (InterruptedException e) { return; }
            runOnUiThread(new Runnable() { @Override public void run() { if (LOCAL.equals(prefs().getString(KEY_URL, null))) showFrame(NodeServer.ADDRESS); } });
        } }, "frame-wait").start();
    }

    // ---------------------------------------------------------------- the frame

    private void showFrame(final String url) {
        root.removeAllViews();
        if (web != null) web.destroy();
        wallUrl = url;
        playUrl = null;
        playCorner = null; playMark = null;
        handler.removeCallbacks(playReturn);
        web = newWebView();
        web.addJavascriptInterface(new Bridge(), "fully");
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String finished) {
                CookieManager.getInstance().flush();
                if (!failed) hideNotice();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) retryLater();
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 500) retryLater();
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                handler.post(new Runnable() { @Override public void run() { start(); } });   // rebuild the WebView rather than crash
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !sameHost(url, request.getUrl());   // the frame never wanders off to another site
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        notice = new TextView(this);
        notice.setTextColor(Color.WHITE);
        notice.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        notice.setGravity(Gravity.CENTER);
        notice.setBackgroundColor(Color.BLACK);
        notice.setVisibility(View.GONE);
        root.addView(notice, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        failed = false;
        web.loadUrl(url);
        watchNetwork();
        handler.removeCallbacks(saveCookies);
        handler.postDelayed(saveCookies, 30_000);
    }

    /** A full-screen WebView as the frame wants one, with no bridge: showFrame adds the bridge for the wall alone. */
    private WebView newWebView() {
        WebView web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setOnLongClickListener(new View.OnLongClickListener() { @Override public boolean onLongClick(View v) { return true; } });
        web.setHapticFeedbackEnabled(false);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setTextZoom(100);                 // the page sizes itself from the screen; system font scaling must not
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        CookieManager.getInstance().setAcceptCookie(true);
        WebView.setWebContentsDebuggingEnabled(true);   // reachable only over ADB, which is how a frame is looked after
        return web;
    }

    // ---------------------------------------------------------------- the play page

    /*
     * DESIGN.md → "A play page, for one household". A household whose settings.json names a play page can open it by
     * holding the wall's clock; the wall asks through the bridge (openPlayPage) and names no address. The app asks the
     * household's own server for it, so the page on the wall can never send the frame anywhere of its choosing.
     *
     * The play page gets a WebView of its own, built without the bridge: the wall's WebView is destroyed first (one
     * page at a time on a 1 GB frame), so "fully" (brightness, restart, installing updates) never exists in any
     * WebView that has shown another site. While it is up it may go only to its own origin; every touch starts the
     * wait again, and after returnAfterMinutes untouched, Back with nowhere left to go, a failed load or a crash, the
     * wall is built again from scratch as at start.
     */
    private void askForPlayPage() {
        final String wall = wallUrl, settings = PlayMath.settingsUrl(wall);
        if (settings == null || playUrl != null) return;
        final String cookies = CookieManager.getInstance().getCookie(settings);
        new Thread(new Runnable() { @Override public void run() {
            final String[] play = fetchPlayPage(settings, cookies);
            if (play == null) return;
            runOnUiThread(new Runnable() { @Override public void run() {
                // Only if the wall that asked is still the one showing.
                if (playUrl == null && wall.equals(wallUrl) && web != null) showPlayPage(play[0], Integer.parseInt(play[1]));
            } });
        } }, "play-page").start();
    }

    /** {url, minutes} from the household's settings, or null if it has no play page or the server did not answer. */
    private static String[] fetchPlayPage(String settings, String cookies) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(settings).openConnection();
            c.setConnectTimeout(10_000); c.setReadTimeout(10_000); c.setInstanceFollowRedirects(false); c.setUseCaches(false);
            if (cookies != null && !cookies.isEmpty()) c.setRequestProperty("Cookie", cookies);
            if (c.getResponseCode() != 200) return null;
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[4096];
                for (int n; (n = in.read(buf)) > 0; ) { body.write(buf, 0, n); if (body.size() > 64 * 1024) return null; }
            }
            JSONObject play = new JSONObject(body.toString("UTF-8")).optJSONObject("playPage");
            String url = play == null ? null : PlayMath.validUrl(play.optString("url", null));
            if (url == null) return null;
            return new String[] {url, String.valueOf(PlayMath.returnMinutes(play.opt("returnAfterMinutes")))};
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void showPlayPage(final String address, int minutes) {
        CookieManager.getInstance().flush();
        handler.removeCallbacks(retry);
        failed = false;
        hideNotice();
        if (web != null) { root.removeView(web); web.destroy(); }
        playUrl = address;
        playReturnMs = minutes * 60_000L;
        web = newWebView();
        WebSettings s = web.getSettings();
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !PlayMath.sameOrigin(address, request.getUrl().toString());   // its own site and nowhere else
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) handler.post(playReturn);
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                handler.post(new Runnable() { @Override public void run() { start(); } });
                return true;
            }
        });
        root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // The corner that closes it: the same 96 dp as the maintenance corner, its mark a soft grey that shows on a light
        // page and a dark one alike. Native, over the page, so nothing the page draws can hide or imitate it.
        float corner = dp(96);
        playCorner = new PlayMath.CornerHold(corner, dp(24));
        GradientDrawable glow = new GradientDrawable();
        glow.setGradientType(GradientDrawable.RADIAL_GRADIENT);
        glow.setColors(new int[] {0x80808080, 0x00808080});
        glow.setGradientCenter(0f, 0f);
        glow.setGradientRadius(corner);
        playMark = new View(this);
        playMark.setBackground(glow);
        playMark.setVisibility(View.GONE);
        root.addView(playMark, new FrameLayout.LayoutParams((int) corner, (int) corner, Gravity.TOP | Gravity.START));
        web.loadUrl(address);
        playTouched();
    }

    private float dp(float value) { return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()); }

    /**
     * The play page's corner hold, for each touch the activity sees before the page does. Returns true for the rest of
     * a touch whose hold already closed the page, which nothing then receives: the wall never gets half a gesture.
     * Everything else goes on to the page as it came, a tap in the corner included.
     */
    private boolean playCornerTouch(MotionEvent event) {
        int action = event.getActionMasked();
        if (swallowGesture) {
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) swallowGesture = false;
            return true;
        }
        if (playUrl == null || playCorner == null) return false;
        long t = event.getEventTime();   // uptime, the clock the handler runs on
        if (action == MotionEvent.ACTION_DOWN) {
            playCorner.down(event.getX(), event.getY(), t);
            if (playCorner.at(t) != PlayMath.CornerHold.IDLE) {
                handler.postAtTime(playCornerCue, t + PlayMath.CornerHold.CUE_MS);
                handler.postAtTime(playCornerDone, t + PlayMath.CornerHold.HOLD_MS);
            }
        } else if (action == MotionEvent.ACTION_MOVE) playCorner.move(event.getX(), event.getY());
        else playCorner.end();   // let go, cancelled, or a second finger
        if (playCorner.at(t) == PlayMath.CornerHold.IDLE) stopCornerHold();
        return false;
    }

    private void stopCornerHold() {
        handler.removeCallbacks(playCornerCue);
        handler.removeCallbacks(playCornerDone);
        if (playCorner != null) playCorner.end();
        if (playMark != null) playMark.setVisibility(View.GONE);
    }

    private final Runnable playCornerCue = new Runnable() { @Override public void run() {
        if (playCorner != null && playMark != null && playCorner.at(SystemClock.uptimeMillis()) == PlayMath.CornerHold.CUED) playMark.setVisibility(View.VISIBLE);
    } };

    /**
     * Held long enough: the wall comes back, as it does after the quiet minutes. The maintenance corner's own wait is
     * cancelled with it, so a grown-up who keeps holding a moment longer gets the wall and not a dialog; maintenance is
     * a fresh four-second hold from the wall.
     */
    private final Runnable playCornerDone = new Runnable() { @Override public void run() {
        if (playUrl == null || playCorner == null || playCorner.at(SystemClock.uptimeMillis()) != PlayMath.CornerHold.DONE) return;
        stopCornerHold();
        handler.removeCallbacks(openMaintenance);
        swallowGesture = true;
        playReturn.run();
    } };

    private void playTouched() {
        if (playUrl == null) return;
        handler.removeCallbacks(playReturn);
        handler.postDelayed(playReturn, playReturnMs);
    }

    private final Runnable playReturn = new Runnable() { @Override public void run() {
        if (playUrl == null) return;
        String wall = wallUrl;
        if (wall == null) start(); else showFrame(wall);
    } };

    /**
     * Pairing hands the frame its secret in the answer to a background request, not a page load, so nothing would
     * otherwise write it to disk before the next restart. Saved twice a minute and whenever the app steps back.
     */
    private final Runnable saveCookies = new Runnable() { @Override public void run() { CookieManager.getInstance().flush(); handler.postDelayed(this, 30_000); } };
    @Override protected void onPause() { super.onPause(); CookieManager.getInstance().flush(); }
    // Back from Android's "install unknown apps" page or its install dialog: an update in hand carries on, or says why not.
    @Override protected void onResume() { super.onResume(); UpdateInstaller.get(this).resumed(); }

    private static boolean sameHost(String home, Uri other) {
        String host = Uri.parse(home).getHost();
        return host != null && host.equals(other.getHost());
    }

    /** The page did not load. Say so plainly and keep trying; a frame must never need someone to press reload. */
    private void retryLater() {
        failed = true;
        notice.setText("Can’t reach the frame’s server\nTrying again every few seconds");
        notice.setVisibility(View.VISIBLE);
        handler.removeCallbacks(retry);
        handler.postDelayed(retry, RETRY_MS);
    }
    private final Runnable retry = new Runnable() { @Override public void run() { if (web != null) { failed = false; web.reload(); } } };
    private void hideNotice() { if (notice != null) notice.setVisibility(View.GONE); }

    private void watchNetwork() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null || networkCallback != null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                handler.post(new Runnable() { @Override public void run() { if (failed) { handler.removeCallbacks(retry); retry.run(); } } });
            }
        };
        try { cm.registerDefaultNetworkCallback(networkCallback); } catch (RuntimeException e) { networkCallback = null; }
    }

    /**
     * What the page may ask of the device. Named "fully" because the page already speaks to Fully Kiosk's bridge by
     * that name, so the same page runs in either without knowing which. Dimming the app's own window needs no
     * permission, which is the reason this app exists.
     */
    private final class Bridge {
        @JavascriptInterface public void setScreenBrightness(final double level) {
            runOnUiThread(new Runnable() { @Override public void run() {
                WindowManager.LayoutParams p = getWindow().getAttributes();
                p.screenBrightness = (float) Math.max(0.01, Math.min(1.0, level / 255.0));
                getWindow().setAttributes(p);
            } });
        }
        @JavascriptInterface public void restartApp() {
            runOnUiThread(new Runnable() { @Override public void run() { start(); } });
        }
        /** Held the clock: open the household's play page, if its settings name one. The page names no address. */
        @JavascriptInterface public void openPlayPage() {
            runOnUiThread(new Runnable() { @Override public void run() { askForPlayPage(); } });
        }

        // Updating this app, from Settings (UpdateInstaller). Fully Kiosk has none of these, which is how the page
        // tells the two apart. The page names a version and nothing else: where the file comes from, and whether it
        // may be installed, is decided on this side.
        /** {"version":"0.1.1","variant":"32bit","installs":true} */
        @JavascriptInterface public String ginghamApp() { return UpdateInstaller.get(FrameActivity.this).describe(); }
        @JavascriptInterface public void installUpdate(String version) { UpdateInstaller.get(FrameActivity.this).install(version); }
        /** {"state":"idle|permission|downloading|verifying|confirm|failed", "version", "reason", "done", "total", ...} */
        @JavascriptInterface public String updateStatus() { return UpdateInstaller.get(FrameActivity.this).status(); }
        @JavascriptInterface public void openInstallPermission() {
            runOnUiThread(new Runnable() { @Override public void run() { UpdateInstaller.get(FrameActivity.this).openPermission(); } });
        }
        @JavascriptInterface public void cancelUpdate() { UpdateInstaller.get(FrameActivity.this).cancel(); }
    }

    // ---------------------------------------------------------------- first run

    private void showSetup() {
        root.removeAllViews();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        int pad = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 48, getResources().getDisplayMetrics());
        box.setPadding(pad, pad, pad, pad);
        TextView title = new TextView(this);
        title.setText("Set up this frame");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 34);
        TextView help = new TextView(this);
        help.setText("Paste or type the setup link you were given for this frame.");
        help.setTextColor(0xFFB8C0CC);
        help.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        help.setPadding(0, pad / 3, 0, pad / 2);
        final EditText link = new EditText(this);
        link.setHint("https://…/?k=…");
        link.setSingleLine(true);
        link.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        link.setTextColor(Color.WHITE);
        link.setHintTextColor(0xFF6B7686);
        link.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        final Button go = new Button(this);
        go.setText("Connect");
        go.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        go.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) {
            String value = link.getText().toString().trim();
            if (!validLink(value)) { link.setError("That doesn’t look like a link"); return; }
            prefs().edit().putString(KEY_URL, value).commit();
            start();
        } });
        box.addView(title);
        box.addView(help);
        box.addView(link, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        box.addView(go);
        if (BuildConfig.HAS_NODE) {
            final Button alone = new Button(this);
            alone.setText("No server? Run everything on this tablet");
            alone.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
            alone.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { prefs().edit().putString(KEY_URL, LOCAL).commit(); start(); } });
            box.addView(alone);
        }
        root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));
    }

    // ---------------------------------------------------------------- staying a frame

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    /** Back never leaves the frame. On the play page it goes back within it, and from its first page to the wall. */
    @Override public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (playUrl != null) {
            playTouched();
            if (keyCode == KeyEvent.KEYCODE_BACK) {
                if (web != null && web.canGoBack()) web.goBack(); else playReturn.run();
                return true;
            }
        }
        return keyCode == KeyEvent.KEYCODE_BACK || super.onKeyDown(keyCode, event);
    }

    /** Holding the top-left corner for four seconds is the one way in, deliberate enough that nobody does it by accident. */
    private final Runnable openMaintenance = new Runnable() { @Override public void run() { showMaintenance(); } };
    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        playTouched();
        float corner = dp(96);
        boolean inCorner = event.getX() < corner && event.getY() < corner;
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN && inCorner) handler.postDelayed(openMaintenance, CORNER_HOLD_MS);
        else if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL || !inCorner) handler.removeCallbacks(openMaintenance);
        // On the play page the same corner closes it, a second sooner (playCornerTouch).
        if (playCornerTouch(event)) return true;
        return super.dispatchTouchEvent(event);
    }

    private void showMaintenance() {
        String url = prefs().getString(KEY_URL, "");
        String host = url.isEmpty() ? "not set up" : LOCAL.equals(url) ? "this tablet\u2019s own server" : String.valueOf(Uri.parse(url).getHost());
        new AlertDialog.Builder(this)
            .setTitle("Frame maintenance")
            .setMessage("Connected to " + host)
            .setPositiveButton("Reload", (d, w) -> start())
            .setNeutralButton("Android settings", (d, w) -> startActivity(new Intent(Settings.ACTION_SETTINGS)))
            .setNegativeButton("New setup link", (d, w) -> { prefs().edit().remove(KEY_URL).commit(); CookieManager.getInstance().removeAllCookies(null); start(); })
            .show();
    }

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null && networkCallback != null) try { cm.unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) {}
        if (web != null) { root.removeView(web); web.destroy(); web = null; }
        super.onDestroy();
    }
}

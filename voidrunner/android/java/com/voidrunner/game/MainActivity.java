package com.voidrunner.game;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * VOIDRUNNER's native shell: a full-screen WebView playing the same build that
 * runs on the web.
 *
 * The game is NOT loaded from file:// - it is served from a virtual https
 * origin backed by the APK's assets. That matters for three reasons: ES modules
 * are blocked by CORS on file:// URLs, localStorage on an opaque file origin is
 * unreliable, and a stable origin means saves survive updates.
 *
 * The app declares no INTERNET permission. Every request is answered from
 * assets, so if interception ever missed one it would fail rather than reach
 * the network. The game has nothing to talk to anyway.
 */
public class MainActivity extends Activity {

    private static final String ORIGIN = "https://voidrunner.local/";
    private static final String ASSET_ROOT = "www/";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(0xFF04060D);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setHorizontalScrollBarEnabled(false);
        web.setVerticalScrollBarEnabled(false);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        // The page reads this marker to skip the service worker, which exists
        // only to make the web build work offline - meaningless inside an APK.
        s.setUserAgentString(s.getUserAgentString() + " VoidrunnerNative/1");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serve(request.getUrl().toString());
            }

            @SuppressWarnings("deprecation")
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return serve(url);
            }
        });

        setContentView(web);
        web.loadUrl(ORIGIN + "index.html");
    }

    /** Answer a request out of the APK's assets, or 404. Never hits the network. */
    private WebResourceResponse serve(String url) {
        if (url == null || !url.startsWith(ORIGIN)) return notFound();

        String path = url.substring(ORIGIN.length());
        int cut = path.indexOf('?');
        if (cut >= 0) path = path.substring(0, cut);
        cut = path.indexOf('#');
        if (cut >= 0) path = path.substring(0, cut);
        if (path.isEmpty() || path.endsWith("/")) path = path + "index.html";
        if (path.contains("..")) return notFound();

        try {
            InputStream in = getAssets().open(ASSET_ROOT + path);
            return new WebResourceResponse(mimeOf(path), "utf-8", 200, "OK", headers(), in);
        } catch (IOException missing) {
            return notFound();
        }
    }

    private WebResourceResponse notFound() {
        return new WebResourceResponse(
                "text/plain", "utf-8", 404, "Not Found", headers(),
                new ByteArrayInputStream(new byte[0]));
    }

    private Map<String, String> headers() {
        Map<String, String> h = new HashMap<String, String>();
        h.put("Cache-Control", "no-store");
        return h;
    }

    /** A module script served with the wrong type is rejected outright, so this matters. */
    private static String mimeOf(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".webmanifest") || path.endsWith(".json")) return "application/json";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".txt") || path.endsWith(".md")) return "text/plain";
        return "application/octet-stream";
    }

    /** Back pauses, then backs out through the menus, then leaves the app. */
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        web.evaluateJavascript(
                "(function(){try{return !!(window.__vrBack&&window.__vrBack());}catch(e){return false;}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String handled) {
                        if (!"true".equals(handled)) finish();
                    }
                });
    }

    private void goImmersive() {
        web.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        goImmersive();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}

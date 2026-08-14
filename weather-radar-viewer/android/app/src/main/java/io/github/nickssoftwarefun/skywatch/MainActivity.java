package io.github.nickssoftwarefun.skywatch;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

/**
 * Full-screen shell around the SKYWATCH PWA.
 *
 * The web app ships inside the APK (assets/www, copied from ../pwa at build
 * time) and is served to the WebView by intercepting requests to a private
 * https origin. Nothing is loaded from GitHub Pages — the app runs entirely
 * on its own, needing the network only for the live weather feeds themselves
 * (radar tiles, satellite imagery, forecasts, alerts).
 *
 * The origin is https, not file://, because the app needs a secure context:
 * geolocation and ES modules both refuse to run from file URLs. The host is
 * the androidx-reserved appassets.androidx.dev, which is guaranteed never to
 * resolve on the real internet, so every request to it lands in
 * shouldInterceptRequest and is answered from assets.
 */
public class MainActivity extends Activity {

    private static final String APP_HOST = "appassets.androidx.dev";
    private static final String APP_URL = "https://" + APP_HOST + "/index.html";
    private static final int RC_LOCATION = 41;

    private WebView web;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        // it's a weather display — don't let the screen sleep while it's open
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0A1018);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage: ZIP + auto-mode settings
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setSupportZoom(false);
        s.setGeolocationEnabled(true);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                    GeolocationPermissions.Callback callback) {
                // only our own origin may read location through the shell
                if (origin == null || !origin.contains(APP_HOST)) {
                    callback.invoke(origin, false, false);
                    return;
                }
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false);
                    return;
                }
                pendingGeoOrigin = origin;
                pendingGeoCallback = callback;
                requestPermissions(
                        new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                                     Manifest.permission.ACCESS_COARSE_LOCATION},
                        RC_LOCATION);
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view,
                    WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!"https".equals(url.getScheme()) || !APP_HOST.equals(url.getHost())) {
                    return null;               // live feeds go to the real network
                }
                return serveAsset(url.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (APP_HOST.equals(url.getHost())) {
                    return false;              // stay in the app
                }
                startActivity(new Intent(Intent.ACTION_VIEW, url));   // links out to the browser
                return true;
            }
        });

        setContentView(web);

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(APP_URL);
        }
    }

    /** Answer an app-origin request from the bundled web app in assets/www. */
    private WebResourceResponse serveAsset(String path) {
        if (path == null || "/".equals(path)) {
            path = "/index.html";
        }
        if (path.contains("..")) {
            return errorResponse(403, "Forbidden");
        }
        try {
            InputStream in = getAssets().open("www" + path);
            String mime = mimeFor(path);
            String charset = mime.startsWith("text/") || mime.endsWith("json")
                    ? "utf-8" : null;
            return new WebResourceResponse(mime, charset, in);
        } catch (IOException e) {
            return errorResponse(404, "Not Found");
        }
    }

    private static WebResourceResponse errorResponse(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason,
                null, new ByteArrayInputStream(new byte[0]));
    }

    /**
     * AssetManager knows nothing about types, so map from the extension.
     * text/javascript matters most: the app is plain ES modules, and the
     * browser refuses to execute a module served with the wrong MIME type.
     */
    private static String mimeFor(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".gif")) return "image/gif";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == RC_LOCATION && pendingGeoCallback != null) {
            boolean granted = results.length > 0
                    && results[0] == PackageManager.PERMISSION_GRANTED;
            pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applySystemUi();
        }
    }

    /**
     * The status bar stays hidden (the activity theme is fullscreen) but the
     * navigation bar stays put: this is a touch console, and hiding Back/Home
     * behind a swipe makes it feel trapped. The WebView lays out above the
     * nav bar rather than under it, so on-screen controls stay reachable.
     */
    private void applySystemUi() {
        web.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
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

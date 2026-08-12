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
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Full-screen shell around the SKYWATCH PWA.
 *
 * The web app is loaded from its https origin (not bundled into the APK) so
 * that fetches to the weather/radar APIs keep a real origin for CORS, the
 * service worker stays valid, and app updates ship by redeploying the site.
 */
public class MainActivity extends Activity {

    private static final String APP_URL =
            "https://nickssoftwarefun.github.io/Multi-Project-Playground/";
    private static final String APP_HOST = "nickssoftwarefun.github.io";
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
            goImmersive();
        }
    }

    /** Hide the status and navigation bars; they slide back in on a swipe. */
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

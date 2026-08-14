# SKYWATCH — Android APK

A standalone, full-screen build of the SKYWATCH weather app for sideloading
onto a phone or tablet. The entire web app is **bundled inside the APK** — it
does not load anything from GitHub Pages and runs entirely on its own. The
network is used only for the live weather feeds themselves (radar tiles,
satellite imagery, forecasts, alerts).

**Download the latest build:**
https://github.com/NicksSoftwareFun/Multi-Project-Playground/releases/download/android-latest/skywatch.apk

Open that link on the phone, tap the downloaded file, and allow your browser
to install unknown apps when prompted.

## What it is

A single `Activity` hosting a `WebView`. At build time the PWA
(`../pwa`) is copied into the APK's assets; at run time the shell serves those
files to the WebView by intercepting requests to a private https origin
(`appassets.androidx.dev` — a host reserved for exactly this, guaranteed never
to resolve on the real internet). An https origin rather than `file://` keeps
the app in a secure context, which geolocation and ES modules require.

The shell runs immersive (no status bar), holds the screen awake while open,
keeps the back button navigating inside the app, and opens off-site links in
the real browser.

Because the web app is baked into the APK, **web changes require rebuilding
and reinstalling the APK** — CI does this automatically on push (see below).
The service worker is skipped inside the shell (assets are already local and
offline-capable); it still runs on the hosted PWA.

## Building

CI does it: `.github/workflows/android.yml` runs on changes to `android/` or
`pwa/`, or via **Actions → Build Android APK → Run workflow**, then uploads
the result to the `android-latest` release.

Locally, with a JDK 17 and the Android SDK installed:

```bash
cd weather-radar-viewer/android
gradle assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

The `bundlePwa` task copies `../pwa` into `app/build/generated/pwaAssets/www`
before every build; the APK serves the app from there.

### Release signing (optional)

Without secrets the workflow produces a **debug-signed** APK — installable, but
Android treats a signature change as a different app, so a later switch to
release signing needs an uninstall first. To sign properly, add two repository
secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_B64` | base64 of a Java keystore |
| `ANDROID_KEYSTORE_PASSWORD` | its store/key password |

The keystore must use the key alias `skywatch`. Create one with:

```bash
keytool -genkeypair -v -keystore keystore.jks -alias skywatch \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 keystore.jks     # paste into ANDROID_KEYSTORE_B64
```

Keep the keystore file safe and out of the repository — updates must be signed
with the same key.

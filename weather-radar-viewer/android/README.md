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

## Alert notifications

The bell button (🔔) in the app opens the notifications menu: a master
toggle, WARNINGS / WATCHES toggles, and per-category checkboxes (Tornado,
T-Storm, Flood, Tropical, Winter, Heat, Wind, Fire, Fog/Air, Other). While
enabled, the shell polls `api.weather.gov` about every 15 minutes — the
JobScheduler floor, also surviving reboots — for every **saved ZIP location**
and posts a high-priority system notification for each new watch or warning
in an enabled category. Tapping the notification opens the app.

How the pieces talk: the web app owns the settings UI and persistence
(`pwa/js/notify.js`), and pushes settings + ZIP list to the shell over the
`SkywatchShell` JS bridge; `Alerts.java` stores the config, runs the
background checks, and dedupes so a warning only notifies once. GPS
locations are excluded — the shell can't re-fix a position in the
background — and the menu is hidden on the hosted site, which has no
background process to deliver anything.

Android 13+ asks for the notification permission the first time the master
toggle is turned on. Expect delivery timing to wobble by a few minutes when
the phone is dozing; that is Android batching background work, not a bug.

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

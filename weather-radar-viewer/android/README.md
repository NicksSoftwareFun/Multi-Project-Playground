# SKYWATCH — Android APK

A minimal full-screen shell around the hosted PWA, for sideloading onto a
phone or tablet.

**Download the latest build:**
https://github.com/NicksSoftwareFun/Multi-Project-Playground/releases/download/android-latest/skywatch.apk

Open that link on the phone, tap the downloaded file, and allow your browser
to install unknown apps when prompted.

## What it is

A single `Activity` hosting a `WebView` pointed at
`https://nickssoftwarefun.github.io/Multi-Project-Playground/`. It runs
immersive (no status or navigation bars), holds the screen awake while open,
keeps the back button navigating inside the app, and opens off-site links in
the real browser.

Because the app loads the live site rather than bundling it, **web changes
reach the phone on next launch — no reinstall.** The APK only needs rebuilding
when this native shell changes.

### Why not a Trusted Web Activity?

A TWA renders through Chrome and would be the usual choice, but it hides the
address bar only when Digital Asset Links verification passes, and that file
must be served from the *origin root* (`https://nickssoftwarefun.github.io/.well-known/assetlinks.json`).
This is a project Pages site living under a subpath, so the root belongs to a
different repository. A WebView shell sidesteps the problem and is always
full-screen.

## Building

CI does it: `.github/workflows/android.yml` runs on changes here or via
**Actions → Build Android APK → Run workflow**, then uploads the result to the
`android-latest` release.

Locally, with a JDK 17 and the Android SDK installed:

```bash
cd weather-radar-viewer/android
gradle assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

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

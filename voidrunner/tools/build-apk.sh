#!/usr/bin/env bash
# Builds dist/voidrunner.apk - the game wrapped in a native WebView shell.
#
#   tools/build-apk.sh
#
# Deliberately does not use Gradle or the Android Gradle Plugin: this is a
# single activity with no library dependencies, so the classic
# aapt -> javac -> dx -> zipalign -> apksigner pipeline builds it in a couple of
# seconds with nothing to resolve from a network.
#
# Needs (Debian/Ubuntu package names in brackets):
#   aapt zipalign apksigner  [aapt android-sdk-build-tools apksigner zipalign]
#   android.jar              [android-sdk-platform-23]
#   javac keytool            [default-jdk-headless]
#   a dexer                  see DEX below
#
# DEX: Ubuntu has no dex compiler, and beware - its "dx" package is OpenDX, a
# scientific visualisation suite, nothing to do with Android. Google publishes
# d8/r8 only to maven.google.com. If you have a real SDK, d8 is picked up from
# PATH; otherwise fetch the repackaged AOSP dexer from Maven Central:
#
#   mkdir -p /usr/local/lib/android-dx
#   curl -sSL -o /usr/local/lib/android-dx/dx.jar \
#     https://repo1.maven.org/maven2/com/jakewharton/android/repackaged/dalvik-dx/16.0.1/dalvik-dx-16.0.1.jar

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AND="$ROOT/android"
DIST="$ROOT/dist"
WORK="$DIST/.apk"
KEYSTORE="$AND/.keystore/voidrunner.jks"

PLATFORM="${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}"
PKG="com.voidrunner.game"
APK="$DIST/voidrunner.apk"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1  (apt install $2)" >&2; exit 1; }; }
need aapt aapt
need zipalign zipalign
need apksigner apksigner
need javac default-jdk-headless
need keytool default-jdk-headless
[ -f "$PLATFORM" ] || { echo "missing android.jar at $PLATFORM  (apt install android-sdk-platform-23)" >&2; exit 1; }

DX_JAR="${DX_JAR:-/usr/local/lib/android-dx/dx.jar}"
if command -v d8 >/dev/null 2>&1; then
  dex() { d8 --min-api 23 --output "$1" --lib "$PLATFORM" $(find "$2" -name '*.class'); }
elif [ -f "$DX_JAR" ]; then
  dex() { java -cp "$DX_JAR" com.android.dx.command.Main --dex --min-sdk-version=23 --output="$1/classes.dex" "$2"; }
else
  echo "no dex compiler: install a real SDK's d8, or fetch dx.jar (see the header of this script)" >&2
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK/gen" "$WORK/classes" "$DIST"

# --- 1. assets ------------------------------------------------------------
# The web app goes in verbatim, minus the pieces that only make sense on the
# open web. The service worker in particular would try to cache from a network
# that this app has no permission to reach.
ASSETS="$WORK/assets/www"
mkdir -p "$ASSETS"
cp -R "$ROOT/src" "$ROOT/vendor" "$ROOT/icons" "$ASSETS/"
cp "$ROOT/index.html" "$ROOT/styles.css" "$ROOT/manifest.webmanifest" "$ASSETS/"
echo "assets: $(find "$ASSETS" -type f | wc -l) files, $(du -sh "$ASSETS" | cut -f1)"

# --- 2. resources + manifest ---------------------------------------------
aapt package -f -m \
  -M "$AND/AndroidManifest.xml" \
  -S "$AND/res" \
  -A "$WORK/assets" \
  -I "$PLATFORM" \
  -J "$WORK/gen" \
  -F "$WORK/base.apk"

# --- 3. compile ----------------------------------------------------------
# dx predates Java 9, so target 8 bytecode.
find "$AND/java" "$WORK/gen" -name '*.java' > "$WORK/sources.txt"
javac -nowarn -Xlint:-options --release 8 \
  -classpath "$PLATFORM" \
  -d "$WORK/classes" \
  @"$WORK/sources.txt"

dex "$WORK" "$WORK/classes"

# --- 4. package ----------------------------------------------------------
# aapt add stores paths relative to the working directory, so cd in first.
cp "$WORK/base.apk" "$WORK/unsigned.apk"
( cd "$WORK" && aapt add -f unsigned.apk classes.dex >/dev/null )

zipalign -f -p 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"

# --- 5. sign -------------------------------------------------------------
# A local, throwaway key. It is NOT committed: a signing key in a public repo is
# a signing key anyone can use. Regenerating it changes the app signature, so an
# existing install has to be removed before the new APK will go on.
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  echo "generating a local signing key (first build only)"
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" -storetype PKCS12 \
    -storepass voidrunner -keypass voidrunner \
    -alias voidrunner -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=VOIDRUNNER, OU=Sideload, O=VOIDRUNNER, C=US" >/dev/null 2>&1
fi

apksigner sign \
  --ks "$KEYSTORE" --ks-pass pass:voidrunner --key-pass pass:voidrunner \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$APK" "$WORK/aligned.apk"

apksigner verify --print-certs "$APK" | sed -n '1,6p'
rm -rf "$WORK"

echo
echo "wrote dist/voidrunner.apk  ($(du -h "$APK" | cut -f1))"
echo "install with:  adb install -r dist/voidrunner.apk"

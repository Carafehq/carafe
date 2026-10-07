#!/bin/sh
# make-app.sh — build Carafe.app, the menu bar app with the carafe CLI compiled in.
#
#   ./make-app.sh                         this Mac's architecture, ad-hoc signed, installed to
#                                         ~/Applications/Carafe.app and ready to open
#   ./make-app.sh --no-install            same, staged only (path printed)
#   ./make-app.sh --release VERSION       universal (arm64 + x86_64), zipped to dist/Carafe-VERSION.zip
#                                         with a .sha256; Developer ID signed when CARAFE_SIGN_IDENTITY
#                                         is set (else ad-hoc) and notarized + stapled when
#                                         CARAFE_NOTARY_PROFILE (a notarytool keychain profile) or
#                                         NOTARY_APPLE_ID + NOTARY_TEAM_ID + NOTARY_PASSWORD are set
#
#
# Staged and signed OUTSIDE the repo: the repo lives in iCloud-synced ~/Documents, whose
# file provider stamps directories with attributes codesign refuses. The CLI is compiled
# exactly as scripts/build.ts does it, per architecture, with build target "<platform>-app"
# so `carafe update` defers to the app. The app never runs the repo source: macOS privacy
# protection denies an app files under ~/Documents until the user grants access.
set -eu
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

MODE=install
VERSION=""
OUT="$PWD/dist"
INSTALL="${CARAFE_APP_INSTALL:-$HOME/Applications/Carafe.app}"
while [ $# -gt 0 ]; do
  case "$1" in
    --release) MODE=release; VERSION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --no-install) MODE=stage; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

CHANNEL="${CARAFE_CHANNEL:-stable}"
case "$CHANNEL" in
  stable) DISPLAY_NAME="Carafe"; ZIP_PREFIX="Carafe" ;;
  *) echo "unsupported CARAFE_CHANNEL (got $CHANNEL)" >&2; exit 2 ;;
esac

SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
PKG_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
[ -n "$VERSION" ] || VERSION="$PKG_VERSION-app.$SHA"
STAGE="${TMPDIR:-/tmp}/carafe-app-stage"
APP="$STAGE/Carafe.app"
rm -rf "$STAGE"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 1. The menu bar app (universal for a release).
if [ "$MODE" = release ]; then
  swift build -c release --arch arm64 --arch x86_64 >/dev/null
  cp .build/apple/Products/Release/CarafeMenuBar "$APP/Contents/MacOS/CarafeMenuBar"
  ARCHS="arm64 x64"
else
  swift build -c release >/dev/null
  cp .build/release/CarafeMenuBar "$APP/Contents/MacOS/CarafeMenuBar"
  ARCHS="$(uname -m | sed 's/x86_64/x64/')"
fi

# 2. The carafe CLI, one binary per architecture; the app picks its own.
for arch in $ARCHS; do
  (cd "$ROOT" && bun build --compile --minify --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
    "--target=bun-darwin-$arch" \
    --define "CARAFE_BUILD_VERSION=\"$VERSION\"" --define "CARAFE_BUILD_TARGET=\"darwin-$arch-app\"" \
    --define "CARAFE_BUILD_CHANNEL=\"$CHANNEL\"" \
    src/cli/index.ts --outfile "$APP/Contents/MacOS/carafe-$arch" >/dev/null)
done
[ -f Design/Carafe.icns ] && cp Design/Carafe.icns "$APP/Contents/Resources/Carafe.icns"

# 3. Info.plist. LSUIElement: menu bar only. The bundle version is carafe's. CarafeChannel is
#    what the menu reads to name itself; the bundle id stays one, so a channel-specific app
#    replaces the stable one (both would drive the same capture service).
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>CarafeMenuBar</string>
  <key>CFBundleIdentifier</key><string>hq.carafe.menubar</string>
  <key>CFBundleName</key><string>Carafe</string>
  <key>CFBundleDisplayName</key><string>${DISPLAY_NAME}</string>
  <key>CarafeChannel</key><string>${CHANNEL}</string>
  <key>CFBundleIconFile</key><string>Carafe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>© Carafe</string>
</dict>
</plist>
PLIST

# 4. Sign: nested binaries first (hardened runtime + the JIT entitlements Bun needs), then the bundle.
xattr -cr "$APP"
IDENTITY="${CARAFE_SIGN_IDENTITY:--}"
for arch in $ARCHS; do
  codesign --force --options runtime --timestamp=none --entitlements carafe.entitlements --sign "$IDENTITY" "$APP/Contents/MacOS/carafe-$arch"
done
codesign --force --options runtime --timestamp=none --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict "$APP"
"$APP/Contents/MacOS/carafe-$(uname -m | sed 's/x86_64/x64/')" --version

# 5. Release: notarize when credentials exist, then zip with a checksum.
if [ "$MODE" = release ]; then
  mkdir -p "$OUT"
  ZIP="$OUT/$ZIP_PREFIX-$VERSION.zip"
  rm -f "$ZIP" "$ZIP.sha256"
  if [ "$IDENTITY" != "-" ] && { [ -n "${CARAFE_NOTARY_PROFILE:-}" ] || [ -n "${NOTARY_APPLE_ID:-}" ]; }; then
    codesign --force --options runtime --timestamp --entitlements carafe.entitlements --sign "$IDENTITY" "$APP"/Contents/MacOS/carafe-*
    codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
    ditto -c -k --keepParent "$APP" "$STAGE/notarize.zip"
    if [ -n "${CARAFE_NOTARY_PROFILE:-}" ]; then
      xcrun notarytool submit "$STAGE/notarize.zip" --keychain-profile "$CARAFE_NOTARY_PROFILE" --wait
    else
      xcrun notarytool submit "$STAGE/notarize.zip" --apple-id "$NOTARY_APPLE_ID" --team-id "$NOTARY_TEAM_ID" --password "$NOTARY_PASSWORD" --wait
    fi
    xcrun stapler staple "$APP"
    SIGNED="Developer ID signed, notarized and stapled"
  elif [ "$IDENTITY" != "-" ]; then
    SIGNED="Developer ID signed, NOT notarized (no notary credentials)"
  else
    SIGNED="ad-hoc signed, not notarized: macOS will ask the user to right-click → Open once"
  fi
  ditto -c -k --keepParent "$APP" "$ZIP"
  (cd "$OUT" && shasum -a 256 "$ZIP_PREFIX-$VERSION.zip" > "$ZIP_PREFIX-$VERSION.zip.sha256")
  echo "release: $ZIP ($SIGNED; universal; carafe $VERSION, $CHANNEL channel)"
  exit 0
fi

if [ "$MODE" = stage ]; then
  echo "staged $APP (ad-hoc signed, carafe $VERSION); not installed"
  exit 0
fi

# 6. Local install.
mkdir -p "$(dirname "$INSTALL")"
rm -rf "$INSTALL"
ditto "$APP" "$INSTALL"
codesign --verify --deep --strict "$INSTALL"
echo "installed $INSTALL (ad-hoc signed, carafe $VERSION)"
echo "run:  open \"$INSTALL\""

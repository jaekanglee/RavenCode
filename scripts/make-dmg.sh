#!/usr/bin/env bash
# Build Raven.app bundle + DMG from release binary.
# Usage: bash scripts/make-dmg.sh
#
# Expects: desktop/src-tauri/target/release/raven-desktop (cargo build --release)
#          desktop/src-tauri/resources/{python,raven}/ (prepare-bundle.sh)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_DIR="$REPO_ROOT/desktop/src-tauri"
BINARY="$TAURI_DIR/target/release/raven-desktop"
BUNDLE_DIR="$TAURI_DIR/target/release/bundle"
APP_DIR="$BUNDLE_DIR/macos/Raven.app"
DMG_DIR="$BUNDLE_DIR/dmg"

# 버전 SOT는 tauri.conf.json 하나다. 여기서 파생시키지 않고 하드코딩하면
# 버전을 올렸을 때 DMG 이름·Info.plist·업로드 경로가 조용히 어긋난다.
VERSION="$(python3 -c "import json;print(json.load(open('$TAURI_DIR/tauri.conf.json'))['version'])")"
DMG_NAME="Raven_${VERSION}_aarch64.dmg"
echo "  version: $VERSION (tauri.conf.json)"

[ -f "$BINARY" ] || { echo "❌ Binary not found: $BINARY (run: make desktop-build)"; exit 1; }

echo "=== Building Raven.app ==="

# --- .app structure ---
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Binary
cp "$BINARY" "$APP_DIR/Contents/MacOS/Raven"

# Info.plist
cat > "$APP_DIR/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Raven</string>
	<key>CFBundleDisplayName</key><string>Raven</string>
	<key>CFBundleIdentifier</key><string>com.raven.local</string>
	<key>CFBundleVersion</key><string>$VERSION</string>
	<key>CFBundleShortVersionString</key><string>$VERSION</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleExecutable</key><string>Raven</string>
	<key>CFBundleIconFile</key><string>icon.icns</string>
	<key>CFBundleIconName</key><string>icon</string>
	<key>LSMinimumSystemVersion</key><string>10.15</string>
	<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Icon
if [ -f "$TAURI_DIR/icons/icon.icns" ]; then
  cp "$TAURI_DIR/icons/icon.icns" "$APP_DIR/Contents/Resources/icon.icns"
fi

# Bundled resources (python + raven)
echo "  Copying bundled resources..."
cp -R "$TAURI_DIR/resources" "$APP_DIR/Contents/Resources/resources"

# Dashboard dist (Tauri serves from frontendDist)
if [ -d "$REPO_ROOT/dashboard/dist" ]; then
  mkdir -p "$APP_DIR/Contents/Resources/dashboard"
  cp -R "$REPO_ROOT/dashboard/dist" "$APP_DIR/Contents/Resources/dashboard/dist"
fi

echo "  App size: $(du -sh "$APP_DIR" | cut -f1)"

# --- Code signing ---
# macOS's provenance/Gatekeeper policy refuses to spawn unsigned child processes
# from an app process (posix_spawn fails, surfaced as ENOENT) — the bundled
# python3 interpreter must carry its own valid signature, not just inherit the
# app's. Clear stale xattrs from the python-build-standalone tarball extraction,
# then sign inside-out: nested binaries/dylibs first, then the app bundle itself.
echo "=== Code-signing bundle ==="
xattr -cr "$APP_DIR"
find "$APP_DIR/Contents/Resources/resources" -type f -perm -111 -print0 \
  | while IFS= read -r -d '' f; do
      if file -b "$f" | grep -q "Mach-O"; then
        codesign --force --sign - --timestamp=none "$f" 2>/dev/null
      fi
    done
codesign --force --deep --sign - --timestamp=none "$APP_DIR"
codesign -dv "$APP_DIR" 2>&1 | head -5

# --- DMG ---
echo "=== Building DMG ==="
mkdir -p "$DMG_DIR"
rm -f "$DMG_DIR/$DMG_NAME"
hdiutil create -volname "Raven" -srcfolder "$APP_DIR" -ov -format UDZO "$DMG_DIR/$DMG_NAME" 2>&1 | grep -v "^$"

echo ""
echo "=== Done ==="
echo "  .app: $APP_DIR"
echo "  .dmg: $DMG_DIR/$DMG_NAME ($(du -sh "$DMG_DIR/$DMG_NAME" | cut -f1))"

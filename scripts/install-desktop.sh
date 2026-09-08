#!/usr/bin/env bash
# Build Raven.app from the current repo checkout and (re)install it into /Applications.
# Does NOT clone or pull — operates only on the source already on disk.
#
# Usage: bash scripts/install-desktop.sh   (or: make desktop-install)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[1/4] Checking build dependencies..."

if ! command -v cargo >/dev/null 2>&1; then
  echo "  cargo/rustc not found — installing via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
command -v cargo >/dev/null 2>&1 || { echo "❌ cargo still not found after install"; exit 1; }
echo "  ✓ cargo $(cargo --version)"

if ! command -v npm >/dev/null 2>&1; then
  echo "  npm not found — installing node via Homebrew..."
  command -v brew >/dev/null 2>&1 || { echo "❌ Homebrew not found — install node manually: https://nodejs.org"; exit 1; }
  brew install node
fi
echo "  ✓ npm $(npm --version)"

if ! xcode-select -p >/dev/null 2>&1; then
  echo "❌ Xcode Command Line Tools not found (needed for cargo/codesign/hdiutil)."
  echo "   Run: xcode-select --install"
  exit 1
fi
echo "  ✓ Xcode Command Line Tools"

echo "[2/4] Building Raven.app (bundle + cargo build + dmg)..."
make -C "$REPO_ROOT" desktop-dmg

DMG="$REPO_ROOT/desktop/src-tauri/target/release/bundle/dmg/Raven_0.1.0_aarch64.dmg"
[ -f "$DMG" ] || { echo "❌ DMG not found: $DMG"; exit 1; }

echo "[3/4] Quitting any running Raven instance..."
osascript -e 'tell application "Raven" to quit' >/dev/null 2>&1 || true
pkill -x raven-desktop >/dev/null 2>&1 || true
pkill -x Raven >/dev/null 2>&1 || true
sleep 1

echo "[4/4] Installing to /Applications..."
MOUNT_POINT="$(mktemp -d)/Raven"
hdiutil attach "$DMG" -mountpoint "$MOUNT_POINT" -nobrowse -quiet
trap 'hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true' EXIT

# Update the bundle in place instead of rm -rf + cp -R. Replacing the directory
# made Spotlight/LaunchServices treat it as a brand-new 5,700-file item that sat
# in the indexing queue for up to ~30 min, during which "Raven" vanished from
# Spotlight after every install. Syncing into the existing directory keeps the
# same inode/path, so the entry stays and only changed files are re-imported.
mkdir -p /Applications/Raven.app
rsync -a --delete "$MOUNT_POINT/Raven.app/" /Applications/Raven.app/
codesign --verify --deep --strict /Applications/Raven.app 2>/dev/null \
  || echo "⚠️  codesign verify failed after in-place sync (ad-hoc builds may still launch)"

hdiutil detach "$MOUNT_POINT" -quiet
trap - EXIT

# Nudge Spotlight to re-import the updated bundle metadata right away.
mdimport /Applications/Raven.app >/dev/null 2>&1 || true

echo ""
echo "✅ Raven.app installed to /Applications/Raven.app"
echo "   Launch: open /Applications/Raven.app"

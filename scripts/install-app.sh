#!/usr/bin/env bash
# Raven Desktop — DMG 다운로드 + /Applications 설치
#
#   sh ./scripts/install-app.sh          (repo 안에서)
#   또는 gh release download 후 직접 실행
set -eu

REPO="jaekanglee/RavenCode"
# 버전을 고정하면 범프할 때마다 이 파일이 낡는다 — 최신 릴리스를 조회해서 파생한다.
# RAVEN_TAG 로 특정 버전을 강제할 수 있다.
if [ -n "${RAVEN_TAG:-}" ]; then
  TAG="$RAVEN_TAG"
elif command -v gh >/dev/null 2>&1; then
  TAG="$(gh release view --repo "$REPO" --json tagName --jq .tagName)"
else
  TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
fi
[ -n "$TAG" ] || { echo "❌ 최신 릴리스 태그를 찾지 못했습니다"; exit 1; }
DMG_NAME="Raven_${TAG#v}_aarch64.dmg"
APP_NAME="Raven.app"
TMP_DMG="/tmp/$DMG_NAME"

echo "🐦 Raven Desktop 설치 ($TAG)"

# --- 1. DMG 다운로드 ---
if [ -f "$TMP_DMG" ]; then
  echo "✅ 이미 다운로드됨: $TMP_DMG"
else
  if command -v gh >/dev/null 2>&1; then
    echo "📥 gh로 다운로드..."
    if ! gh release download "$TAG" --repo "$REPO" --pattern "$DMG_NAME" --dir /tmp 2>/dev/null; then
      echo "❌ gh 다운로드 실패 — private repo 접근 권한 없음"
      echo "   해결: gh auth login (repo 소유 계정으로 로그인)"
      echo "   또는: 이 DMG를 AirDrop으로 전송"
      exit 1
    fi
  else
    URL="https://github.com/$REPO/releases/download/$TAG/$DMG_NAME"
    echo "📥 curl로 다운로드..."
    echo "   (private repo면 gh CLI 설치 권장: brew install gh)"
    curl -fSL -o "$TMP_DMG" "$URL"
  fi
fi

# --- 2. 마운트 ---
echo "💿 DMG 마운트..."
MOUNT=$(hdiutil attach "$TMP_DMG" -nobrowse | grep '/Volumes/' | awk -F'\t' '{print $NF}')
echo "   마운트: $MOUNT"

# --- 3. /Applications 복사 ---
echo "📦 $APP_NAME → /Applications ..."
if [ -d "/Applications/$APP_NAME" ]; then
  echo "   기존 앱 제거..."
  rm -rf "/Applications/$APP_NAME"
fi
cp -R "$MOUNT/$APP_NAME" /Applications/

# --- 4. 언마운트 + 정리 ---
hdiutil detach "$MOUNT" -quiet
rm -f "$TMP_DMG"

echo ""
echo "✅ 설치 완료: /Applications/$APP_NAME"
echo "   Spotlight에서 'Raven' 검색하거나 Launchpad에서 실행하세요."

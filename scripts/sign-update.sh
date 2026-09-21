#!/usr/bin/env bash
# Package + sign a tauri-plugin-updater artifact from the already-built Raven.app,
# and emit the latest.json manifest the desktop app polls at startup.
#
# Expects: make desktop-dmg already run (Raven.app present)
# Requires env — 프로젝트 루트의 .env.release 에서 자동으로 읽는다
# (없으면 셸에 이미 export 된 값을 쓴다). 최초 설정: make desktop-key-save
#   TAURI_SIGNING_PRIVATE_KEY           개인키 — 파일 경로 또는 키 문자열 둘 다 허용
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  키 비밀번호. 없으면 빈 문자열로 간주한다
#                                       (미지정 시 CLI가 TTY 프롬프트를 띄워 CI/make 에서 멈춘다)
#
# Usage: bash scripts/sign-update.sh <version> <owner/repo>
set -euo pipefail

VERSION="${1:?usage: sign-update.sh <version> <owner/repo>}"
REPO_SLUG="${2:?usage: sign-update.sh <version> <owner/repo>}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 서명 자격증명은 .env.release(gitignore 대상)에 기록해 두고 매번 재사용한다.
# 셸에 이미 export 된 값이 있으면 그쪽을 우선한다 — CI 에서 secret 으로 주입할 때를 위해.
ENV_FILE="$REPO_ROOT/.env.release"
CRED_SOURCE="shell env"
if [ -f "$ENV_FILE" ]; then
  CRED_SOURCE="$ENV_FILE"
  echo "=== Loading release env ($ENV_FILE) ==="
  _pre_key="${TAURI_SIGNING_PRIVATE_KEY:-}"
  _pre_pw="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-__unset__}"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  if [ -n "$_pre_key" ]; then export TAURI_SIGNING_PRIVATE_KEY="$_pre_key"; fi
  if [ "$_pre_pw" != "__unset__" ]; then export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$_pre_pw"; fi
fi

: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY 미설정 — 'make desktop-key-save' 로 .env.release 를 만드세요}"

TAURI_DIR="$REPO_ROOT/desktop/src-tauri"
APP_DIR="$TAURI_DIR/target/release/bundle/macos/Raven.app"
UPDATE_DIR="$TAURI_DIR/target/release/bundle/updater"
ARTIFACT="$UPDATE_DIR/Raven.app.tar.gz"
TAURI_CLI="$REPO_ROOT/dashboard/node_modules/.bin/tauri"

[ -d "$APP_DIR" ] || { echo "❌ Raven.app not found: $APP_DIR (run: make desktop-dmg)"; exit 1; }
[ -x "$TAURI_CLI" ] || { echo "❌ tauri CLI not found — run 'npm ci' in dashboard/"; exit 1; }

mkdir -p "$UPDATE_DIR"
rm -f "$ARTIFACT" "$ARTIFACT.sig"

echo "=== Packaging update artifact ==="
tar czf "$ARTIFACT" -C "$(dirname "$APP_DIR")" "Raven.app"

echo "=== Signing update artifact ==="
# -k 는 키 "문자열", -f 는 키 "파일 경로"다. 경로를 -k 로 넘기면
# "failed to decode base64 secret key" 로 죽는다. 값이 실제 파일이면 -f 를 쓴다.
# 같은 이름의 env(TAURI_SIGNING_PRIVATE_KEY)를 CLI가 -k 로 자동 인식하므로,
# -f 를 쓸 때는 그 env 를 비워 충돌을 막는다.
if [ -f "$TAURI_SIGNING_PRIVATE_KEY" ]; then
  KEY_ARGS=(-f "$TAURI_SIGNING_PRIVATE_KEY")
  echo "  key: file ($TAURI_SIGNING_PRIVATE_KEY)"
else
  KEY_ARGS=(-k "$TAURI_SIGNING_PRIVATE_KEY")
  echo "  key: inline string"
fi
# -p 를 생략하면 CLI가 TTY 프롬프트를 띄우고, make/CI 처럼 TTY 가 없으면
# "incorrect updater private key password: Device not configured" 로 실패한다.
# 비밀번호가 없는 키도 빈 문자열을 명시해야 통과한다.
if ! env -u TAURI_SIGNING_PRIVATE_KEY "$TAURI_CLI" signer sign \
  "${KEY_ARGS[@]}" \
  -p "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
  "$ARTIFACT"; then
  echo ""
  echo "❌ 서명 실패."
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
    echo "   TAURI_SIGNING_PRIVATE_KEY_PASSWORD 가 비어 있습니다."
    echo "   키에 비밀번호가 걸려 있으면 빈 값은 '틀린 비밀번호'로 취급되어"
    echo "   'Wrong password for that key' 로 실패합니다."
    echo "   → make desktop-key-save 로 비밀번호를 .env.release 에 기록하세요."
  else
    echo "   비밀번호가 키와 맞지 않습니다 (출처: $CRED_SOURCE)."
    echo "   → make desktop-key-save 로 다시 기록하세요."
  fi
  exit 1
fi

[ -f "$ARTIFACT.sig" ] || { echo "❌ 서명 파일이 생성되지 않았습니다: $ARTIFACT.sig"; exit 1; }

SIGNATURE="$(cat "$ARTIFACT.sig")"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$UPDATE_DIR/latest.json" << JSON
{
  "version": "$VERSION",
  "notes": "See GitHub release notes.",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIGNATURE",
      "url": "https://github.com/$REPO_SLUG/releases/download/v$VERSION/Raven.app.tar.gz"
    }
  }
}
JSON

echo ""
echo "=== Done ==="
echo "  artifact:  $ARTIFACT"
echo "  signature: $ARTIFACT.sig"
echo "  manifest:  $UPDATE_DIR/latest.json"

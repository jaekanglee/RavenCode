#!/usr/bin/env bash
# 업데이터 서명 키 경로 + 비밀번호를 .env.release 에 기록한다 (최초 1회).
# 기록 전에 실제로 서명을 해 봐서 비밀번호가 맞는지 검증하고, 틀리면 저장하지 않는다.
#
# Usage: bash scripts/save-release-key.sh   (또는 make desktop-key-save)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.release"
TAURI_CLI="$REPO_ROOT/dashboard/node_modules/.bin/tauri"
DEFAULT_KEY="$HOME/.tauri/raven.key"

[ -x "$TAURI_CLI" ] || { echo "❌ tauri CLI가 없습니다 — dashboard/ 에서 'npm ci' 먼저 실행하세요"; exit 1; }
[ -t 0 ] || { echo "❌ 대화형 입력이 필요합니다. 터미널에서 직접 실행하세요."; exit 1; }

if [ -f "$ENV_FILE" ]; then
  printf "⚠️  %s 가 이미 있습니다. 덮어쓸까요? [y/N] " "$ENV_FILE"
  read -r ans
  case "$ans" in y|Y|yes|YES) ;; *) echo "취소했습니다."; exit 0 ;; esac
fi

printf "개인키 경로 [%s]: " "$DEFAULT_KEY"
read -r KEY_PATH
KEY_PATH="${KEY_PATH:-$DEFAULT_KEY}"
[ -f "$KEY_PATH" ] || { echo "❌ 키 파일이 없습니다: $KEY_PATH"; exit 1; }

# 비밀번호는 화면에 찍지 않는다. 비밀번호 없는 키면 그냥 Enter.
printf "키 비밀번호 (없으면 Enter): "
stty -echo
read -r KEY_PW
stty echo
printf "\n"

# 저장 전에 실전과 동일한 경로로 서명을 시도한다 — 릴리스 막판에 터지는 것보다 지금 터지는 게 낫다.
echo "🔎 키/비밀번호 검증 중..."
TMPF="$(mktemp -t raven-signcheck)"
trap 'rm -f "$TMPF" "$TMPF.sig"' EXIT
printf 'raven\n' > "$TMPF"
if ! env -u TAURI_SIGNING_PRIVATE_KEY "$TAURI_CLI" signer sign \
       -f "$KEY_PATH" -p "$KEY_PW" "$TMPF" >/dev/null 2>&1; then
  echo "❌ 비밀번호가 키와 맞지 않습니다. $ENV_FILE 을 저장하지 않았습니다."
  echo "   다시 시도: make desktop-key-save"
  exit 1
fi

# 비밀번호에 따옴표·$·공백이 있어도 깨지지 않도록 작은따옴표 escape 후 기록.
umask 077
KEY_PATH="$KEY_PATH" KEY_PW="$KEY_PW" ENV_FILE="$ENV_FILE" python3 - <<'PY'
import os

def q(v: str) -> str:
    # POSIX 셸 작은따옴표 escape: ' -> '\''
    return "'" + v.replace("'", "'\\''") + "'"

lines = [
    "# make desktop-key-save 로 생성됨. gitignore 대상 — 절대 커밋하지 말 것.",
    "# 템플릿/설명: .env.example.release",
    f"TAURI_SIGNING_PRIVATE_KEY={q(os.environ['KEY_PATH'])}",
    f"TAURI_SIGNING_PRIVATE_KEY_PASSWORD={q(os.environ['KEY_PW'])}",
    "",
]
with open(os.environ["ENV_FILE"], "w") as f:
    f.write("\n".join(lines))
PY
chmod 600 "$ENV_FILE"

echo "✅ 검증 통과 — $ENV_FILE 에 저장했습니다 (mode 600)."
echo "   이제 'make desktop-release' 만 실행하면 서명까지 자동으로 진행됩니다."

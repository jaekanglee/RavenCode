#!/usr/bin/env bash
# 데스크톱 앱 버전 범프 — SOT 파일들을 한 번에, 일관되게 올린다.
#
#   bash scripts/bump-desktop-version.sh 0.2.0
#   (또는 make desktop-version VERSION=0.2.0)
#
# 왜 스크립트인가
# --------------
# 버전이 tauri.conf.json / Cargo.toml / Cargo.lock 에 흩어져 있어서 손으로 올리면
# 하나를 빠뜨리기 쉽다. 특히 tauri.conf.json 의 값은 Tauri updater 가 "설치본 버전"
# 으로 쓰는 값이라, latest.json 의 버전과 어긋나면 업데이트가 조용히 안 뜨거나
# 무한 재설치가 된다. DMG 이름·Info.plist·업로드 경로는 모두 tauri.conf.json 에서
# 파생되므로(scripts/make-dmg.sh, Makefile) 여기만 맞으면 나머지는 따라온다.
#
# 태그는 만들지 않는다 — 범프 커밋이 먼저 있어야 올바른 커밋에 태그가 붙는다.
# 다음에 칠 명령을 출력해 준다.
set -euo pipefail

VERSION="${1:?usage: bump-desktop-version.sh <x.y.z>}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ x.y.z 형식이어야 합니다: $VERSION"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_CONF="$REPO_ROOT/desktop/src-tauri/tauri.conf.json"
CARGO_TOML="$REPO_ROOT/desktop/src-tauri/Cargo.toml"
CARGO_LOCK="$REPO_ROOT/desktop/src-tauri/Cargo.lock"

CURRENT="$(python3 -c "import json;print(json.load(open('$TAURI_CONF'))['version'])")"
echo "현재: $CURRENT  →  새 버전: $VERSION"

if [ "$CURRENT" = "$VERSION" ]; then
  echo "❌ 이미 $VERSION 입니다."
  exit 1
fi
# 다운그레이드 방지 — updater 는 버전이 내려가면 업데이트를 안 띄운다.
LOWEST="$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | head -1)"
if [ "$LOWEST" = "$VERSION" ]; then
  echo "❌ 다운그레이드입니다 ($CURRENT → $VERSION). 의도한 거라면 수동으로 수정하세요."
  exit 1
fi
if git -C "$REPO_ROOT" rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "❌ 로컬에 태그 v$VERSION 이 이미 존재합니다."
  # 원격에 없는데 로컬에만 남아 있는 경우가 흔하다 — 다른 머신에서 잘못 만든 태그를
  # 원격에서만 지웠을 때. 어느 쪽인지 알려줘야 사용자가 판단할 수 있다.
  if git -C "$REPO_ROOT" ls-remote --tags origin "refs/tags/v$VERSION" 2>/dev/null | grep -q .; then
    echo "   원격에도 존재합니다 — 이미 배포된 버전일 수 있으니 다른 번호를 쓰세요."
  else
    echo "   원격에는 없습니다(로컬 잔재). 지우고 다시 시도하세요:"
    echo "     git tag -d v$VERSION"
  fi
  exit 1
fi

python3 - "$VERSION" "$TAURI_CONF" "$CARGO_TOML" "$CARGO_LOCK" << 'PY'
import re
import sys

version, tauri_conf, cargo_toml, cargo_lock = sys.argv[1:5]


def sub_once(path, pattern, replacement, label):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    new_text, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        raise SystemExit(f"❌ {label}: 버전 줄을 찾지 못했습니다 ({path})")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(new_text)
    print(f"  ✓ {label}")


sub_once(tauri_conf, r'^(\s*"version"\s*:\s*")[^"]+(")', rf'\g<1>{version}\g<2>', "tauri.conf.json")
sub_once(cargo_toml, r'^(version\s*=\s*")[^"]+(")', rf'\g<1>{version}\g<2>', "Cargo.toml")
# Cargo.lock 은 raven-desktop 패키지 블록만 건드린다.
sub_once(
    cargo_lock,
    r'^(name = "raven-desktop"\nversion = ")[^"]+(")',
    rf'\g<1>{version}\g<2>',
    "Cargo.lock",
)
PY

echo ""
echo "=== 범프 완료 — 다음 순서로 릴리스 ==="
echo "  git add -A && git commit -m \"chore(desktop): v$VERSION\""
echo "  git tag -a \"v$VERSION\" -m \"Raven v$VERSION\""
echo "  git push origin HEAD --tags"
echo "  export TAURI_SIGNING_PRIVATE_KEY=<개인키 경로>"
echo "  make desktop-release"

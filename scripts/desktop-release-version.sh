#!/usr/bin/env bash
# 데스크톱 릴리스 버전 정하기 — `make desktop-release`의 첫 단계.
#
# 현재 버전(tauri.conf.json)을 보여주고 몇 버전으로 올릴지 묻는다. 입력한 버전으로
# bump-desktop-version.sh를 돌린 뒤 버전 파일만 커밋하고, 태그를 만들어 원격에 올린다.
# 그래야 뒤따르는 preflight(태그가 원격에 있어야 함)와 빌드가 새 버전으로 돈다.
# 이 단계가 없을 때는 범프를 잊으면 같은 버전이 --clobber로 계속 다시 올라갔다.
#
#   - Enter만 누르면 패치 버전 +1 (0.3.0 → 0.3.1)
#   - 현재 버전을 그대로 입력하면 범프 없이 같은 버전을 다시 올린다 (업로드 실패 재시도용)
#   - VERSION=x.y.z 를 주면 묻지 않는다 (make desktop-release VERSION=0.4.0)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_TAURI="desktop/src-tauri"

CURRENT="$(python3 -c "import json;print(json.load(open('$REPO_ROOT/$SRC_TAURI/tauri.conf.json'))['version'])")"
IFS=. read -r MAJOR MINOR PATCH <<< "$CURRENT"
NEXT="$MAJOR.$MINOR.$((PATCH + 1))"

VERSION="${VERSION:-}"
if [ -z "$VERSION" ]; then
  # make가 stdin을 넘겨주지 않을 수 있어 터미널에서 직접 읽는다.
  if ! printf '현재 데스크톱 버전은 %s 입니다. 몇 버전으로 올릴까요? [%s]: ' "$CURRENT" "$NEXT" 2>/dev/null > /dev/tty; then
    echo "❌ 버전을 물어볼 터미널이 없습니다 — make desktop-release VERSION=x.y.z 로 지정하세요."
    exit 1
  fi
  read -r VERSION < /dev/tty || true
  VERSION="${VERSION:-$NEXT}"
fi
VERSION="${VERSION#v}"

if [ "$VERSION" = "$CURRENT" ]; then
  echo "↻ 범프 없이 $CURRENT 를 다시 릴리스합니다."
  exit 0
fi

# 형식·다운그레이드·태그 중복 검사는 범프 스크립트가 한다.
RAVEN_RELEASE_FLOW=1 bash "$REPO_ROOT/scripts/bump-desktop-version.sh" "$VERSION"

cd "$REPO_ROOT"
# 버전 파일만 커밋한다 — 다른 작업 중인 변경이 릴리스 커밋에 섞이지 않게.
git commit -m "chore(desktop): v$VERSION" -- \
  "$SRC_TAURI/tauri.conf.json" "$SRC_TAURI/Cargo.toml" "$SRC_TAURI/Cargo.lock"
git tag -a "v$VERSION" -m "Raven v$VERSION"
# --tags 대신 이 태그만 — 로컬에 남은 다른 태그가 딸려 올라가지 않게.
git push origin HEAD "refs/tags/v$VERSION"
echo "✅ v$VERSION 커밋·태그·푸시 완료 — 빌드를 이어갑니다."

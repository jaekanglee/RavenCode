#!/usr/bin/env bash
# scripts/restart-all.sh — Raven local stack 완전 재시작 (모든 캐시 비움)
#
# v0.7.60+ 용도: Docker 무관, 로컬 host stack (./raven.sh)만 다룬다.
# 기본 `make restart` (= ./raven.sh restart)는 PID만 재시작 — stale cache
# (Vite pre-bundle, python __pycache__, pytest cache) 남는다.
# 이 스크립트는 그 캐시를 전부 비우고 다시 띄움. 디자인 시스템 토큰 / CSS /
# node_modules 의존성 변경 후 UI가 갱신 안 될 때 사용.
#
# v0.7.83+: ./raven.sh가 API(8765) + MCP(8766) + Dashboard(5173) lifecycle
# 모두 관리. → 이 스크립트는 raven.sh stop/start를 호출하므로 MCP lifecycle
# 자동 처리됨 (silent stale 방지, AGENTS.md §9 hotfix 정책).
# 포트 매트릭스 (v0.7.83+):
#   API:       8765 (RAVEN_API_PORT) — Dashboard가 Vite proxy로 호출
#   MCP:       8766 (RAVEN_MCP_PORT, v0.7.81+ HTTP only 정책)
#   Dashboard: 5173 (Vite dev)
#
# 비우는 캐시:
#   - dashboard/node_modules/.vite/   (Vite pre-bundle / optimizeDeps)
#   - dashboard/node_modules/.cache/  (Vite misc)
#   - **/__pycache__/                  (Python bytecode, raven/ dashboard/ scripts/)
#   - .pytest_cache/, scripts/.pytest_cache/
#   - tmp/api.log, tmp/mcp.log, tmp/dashboard.log   (구 로그)
#
# 안 비우는 것 (의도적):
#   - wiki.db                          (백엔드 hot state — 필요시 --wipe-db 옵션)
#   - node_modules/                    (의존성 — npm install 안 함, 시간)
#   - scripts/.venv/                   (Python venv — 재설치 안 함)
#   - 사용자 vault 데이터 (RAVEN_VAULTS_DIR)
#
# 사용법:
#   ./scripts/restart-all.sh                  # 캐시 비움 + 재시작
#   ./scripts/restart-all.sh --no-cache       # 캐시 안 비우고 재시작만 (raven.sh restart와 동일)
#   ./scripts/restart-all.sh --wipe-db        # 추가로 wiki.db 삭제 (bootstrap 재생성)
#   ./scripts/restart-all.sh --help
#
# 흐름:
#   1. raven.sh stop           (PID 정리)
#   2. 캐시 wipe (옵션에 따라)
#   3. raven.sh start          (새 PID로 시작)
#   4. 헬스체크 (최대 30s)
#
# 주의:
#   - 첫 vite 재시작은 pre-bundle 다시 하느라 ~10-20s 더 걸릴 수 있음
#   - PWA service worker 캐시(브라우저 측)는 이 스크립트로 못 지움.
#     사용자가 Dashboard에서 Cmd+Shift+R (강력 새로고침) 필요할 수 있음.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Load environment configuration if present
if [ -f .env ]; then
  set -a
  source .env
  set +a
  # Clean up Tailscale warning logs that might end up in the host variables
  if [ -n "${RAVEN_DASHBOARD_HOST:-}" ]; then
    RAVEN_DASHBOARD_HOST=$(echo "$RAVEN_DASHBOARD_HOST" | tail -n 1 | xargs)
  fi
  if [ -n "${RAVEN_MCP_HOST:-}" ]; then
    RAVEN_MCP_HOST=$(echo "$RAVEN_MCP_HOST" | tail -n 1 | xargs)
  fi
fi

WIPE_CACHE=true
WIPE_DB=false

for arg in "$@"; do
    case "$arg" in
        --no-cache)   WIPE_CACHE=false ;;
        --wipe-db)    WIPE_DB=true ;;
        --help|-h)
            sed -n '2,20p' "$0" | sed 's/^# //; s/^#//'
            exit 0
            ;;
        *) echo "❌ unknown flag: $arg (--help로 사용법 확인)"; exit 1 ;;
    esac
done

# ─── 1. 사전 헬스체크 ─────────────────────────────────────
echo "🔍 사전 헬스체크…"

[[ -f raven.sh ]] || { echo "❌ raven.sh not found (run from repo root)"; exit 1; }

# venv 검증 (재설치는 안 함 — 의도적)
if [[ ! -d scripts/.venv ]] && ! command -v uv >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
    echo "❌ python 실행 환경 없음 (scripts/.venv, uv, python3 모두 없음)"
    exit 1
fi

# node_modules 검증 (npm install 안 함)
if [[ ! -d dashboard/node_modules ]]; then
    echo "❌ dashboard/node_modules 없음 → cd dashboard && npm install 먼저"
    exit 1
fi

echo "   ✅ raven.sh + dashboard/node_modules OK"
echo

# ─── 2. 캐시 비우기 ─────────────────────────────────────
WIPE_LIST=()

if $WIPE_CACHE; then
    # Vite 캐시
    [[ -d dashboard/node_modules/.vite ]] && WIPE_LIST+=(dashboard/node_modules/.vite)
    [[ -d dashboard/node_modules/.cache ]] && WIPE_LIST+=(dashboard/node_modules/.cache)

    # Python bytecode
    while IFS= read -r -d '' d; do
        WIPE_LIST+=("$d")
    done < <(find . -type d -name __pycache__ \
             -not -path './scripts/.venv/*' \
             -not -path './.git/*' \
             -not -path './dashboard/node_modules/*' \
             -print0 2>/dev/null)

    # pytest 캐시
    [[ -d .pytest_cache ]]      && WIPE_LIST+=(.pytest_cache)
    [[ -d scripts/.pytest_cache ]] && WIPE_LIST+=(scripts/.pytest_cache)

    # 구 로그 (PID 파일은 stop에서 정리되므로 손대지 않음)
    [[ -f tmp/api.log ]]       && WIPE_LIST+=(tmp/api.log)
    [[ -f tmp/mcp.log ]]        && WIPE_LIST+=(tmp/mcp.log)
    [[ -f tmp/dashboard.log ]] && WIPE_LIST+=(tmp/dashboard.log)

    if [[ ${#WIPE_LIST[@]} -eq 0 ]]; then
        echo "🧹 캐시 비우기… 없음 (이미 clean)"
    else
        echo "🧹 캐시 비우기… (${#WIPE_LIST[@]} 항목)"
        for path in "${WIPE_LIST[@]}"; do
            rm -rf "$path" 2>/dev/null || true
            printf "   🗑️  %s\n" "$path"
        done
    fi
else
    echo "⏭  --no-cache 지정 → 캐시 wipe 건너뜀"
fi
echo

# ─── 3. wiki-db 옵션 처리 ───────────────────────────────
if $WIPE_DB; then
    if [[ -f wiki.db ]]; then
        echo "🗑️  wiki.db 삭제 (bootstrap 재생성)…"
        rm -f wiki.db wiki.db-journal wiki.db-wal wiki.db-shm wiki.db.backup
    else
        echo "   wiki.db 없음 — skip"
    fi
    echo
fi

# ─── 4. 재시작 ─────────────────────────────────────
echo "🛑 raven.sh stop…"
./raven.sh stop || true
echo

echo "🚀 raven.sh start…"
./raven.sh start
echo

# ─── 5. 헬스체크 (최대 30s) ─────────────────────────────
echo "🩺 헬스체크 (최대 30s)…"
HEALTH_OK=true

check_http() {
    local label="$1"
    local url="$2"
    local expect="$3"
    local ok=false
    local status
    for i in $(seq 1 15); do
        status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$url" 2>/dev/null || echo "000")
        if [[ "$status" =~ ^($expect)$ ]]; then
            ok=true
            break
        fi
        sleep 2
    done
    if $ok; then
        printf "   ✅ %-10s %s → %s\n" "$label" "$url" "$status"
    else
        printf "   ❌ %-10s %s → %s (30s 대기 후 실패)\n" "$label" "$url" "$status"
        HEALTH_OK=false
    fi
}

# Issue #67: /api needs a token from loopback too — /healthz is the token-free liveness check.
check_http "api"       "http://127.0.0.1:${RAVEN_API_PORT:-8765}/healthz" "200"
check_http "dashboard" "http://${RAVEN_DASHBOARD_HOST:-localhost}:${RAVEN_DASHBOARD_PORT:-5173}/"          "200"
echo

# ─── 6. 실패 시 로그 출력 ─────────────────────────────
if ! $HEALTH_OK; then
    echo "⚠️  일부 서비스 헬스체크 실패 — 최근 로그:"
    echo "────────────────────────────────────"
    [[ -f tmp/api.log ]]       && { echo; echo "── api.log (last 30 lines) ──";       tail -30 tmp/api.log; }
    [[ -f tmp/mcp.log ]]        && { echo; echo "── mcp.log (last 30 lines) ──";        tail -30 tmp/mcp.log; }
    [[ -f tmp/dashboard.log ]] && { echo; echo "── dashboard.log (last 30 lines) ──"; tail -30 tmp/dashboard.log; }
    echo "────────────────────────────────────"
    exit 1
fi

# ─── 7. 성공 보고 ─────────────────────────────────────
echo "✨ Raven 완전 재시작 완료 (캐시 wipe)"
echo "   • API       → http://127.0.0.1:8765"
echo "   • Dashboard → http://localhost:5173"
echo
echo "📝 사용 팁:"
echo "   - Dashboard PWA 캐시가 stale이면 Cmd+Shift+R (강력 새로고침)"
echo "   - 로그 follow: tail -f tmp/api.log, tmp/mcp.log, 또는 tmp/dashboard.log"
echo "   - 상태 확인: ./raven.sh status"
#!/usr/bin/env bash
# raven.sh — Control script for starting, stopping, and restarting the Raven local host stack.
#
# v0.7.83+: API → 8765 (그대로), MCP → 8766, Dashboard → 5173 (v0.7.81+ HTTP only).
# MCP lifecycle 통합 — silent stale 방지 (v0.7.82 hotfix). 운영자가 lifecycle
# 수동 관리 안 해도 `make restart-all` / `./raven.sh restart`가 자동 처리.
#
# 포트 매트릭스 (v0.7.83+, v0.7.148+ team MCP 추가):
#   API:       8765 (RAVEN_API_PORT) — Dashboard가 Vite proxy로 호출
#   MCP:       8766 (RAVEN_MCP_PORT, v0.7.81+ HTTP only 정책) — 운영자용
#   MCP(team): 8767 (RAVEN_MCP_TEAM_PORT, RAVEN_MCP_TEAM_ENABLE=true 시에만 기동)
#              — 운영자(admin)와 권한 분리된 팀원용 인스턴스 (기본 mode=write)
#   Dashboard: 5173 (RAVEN_DASHBOARD_PORT, Vite dev)
#
# Host 바인딩은 .env(git-ignored)에서 머신별로 설정 (.env.example.company / .env.example.house 참고) —
# 인증 체계가 없으므로 신뢰 수준에 맞게 RAVEN_MCP_HOST / RAVEN_MCP_TEAM_HOST /
# RAVEN_DASHBOARD_HOST 를 머신마다 다르게 둘 것.
#
# 데스크톱 앱과의 관계 (v0.7.184+)
#   Raven.app도 같은 포트 매트릭스로 API 8765 + MCP 8766을 서빙한다. 외부 에이전트의
#   1차 창구는 데스크톱 앱이다 — 운영자 머신에서 상시 떠 있는 게 그쪽이기 때문.
#   이 스크립트는 서버/헤드리스 배포용이며, 포트가 이미 점유돼 있으면 해당 서비스를
#   건너뛰고 경고만 낸다(port_in_use). PID 파일만 보던 이전 버전은 데스크톱 앱이
#   점유한 포트에 계속 재기동을 시도해 bind 실패로 조용히 죽었다.
#
# Exit on error
set -e

# Directory where this script resides
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# Auto-load .env if present (Git-ignored. Set RAVEN_MCP_MODE etc. without
# shell-wide rc). v0.7.88+: enables per-project configuration. Shell env
# still wins (later assignment after source).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PID_DIR="tmp"
API_PID="$PID_DIR/api.pid"
DASHBOARD_PID="$PID_DIR/dashboard.pid"
MCP_PID="$PID_DIR/mcp.pid"
MCP_TEAM_PID="$PID_DIR/mcp_team.pid"

API_PORT="${RAVEN_API_PORT:-8765}"
MCP_PORT="${RAVEN_MCP_PORT:-8766}"
MCP_MODE="${RAVEN_MCP_MODE:-read}"
MCP_HOST="${RAVEN_MCP_HOST:-127.0.0.1}"
DASHBOARD_PORT="${RAVEN_DASHBOARD_PORT:-5173}"

# v0.7.148+: 팀원용 2번째 MCP 인스턴스 — 운영자(admin, 위 MCP_*)와 권한 분리.
# RAVEN_MCP_TEAM_ENABLE=true 로 .env에서 켤 것 (기본 꺼짐 — solo 사용 시 불필요한 프로세스 방지).
MCP_TEAM_ENABLE="${RAVEN_MCP_TEAM_ENABLE:-false}"
MCP_TEAM_PORT="${RAVEN_MCP_TEAM_PORT:-8767}"
MCP_TEAM_MODE="${RAVEN_MCP_TEAM_MODE:-write}"
MCP_TEAM_HOST="${RAVEN_MCP_TEAM_HOST:-0.0.0.0}"

mkdir -p "$PID_DIR"

# Find python runner
if [ -d "scripts/.venv" ]; then
  PY="scripts/.venv/bin/python"
elif command -v uv &> /dev/null; then
  PY="uv run python"
else
  PY="python3"
fi

# v0.7.184+: PID 파일은 "우리가 띄운 프로세스"만 안다. 데스크톱 앱(Raven.app)이
# 같은 포트를 이미 쓰고 있으면 여기서 또 띄워봐야 bind 실패로 조용히 죽고, PID
# 파일에는 죽은 PID만 남는다. 포트 수준에서 먼저 확인해 양보한다.
port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# status() helper: PID의 process args에서 --mode 값을 추출 (env 의존 0).
# silent hotfix (v0.7.85+): status() 호출 시 RAVEN_MCP_MODE env가 export되지 않으면
# $MCP_MODE가 fallback(read)로 표시되는 버그. 실제 process args에서 직접 파싱.
mcp_mode_from_pid() {
  local pid="$1"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    echo ""
    return
  fi
  # macOS ps: -o args= 형식 / Linux ps: -o cmd= 형식 모두 호환
  ps -p "$pid" -o args= 2>/dev/null | tr " " "\n" | grep -A1 "^--mode$" | tail -1
}

status() {
  local api_running=false
  local db_running=false
  local mcp_running=false
  local mcp_mode_display=""

  if [ -f "$API_PID" ] && kill -0 $(cat "$API_PID") 2>/dev/null; then
    api_running=true
  fi
  if [ -f "$DASHBOARD_PID" ] && kill -0 $(cat "$DASHBOARD_PID") 2>/dev/null; then
    db_running=true
  fi
  if [ -f "$MCP_PID" ] && kill -0 $(cat "$MCP_PID") 2>/dev/null; then
    mcp_running=true
    mcp_mode_display="$(mcp_mode_from_pid "$(cat "$MCP_PID")")"
  fi

  local mcp_team_running=false
  local mcp_team_mode_display=""
  if [ -f "$MCP_TEAM_PID" ] && kill -0 $(cat "$MCP_TEAM_PID") 2>/dev/null; then
    mcp_team_running=true
    mcp_team_mode_display="$(mcp_mode_from_pid "$(cat "$MCP_TEAM_PID")")"
  fi

  if $api_running && $db_running && $mcp_running; then
    echo "🟢 Raven is RUNNING"
    echo "   • API PID: $(cat "$API_PID")       Url: http://127.0.0.1:$API_PORT"
    echo "   • Dashboard PID: $(cat "$DASHBOARD_PID") Url: http://localhost:$DASHBOARD_PORT"
    echo "   • MCP PID: $(cat "$MCP_PID")          Url: http://$MCP_HOST:$MCP_PORT/mcp (mode=${mcp_mode_display:-?})"
    if $mcp_team_running; then
      echo "   • MCP(team) PID: $(cat "$MCP_TEAM_PID")     Url: http://$MCP_TEAM_HOST:$MCP_TEAM_PORT/mcp (mode=${mcp_team_mode_display:-?})"
    fi
    return 0
  elif $api_running || $db_running || $mcp_running || $mcp_team_running; then
    echo "🟡 Raven is PARTIALLY RUNNING (API: $api_running, Dashboard: $db_running, MCP: $mcp_running, MCP-team: $mcp_team_running)"
    return 1
  else
    echo "🔴 Raven is STOPPED"
    return 2
  fi
}

start() {
  # API (8765)
  if [ -f "$API_PID" ] && kill -0 $(cat "$API_PID") 2>/dev/null; then
    echo "⚠️  API server is already running (PID: $(cat "$API_PID"))"
  elif port_in_use "$API_PORT"; then
    echo "⏭️  API port $API_PORT is already served by another process (Raven.app?) — skipping."
  else
    echo "🚀 Starting API server in background on port $API_PORT..."
    PYTHONPATH=. $PY -m raven.api > tmp/api.log 2>&1 &
    echo $! > "$API_PID"
  fi

  # MCP (8766, HTTP only, v0.7.81+)
  if [ -f "$MCP_PID" ] && kill -0 $(cat "$MCP_PID") 2>/dev/null; then
    echo "⚠️  MCP server is already running (PID: $(cat "$MCP_PID"))"
  elif port_in_use "$MCP_PORT"; then
    echo "⏭️  MCP port $MCP_PORT is already served by another process (Raven.app?) — skipping."
    echo "    데스크톱 앱이 MCP를 서빙 중이면 그쪽이 외부 에이전트 창구다."
  else
    echo "🚀 Starting MCP server in background on port $MCP_PORT (mode=$MCP_MODE, host=$MCP_HOST)..."
    PYTHONPATH=. $PY -m raven.mcp.cli \
      --transport http --host "$MCP_HOST" --port "$MCP_PORT" --mode "$MCP_MODE" > tmp/mcp.log 2>&1 &
    echo $! > "$MCP_PID"
  fi

  # MCP team instance (v0.7.148+, opt-in via RAVEN_MCP_TEAM_ENABLE=true)
  if [ "$MCP_TEAM_ENABLE" = "true" ]; then
    if [ -f "$MCP_TEAM_PID" ] && kill -0 $(cat "$MCP_TEAM_PID") 2>/dev/null; then
      echo "⚠️  MCP(team) server is already running (PID: $(cat "$MCP_TEAM_PID"))"
    elif port_in_use "$MCP_TEAM_PORT"; then
      echo "⏭️  MCP(team) port $MCP_TEAM_PORT is already served by another process — skipping."
    else
      echo "🚀 Starting MCP(team) server in background on port $MCP_TEAM_PORT (mode=$MCP_TEAM_MODE, host=$MCP_TEAM_HOST)..."
      PYTHONPATH=. $PY -m raven.mcp.cli \
        --transport http --host "$MCP_TEAM_HOST" --port "$MCP_TEAM_PORT" --mode "$MCP_TEAM_MODE" > tmp/mcp_team.log 2>&1 &
      echo $! > "$MCP_TEAM_PID"
    fi
  fi

  # Dashboard (5173)
  if [ -f "$DASHBOARD_PID" ] && kill -0 $(cat "$DASHBOARD_PID") 2>/dev/null; then
    echo "⚠️  Dashboard is already running (PID: $(cat "$DASHBOARD_PID"))"
  else
    echo "🚀 Starting Dashboard Vite dev server in background on port $DASHBOARD_PORT..."
    cd dashboard
    npm run dev > ../tmp/dashboard.log 2>&1 &
    echo $! > "../$DASHBOARD_PID"
    cd ..
  fi

  sleep 2
  status
}

stop() {
  echo "🛑 Stopping Raven local host stack..."
  if [ -f "$API_PID" ]; then
    local pid=$(cat "$API_PID")
    echo "   Stopping API (PID: $pid)..."
    kill "$pid" 2>/dev/null || true
    rm -f "$API_PID"
  fi
  if [ -f "$MCP_PID" ]; then
    local pid=$(cat "$MCP_PID")
    echo "   Stopping MCP (PID: $pid)..."
    kill "$pid" 2>/dev/null || true
    rm -f "$MCP_PID"
  fi
  if [ -f "$MCP_TEAM_PID" ]; then
    local pid=$(cat "$MCP_TEAM_PID")
    echo "   Stopping MCP(team) (PID: $pid)..."
    kill "$pid" 2>/dev/null || true
    rm -f "$MCP_TEAM_PID"
  fi
  if [ -f "$DASHBOARD_PID" ]; then
    local pid=$(cat "$DASHBOARD_PID")
    echo "   Stopping Dashboard (PID: $pid)..."
    kill "$pid" 2>/dev/null || true
    rm -f "$DASHBOARD_PID"
  fi
  echo "🔴 Stopped."
}

restart() {
  stop
  sleep 1
  start
}

case "$1" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    restart
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
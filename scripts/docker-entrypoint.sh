#!/usr/bin/env bash
# docker-entrypoint.sh — 컨테이너 안에서 4 진입점 라우팅.
# CMD 환경변수로 진입점 전환 (api | mcp-http | mcp-stdio | dashboard | cli).
set -e

# v0.7.19+: vault path 정합성 보장
# - Python code는 $WIKI_VAULTS_DIR 환경변수 사용 (registry.py:4, 10, 34)
# - entrypoint에서 export → 자식 프로세스 (python -m raven.*) 에게 상속
# - 환경변수 override 가능 (사용자 .env에 WIKI_VAULTS_DIR 설정)
# - RAVEN_VAULTS_DIR은 "호스트 절대 경로"를 보존 (Dashboard 경로 표시용)
# - v0.7.19+: default 경로 = $HOME/Raven (컨테이너 안, bind mount로 호스트 ~/Raven에 연결)
WIKI_VAULTS_DIR="${WIKI_VAULTS_DIR:-${RAVEN_VAULTS_DIR:-$HOME/Raven}}"
RAVEN_VAULTS_DIR="${RAVEN_VAULTS_DIR:-$WIKI_VAULTS_DIR}"
export WIKI_VAULTS_DIR RAVEN_VAULTS_DIR

# v0.7.19+: vault 폴더 검증 (bind mount가 호스트 폴더 보장)
# - 정상: 호스트 ~/Raven 존재 → 컨테이너 안 $WIKI_VAULTS_DIR mount → 즉시 사용 가능
# - 비정상: 호스트 폴더 없음 → mount는 빈 디렉토리 → registry.json 없음 → vault 0건
#   → 사용자 안내 (mkdir 권장)
if [ ! -d "$WIKI_VAULTS_DIR" ]; then
    echo "⚠️  vault 폴더 없음: $WIKI_VAULTS_DIR"
    echo "   권장: mkdir -p \"$WIKI_VAULTS_DIR\" (호스트에서 실행)"
fi

case "$1" in
    api)
        exec python -m raven.api --host "$HOST" --port "$PORT_API"
        ;;
    mcp-http)
        # Issue #26: 인증 게이트(raven.mcp.auth.LanTokenAuth) 뒤에서 뜬다. 컨테이너에서는
        #   포트 매핑을 거친 클라이언트가 게이트웨이 IP로 보이므로 컨테이너 밖에서 오는
        #   요청은 모두 Bearer 토큰이 필요하다 (docker compose exec api python -m raven.cli
        #   mcp token add <이름>). 컨테이너 안 loopback(healthcheck)만 토큰 없이 통과.
        #   인증을 끄는 옵션은 없다.
        #
        # uvicorn 옵션은 cli.py가 내부에서 정한다 — Core API와 같은 serve_kwargs()
        #   (proxy_headers=False, X-Forwarded-For는 loopback 프록시가 보낸 것만 게이트가 해석).
        #   예전의 forwarded_allow_ips='*' / proxy_headers=True는 클라이언트 주소 위조를
        #   허용해서 #26에서 없앴다.
        # → entrypoint에서 Typer가 모르는 `--forwarded-allow-ips` /
        #   `--proxy-headers` 를 던지지 마세요. wiki-mcp가 인식 못 해
        #   `unrecognized arguments`로 exit 2 → 컨테이너 Restarting 루프.
        exec python -m raven.mcp.cli --transport http --host "$HOST" --port "$PORT_MCP_HTTP"
        ;;
    mcp-stdio)
        exec python -m raven.mcp.cli --transport stdio
        ;;
    dashboard)
        # v0.7.22+: python http.server → spa_server.py (SPA fallback + API proxy).
        # python http.server는 /vault/new 같은 React Router 경로를 새로고침하면
        # dist/vault/new 파일이 없어서 404 반환.
        # spa_server.py: 파일 없으면 index.html fallback + /api/* → API 서버 프록시.
        # 컨테이너 내부: api 서비스는 raven-net으로 "api" hostname 으로 접근 가능.
        API_HOST="${API_HOST:-api}"
        exec python /usr/local/bin/spa_server.py \
            --port "$PORT_DASHBOARD" \
            --bind "$HOST" \
            --dir /app/dashboard/dist \
            --api-url "http://${API_HOST}:${PORT_API:-8765}"
        ;;
    cli)
        # CLI는 대화형 — exec로 사용자에게 위임
        shift
        exec python -m raven.cli "$@"
        ;;
    *)
        echo "Usage: docker-entrypoint.sh {api|mcp-http|mcp-stdio|dashboard|cli} [args...]"
        exit 1
        ;;
esac

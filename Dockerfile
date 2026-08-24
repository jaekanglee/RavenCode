# Raven Dockerfile — multi-vault wiki engine + CLI + API + Dashboard + MCP
# v0.7.17+ — 빌드 단순화 (editable install ❌, 의존성 직접 install)
#
# 전략: 두 stage 빌드
#   stage 1: dashboard build (Node 20) → 정적 산출물
#   stage 2: runtime (Python 3.11-slim + 정적 dashboard)
#
# 4 진입점 (모두 background):
#   - CLI:  on-demand (docker exec)
#   - API:  :8765 (HTTP)
#   - MCP:  :8766 (HTTP transport) + stdio (docker exec)
#   - UI:   :5173 (정적 http.server)

# ──────────────────────────────────────────────────────────────────────
# Stage 1: Dashboard build (Node 20)
# ──────────────────────────────────────────────────────────────────────
FROM node:20-slim AS dashboard-build

WORKDIR /app/dashboard

COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY dashboard/ ./
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

# ──────────────────────────────────────────────────────────────────────
# Stage 2: Runtime (Python 3.11-slim)
# ──────────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

# v0.7.36+: GIT_SHA 핀. compose에서 ${GIT_SHA:-latest} 전달.
# → 컨테이너 안에서 /app/.git_sha 한 줄만 보면 어떤 커밋이 박혔는지 즉시 식별.
# → stale 캐시/이미지 섞임 방지 (예: v0.7.35- 이전 _bootstrap_lite에서 AGENTS.md 참조).
ARG GIT_SHA=latest
ENV GIT_SHA=${GIT_SHA}

# systemd-less: 의존성 최소화
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates bash git \
    && rm -rf /var/lib/apt/lists/*

# 비대자 user (security best practice)
RUN useradd --create-home --uid 1000 --shell /bin/bash raven

WORKDIR /app

# v0.7.17+: editable install ❌ (scripts/pyproject.toml 의존성 build fail).
# → 본체 raven 패키지는 PYTHONPATH=/app + entrypoint로 직접 실행.
# v0.7.184+: 핀 하드코딩 폐기 — requirements.txt가 단일 진실 원천이다.
# (이미지·데스크톱 번들·dev venv가 제각기 핀을 들고 있다가 번들만 mcp 2.0을
#  물어 fastmcp import가 깨진 사고를 반복하지 않기 위함.)
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir 'pytest>=7.0'

# Dashboard 정적 빌드 (stage 1에서) 복사
COPY --from=dashboard-build /app/dashboard/dist ./dashboard/dist

# Raven 코드 (CLI / API / MCP / core)
# v0.7.17+: USER raven 전환 후에도 파일 읽기 가능하도록 --chown 사용
COPY --chown=raven:raven raven/ ./raven/
COPY --chown=raven:raven dashboard/public ./dashboard/public
COPY --chown=raven:raven dashboard/index.html ./dashboard/
COPY --chown=raven:raven scripts/docker-entrypoint.sh /usr/local/bin/
COPY --chown=raven:raven scripts/spa_server.py /usr/local/bin/
# v0.7.39+: raven.core.db.build_db()가 canonical builder로 scripts/build_db.py
# (SQLite v2.4 스키마: pages_fts FTS5 + links.intent)를 우선 찾는데, 이게
# 이미지에 없어 매번 조용히 _inline_build() 미니멀 폴백(FTS5/intent 없음)으로
# 떨어져 wiki_search/wiki_get_page/wiki_graph가 "no such table/column"으로
# 실패했다. _repo_root()가 가리키는 /app/scripts/에 그대로 복사.
COPY --chown=raven:raven scripts/build_db.py ./scripts/build_db.py
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh /usr/local/bin/spa_server.py

# 환경변수 기본값 (.env로 override 가능)
ENV HOST=0.0.0.0 \
    PORT_API=8765 \
    PORT_MCP_HTTP=8766 \
    PORT_DASHBOARD=5173 \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1

ENV RAVEN_VAULTS_DIR=/vaults

# v0.7.36+: 이미지에 GIT_SHA 박제 — 컨테이너 안에서 즉시 식별.
RUN printf '%s\n' "${GIT_SHA}" > /app/.git_sha && chown raven:raven /app/.git_sha

USER raven

# 포트 노출 (compose가 실제 매핑)
EXPOSE 8765 8766 5173

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["api"]  # 기본 = API 시작. 다른 진입점은 환경변수로 전환.

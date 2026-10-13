"""v0.7.12+ — Docker 셋업 회귀 가드.

사용자 (2026-06-30):
  '도커로 하면 어때? 다른 피씨 환경에서도 할 건데 사실'
  '볼트는 외부경로에 있으니까 ~/Raven 잘 매핑해놓고'
  '왜 이래' (Docker daemon 연결 ❌ + version 키 obsolete)

v0.7.12 정책:
  - Dockerfile + docker-compose.yml + .env.example + .dockerignore + scripts/docker-entrypoint.sh
  - vault mount: ${RAVEN_VAULTS_DIR}:/vaults (사용자 외부 경로 ~/Raven)
  - 다른 PC에서도 동일하게 동작 (host path 동일하게 mount)
v0.7.16+: 'version: "3.9"' 키 제거 (Docker Compose v2 deprecated)
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / "Dockerfile"
COMPOSE = ROOT / "docker-compose.yml"
ENV_EXAMPLE_HOUSE = ROOT / ".env.example.house"
ENV_EXAMPLE_COMPANY = ROOT / ".env.example.company"
DOCKERIGNORE = ROOT / ".dockerignore"
ENTRYPOINT = ROOT / "scripts" / "docker-entrypoint.sh"


def test_dockerfile_exists() -> None:
    """Dockerfile 존재 + multi-stage 빌드 (dashboard + runtime)."""
    assert DOCKERFILE.exists(), "Dockerfile missing"
    content = DOCKERFILE.read_text(encoding="utf-8")
    assert "FROM node:20-slim AS dashboard-build" in content, \
        "Dockerfile must have stage 1: dashboard-build (Node 20)"
    assert "FROM python:3.11-slim AS runtime" in content, \
        "Dockerfile must have stage 2: python runtime"


def test_dockerfile_exposes_4_ports() -> None:
    """Dockerfile은 4 진입점 포트 노출."""
    content = DOCKERFILE.read_text(encoding="utf-8")
    assert "EXPOSE" in content and "8765" in content and "8766" in content and "5173" in content, \
        "Dockerfile must expose ports 8765 + 8766 + 5173"


def test_dockerfile_has_no_global_healthcheck() -> None:
    """Healthchecks are service-specific in compose; Dockerfile stays neutral."""
    content = DOCKERFILE.read_text(encoding="utf-8")
    assert "HEALTHCHECK" not in content, \
        "Dockerfile must not bake in one healthcheck for all services"


def test_compose_no_version_key() -> None:
    """v0.7.16+: 'version: "3.x"' 키 제거 (Docker Compose v2 deprecated)."""
    content = COMPOSE.read_text(encoding="utf-8")
    head_lines = content.splitlines()[:10]
    for line in head_lines:
        stripped = line.strip()
        if not stripped.startswith("#") and stripped.startswith("version:"):
            raise AssertionError(
                "docker-compose.yml must NOT have 'version:' key "
                "(Docker Compose v2 deprecated, v0.7.16+ removed)"
            )


def test_compose_has_3_services() -> None:
    """docker-compose.yml = 3 background 서비스 (API + MCP HTTP + Dashboard)."""
    content = COMPOSE.read_text(encoding="utf-8")
    assert "services:" in content
    assert "api:" in content
    assert "mcp-http:" in content
    assert "dashboard:" in content


def test_compose_mounts_user_vault_path() -> None:
    """docker-compose.yml = ${RAVEN_VAULTS_DIR}:/vaults (사용자 외부 경로).

    v0.7.20+: WIKI_VAULTS_DIR=/vaults (mount target, 컨테이너 안).
    컨테이너 안에서 registry.py가 /vaults/.registry.json 읽음.
    """
    content = COMPOSE.read_text(encoding="utf-8")
    # RAVEN_VAULTS_DIR은 호스트 경로 (mount source)
    assert "${RAVEN_VAULTS_DIR}:/vaults" in content, \
        "compose must mount ${RAVEN_VAULTS_DIR}:/vaults for cross-PC compatibility"
    # WIKI_VAULTS_DIR은 mount target (/vaults, 컨테이너 안 path)
    assert "WIKI_VAULTS_DIR=/vaults" in content, \
        "compose must set WIKI_VAULTS_DIR=/vaults (mount target, container-internal)"


def test_env_example_default_vault_path() -> None:
    """.env.example.* = RAVEN_VAULTS_DIR = 호스트 외부 경로 ~/Raven (외부 경로)."""
    for path in (ENV_EXAMPLE_HOUSE, ENV_EXAMPLE_COMPANY):
        content = path.read_text(encoding="utf-8")
        assert "RAVEN_VAULTS_DIR=/Users/jaekanglee/Raven" in content or \
               "RAVEN_VAULTS_DIR=${HOME}/Raven" in content, \
            f"{path.name} must default to ~/Raven (외부 vault 경로)"


def test_dockerignore_excludes_dev_artifacts() -> None:
    """.dockerignore = venv, node_modules, build artifacts 제외."""
    content = DOCKERIGNORE.read_text(encoding="utf-8")
    assert "scripts/.venv/" in content, \
        ".dockerignore must exclude scripts/.venv/"
    assert "dashboard/node_modules/" in content, \
        ".dockerignore must exclude dashboard/node_modules/"


def test_entrypoint_supports_all_4_entries() -> None:
    """scripts/docker-entrypoint.sh = api | mcp-http | mcp-stdio | dashboard | cli 라우팅."""
    content = ENTRYPOINT.read_text(encoding="utf-8")
    for cmd in ("api", "mcp-http", "mcp-stdio", "dashboard", "cli"):
        assert cmd in content, \
            f"docker-entrypoint.sh must handle '{cmd}' command"


def test_makefile_has_docker_targets() -> None:
    """Makefile = docker-build/up/down/logs/ps target."""
    content = (ROOT / "Makefile").read_text(encoding="utf-8")
    for target in ("docker-build", "docker-up", "docker-down"):
        assert target in content, f"Makefile missing {target}"


def test_no_legacy_vault_data_volume() -> None:
    """v0.7.12+: 옛 `vault-data` Docker volume ❌ (사용자 호스트 경로로 정정)."""
    content = COMPOSE.read_text(encoding="utf-8")
    assert "- vault-data:/vaults" not in content, \
        "v0.7.12+: legacy 'vault-data' Docker volume must NOT exist (use host path)"
    assert "volumes:\n  vault-data:" not in content, \
        "volumes section with vault-data must be removed"


def test_compose_uses_vaults_as_wiki_vaults_dir() -> None:
    """v0.7.23+: WIKI_VAULTS_DIR in docker-compose.yml must be /vaults (container path)."""
    content = COMPOSE.read_text(encoding="utf-8")
    assert "- WIKI_VAULTS_DIR=/vaults" in content, \
        "WIKI_VAULTS_DIR in docker-compose.yml must point to the container path '/vaults'"


def test_compose_healthchecks_match_service_ports() -> None:
    """api는 8765, mcp-http는 8766 자기 포트로 헬스체크해야 한다.

    Issue #67: 둘 다 토큰 없는 `GET /healthz`를 `curl -f`로 부른다 — /api·/mcp는 컨테이너 안
    loopback에서도 토큰이 필요하고, `-f` 없이는 401도 성공으로 친다.
    """
    content = COMPOSE.read_text(encoding="utf-8")
    assert '["CMD", "curl", "-fsS", "http://127.0.0.1:8765/healthz"]' in content, \
        "api healthcheck must probe /healthz on port 8765 and fail on HTTP errors"
    assert '["CMD", "curl", "-fsS", "http://127.0.0.1:8766/healthz"]' in content, \
        "mcp-http healthcheck must probe /healthz on its own port 8766 and fail on HTTP errors"
    assert "/api/vaults\"]" not in content and "8766/mcp" not in content.split("healthcheck")[-1]


def test_entrypoint_preserves_host_raven_vaults_dir() -> None:
    """docker-entrypoint must NOT overwrite host RAVEN_VAULTS_DIR with /vaults.

    WIKI_VAULTS_DIR = container-internal mount target (/vaults)
    RAVEN_VAULTS_DIR = host absolute path for UI/API display (e.g. /Users/.../Raven)
    """
    content = ENTRYPOINT.read_text(encoding="utf-8")
    assert 'RAVEN_VAULTS_DIR="${RAVEN_VAULTS_DIR:-$WIKI_VAULTS_DIR}"' in content, \
        "entrypoint must preserve host RAVEN_VAULTS_DIR when already provided"
    assert 'RAVEN_VAULTS_DIR="$WIKI_VAULTS_DIR"' not in content, \
        "entrypoint must not clobber host RAVEN_VAULTS_DIR with container path"

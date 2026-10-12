"""v0.7.67 (평가 A#5/A#7) — CORS 축소 + /log/rotate 데드코드 복원 가드.

pre-v0.7.67:
  - CORS `allow_origins=["*"]` + 무인증 → 127.0.0.1 바인딩을 브라우저의
    cross-origin 요청이 무력화할 수 있었다.
  - POST /api/vaults/{name}/log/rotate 본문이 docstring뿐이라 항상 null을
    반환하고 아무 동작도 하지 않았다 (실제 구현은 다른 함수 밑 데드코드).
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from raven.api.server import app
from raven.core.registry import VaultMeta
from raven.core.vault import Vault
from raven.core import log as log_module


@pytest.fixture
def client():
    return TestClient(app)


def test_cors_allows_known_local_origin(client):
    resp = client.options(
        "/api/index.json",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert resp.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_cors_rejects_arbitrary_origin(client):
    """평가 A#5 회귀 가드: `*`는 더 이상 허용되지 않는다."""
    resp = client.options(
        "/api/index.json",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert resp.headers.get("access-control-allow-origin") != "https://evil.example.com"
    assert resp.headers.get("access-control-allow-origin") != "*"


@pytest.fixture
def temp_vault_registered(tmp_path, monkeypatch):
    reg_root = Path(tempfile.mkdtemp(prefix="raven-rotate-reg-"))
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(reg_root))
    from raven.core.registry import registry as _registry

    (tmp_path / "content").mkdir()
    meta = VaultMeta(name="rotate-test", path=tmp_path, mode="personal", owner="user")
    v = Vault.load(meta)
    log_module.ensure_log(v)
    _registry().add(meta)
    yield v
    shutil.rmtree(reg_root, ignore_errors=True)


def test_log_rotate_endpoint_actually_runs(client, temp_vault_registered):
    """평가 A#7 회귀 가드: 응답이 더 이상 null이 아니라 실제 rotate 판단을 담는다.

    v0.7.179: 500 entries 미만 거부가 200 + ok:false → **409**로 바뀌었다
    (docs/issues/server-전역-에러-envelope-불일치.md). 이 가드의 원래 의도는
    "본문이 docstring뿐이라 항상 null"이던 데드코드 회귀를 막는 것이므로,
    거부/성공 어느 쪽이든 **실제 판단이 담긴 응답**인지를 계속 확인한다.
    """
    resp = client.post(f"/api/vaults/{temp_vault_registered.meta.name}/log/rotate")
    assert resp.status_code == 409
    assert "500" in str(resp.json()["detail"])

    forced = client.post(
        f"/api/vaults/{temp_vault_registered.meta.name}/log/rotate?force=true"
    )
    assert forced.status_code == 200
    assert forced.json()["rotated_to"]


def test_debug_log_endpoint_still_works(client, monkeypatch, tmp_path):
    """post_debug_log의 실제 동작은 데드코드 제거 후에도 그대로 살아있어야 한다(#19: opt-in)."""
    import raven.api.server as server

    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    monkeypatch.setattr(server, "_DEBUG_LOG_PATH", tmp_path / "dashboard-client.log")
    resp = client.post("/api/debug-log", json={"level": "info", "message": "hello"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

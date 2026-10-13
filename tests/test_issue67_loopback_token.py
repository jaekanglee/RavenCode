"""Issue #67: opt-in Bearer authentication for loopback Core and MCP traffic.

The Docker Desktop host forwarding path can look like a local 127.0.0.1
connection. Host and Origin headers cannot establish process identity.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

from raven.core import mcp_tokens


@pytest.fixture
def isolated_tokens(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "vaults"))
    (tmp_path / "vaults").mkdir()
    monkeypatch.setenv("RAVEN_REQUIRE_LOOPBACK_TOKEN", "1")


def _request(app, peer="127.0.0.1", headers=None):
    async def go():
        transport = httpx.ASGITransport(app=app, client=(peer, 54321))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            return await client.get("/api/vaults", headers=headers or {})
    return asyncio.run(go())


@pytest.mark.parametrize("peer", ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
@pytest.mark.parametrize("headers", [{}, {"Host": "127.0.0.1:8765"}, {"Origin": "http://127.0.0.1:5173"}])
def test_core_loopback_requires_token(isolated_tokens, peer, headers):
    from raven.api import app
    assert _request(app, peer, headers).status_code == 401


def test_core_loopback_valid_token_and_revoke(isolated_tokens):
    from raven.api import app
    token = mcp_tokens.add_token("issue67")
    headers = {"Authorization": f"Bearer {token}", "Host": "127.0.0.1:8765"}
    assert _request(app, headers=headers).status_code == 200
    mcp_tokens.revoke_token("issue67")
    assert _request(app, headers=headers).status_code == 401


def test_core_default_preserves_loopback(monkeypatch, tmp_path):
    from raven.api import app
    monkeypatch.delenv("RAVEN_REQUIRE_LOOPBACK_TOKEN", raising=False)
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "vaults"))
    (tmp_path / "vaults").mkdir()
    assert _request(app).status_code == 200


def test_mcp_loopback_requires_token(isolated_tokens):
    from raven.mcp.cli import build_http_app
    app = build_http_app("read", "127.0.0.1")

    async def go():
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 54321))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            return await client.post("/mcp", json={}, headers={"Host": "127.0.0.1:8766"})
    assert asyncio.run(go()).status_code == 401

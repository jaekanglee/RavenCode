"""Issue #67: opt-in Bearer authentication for loopback Core and MCP traffic.

The Docker Desktop host forwarding path can look like a local 127.0.0.1
connection. Host and Origin headers cannot establish process identity.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from raven.core import access, mcp_tokens

REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def hardened_isolated(tmp_path, monkeypatch):
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
def test_core_loopback_requires_token(hardened_isolated, peer, headers):
    from raven.api import app
    assert _request(app, peer, headers).status_code == 401


def test_core_loopback_valid_token_and_revoke(hardened_isolated):
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


def test_mcp_loopback_requires_token(hardened_isolated):
    from raven.mcp.cli import build_http_app
    app = build_http_app("read", "127.0.0.1")

    async def go():
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 54321))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            return await client.post("/mcp", json={}, headers={"Host": "127.0.0.1:8766"})
    assert asyncio.run(go()).status_code == 401


# ─── PR #69 review follow-up: parsing, WebSocket, messages, MCP end to end ───


@pytest.mark.parametrize("raw", ["1", "true", "TRUE", " yes ", "On", "on\n"])
def test_truthy_values_enable_hardened_mode(raw):
    assert access.require_loopback_token_from_env(raw) is True


@pytest.mark.parametrize("raw", ["", "0", "false", "no", "off", "2", "enable", "y"])
def test_other_values_leave_the_default(raw):
    assert access.require_loopback_token_from_env(raw) is False


@pytest.mark.parametrize("raw", [" TRUE ", "Yes"])
def test_env_value_is_read_case_and_space_insensitively(tmp_path, monkeypatch, raw):
    from raven.api import app

    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "vaults"))
    (tmp_path / "vaults").mkdir()
    monkeypatch.setenv("RAVEN_REQUIRE_LOOPBACK_TOKEN", raw)
    assert _request(app).status_code == 401


def _websocket(gate, headers):
    events: list[dict] = []
    incoming = [{"type": "websocket.connect"}]

    async def receive():
        return incoming.pop(0) if incoming else {"type": "websocket.disconnect", "code": 1000}

    async def send(message):
        events.append(message)

    async def inner(scope, receive, send):
        await receive()
        await send({"type": "websocket.accept"})

    scope = {"type": "websocket", "path": "/ws", "raw_path": b"/ws", "query_string": b"",
             "headers": [(b"host", b"127.0.0.1:8765")] + headers,
             "client": ("127.0.0.1", 40000), "server": ("127.0.0.1", 8765), "scheme": "ws",
             "root_path": "", "subprotocols": []}
    asyncio.run(gate(inner)(scope, receive, send))
    first = events[0]
    return first["type"] + (f":{first.get('code')}" if first["type"] == "websocket.close" else "")


def _gates():
    from raven.mcp.auth import LanTokenAuth

    return [access.TokenGate, LanTokenAuth]


@pytest.mark.parametrize("gate_index", [0, 1])
def test_websocket_without_token_is_closed_1008(hardened_isolated, gate_index):
    gate = _gates()[gate_index]
    assert _websocket(gate, []) == "websocket.close:1008"
    assert _websocket(gate, [(b"origin", b"tauri://localhost")]) == "websocket.close:1008"
    assert _websocket(gate, [(b"authorization", b"Bearer rvn_wrong")]) == "websocket.close:1008"
    token = mcp_tokens.add_token("ws")
    assert _websocket(gate, [(b"authorization", f"Bearer {token}".encode())]) == "websocket.accept"


@pytest.mark.parametrize("gate_index", [0, 1])
def test_websocket_default_mode_is_unchanged(monkeypatch, tmp_path, gate_index):
    monkeypatch.delenv("RAVEN_REQUIRE_LOOPBACK_TOKEN", raising=False)
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path))
    assert _websocket(_gates()[gate_index], []) == "websocket.accept"


@pytest.mark.parametrize("headers", [
    {"Authorization": "Bearer rvn_wrong_token"},
    {"Authorization": "Bearer rvn_wrong_token", "Host": "127.0.0.1:8765", "Origin": "http://127.0.0.1:5173"},
    {"Host": "evil.example"},
    {"Origin": "https://evil.example"},
    {"Host": "localhost:8765", "Origin": "tauri://localhost"},
])
def test_core_wrong_token_and_forged_headers_are_refused(hardened_isolated, headers):
    from raven.api import app

    mcp_tokens.add_token("present")  # a token exists, so a refusal is not "nothing issued"
    assert _request(app, headers=headers).status_code == 401


def test_core_token_in_query_string_is_refused(hardened_isolated):
    from raven.api import app

    token = mcp_tokens.add_token("query")

    async def go():
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 54321))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            return await client.get("/api/vaults", params={"token": token, "access_token": token})

    assert asyncio.run(go()).status_code == 401


# The 401 text must be true for the request it answers (PR #69 review): only a
# loopback source is told "loopback", a remote one gets the remote text, and an
# unknown source gets the plain Bearer text.
@pytest.mark.parametrize("peer,headers,expect", [
    ("127.0.0.1", {}, "loopback"),
    ("::1", {"Host": "evil.example"}, "loopback"),
    ("192.168.1.50", {}, "remote"),
    ("100.101.1.2", {}, "remote"),  # conftest: the route check answers "tailnet"
    ("127.0.0.1", {"X-Forwarded-For": "192.168.1.50", "X-Real-IP": "192.168.1.50"}, "unknown"),
])
def test_401_detail_matches_the_source(hardened_isolated, peer, headers, expect):
    from raven.api import app

    detail = _request(app, peer, headers).json()["detail"]
    if expect == "loopback":
        assert "loopback 요청에도" in detail
    elif expect == "remote":
        assert "loopback" not in detail and "원격 접근" in detail
    else:
        assert "loopback" not in detail and "원격" not in detail and "Bearer" in detail


@pytest.mark.parametrize("xff,expect", [
    ("192.168.1.50", "remote"),  # vite (xfwd) relaying a LAN browser
    ("127.0.0.1", "loopback"),   # vite relaying a browser on this PC
])
def test_401_detail_in_launcher_mode(hardened_isolated, monkeypatch, xff, expect):
    """Raven launchers read X-Forwarded-For themselves (``serve_kwargs``) — the text follows that source."""
    from raven.api import app

    monkeypatch.setattr(access, "_socket_peer", True)
    detail = _request(app, "127.0.0.1", {"X-Forwarded-For": xff}).json()["detail"]
    if expect == "loopback":
        assert "loopback 요청에도" in detail
    else:
        assert "loopback" not in detail and "원격 접근" in detail


def test_401_detail_default_mode_is_unchanged(monkeypatch, tmp_path):
    from raven.api import app

    monkeypatch.delenv("RAVEN_REQUIRE_LOOPBACK_TOKEN", raising=False)
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path))
    assert _request(app, "192.168.1.50").json()["detail"].startswith("원격 접근")
    assert "Host/Origin" in _request(app, headers={"Host": "evil.example"}).json()["detail"]


# ─── real socket: standalone MCP in hardened mode, end to end with the SDK ───


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


ACCEPT = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
INITIALIZE = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                         "clientInfo": {"name": "probe", "version": "0"}}}


async def _sdk(url, token):
    import httpx2
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    async with httpx2.AsyncClient(timeout=20, headers={"Authorization": f"Bearer {token}"}) as hc:
        async with streamable_http_client(url, http_client=hc) as (r, w, *_):
            async with ClientSession(r, w) as s:
                await s.initialize()
                return [t.name for t in (await s.list_tools()).tools]


def test_real_socket_mcp_hardened_mode(tmp_path):
    root = tmp_path / "vaults"
    root.mkdir()
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if k not in {"RAVEN_HOST", "FORWARDED_ALLOW_IPS"}}
    env.update(WIKI_VAULTS_DIR=str(root), PYTHONPATH=str(REPO_ROOT), RAVEN_REQUIRE_LOOPBACK_TOKEN="1")
    old = os.environ.get("WIKI_VAULTS_DIR")
    os.environ["WIKI_VAULTS_DIR"] = str(root)
    try:
        token = mcp_tokens.add_token("sdk")
        revoked = mcp_tokens.add_token("gone")
        mcp_tokens.revoke_token("gone")
    finally:
        if old is None:
            os.environ.pop("WIKI_VAULTS_DIR", None)
        else:
            os.environ["WIKI_VAULTS_DIR"] = old
    proc = subprocess.Popen([sys.executable, "-m", "raven.mcp.cli", "--transport", "http",
                             "--host", "127.0.0.1", "--port", str(port), "--mode", "read"],
                            cwd=REPO_ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}/mcp"
    try:
        deadline = time.monotonic() + 30
        while True:
            assert proc.poll() is None, "MCP server exited during startup"
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.3).close()
                break
            except OSError:
                assert time.monotonic() < deadline, "server did not start"
                time.sleep(0.1)
        with httpx.Client(timeout=10) as c:
            post = lambda h: c.post(url, content=json.dumps(INITIALIZE), headers={**ACCEPT, **h}).status_code  # noqa: E731
            assert post({}) == 401
            assert post({"Host": f"127.0.0.1:{port}", "Origin": f"http://127.0.0.1:{port}"}) == 401
            assert post({"Authorization": "Bearer rvn_wrong_token"}) == 401
            assert post({"Authorization": f"Bearer {revoked}"}) == 401
            assert c.post(f"{url}?token={token}", content=json.dumps(INITIALIZE), headers=ACCEPT).status_code == 401
        names = asyncio.run(asyncio.wait_for(_sdk(url, token), 25))
        assert "wiki_search" in names or len(names) > 5, names
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

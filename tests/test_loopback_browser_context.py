"""Issue #28: tokenless loopback trust needs a loopback Host and a local Origin.

A request on the loopback socket is not necessarily from a program on this machine:
a browser also sends them for pages of other sites. Those carry the other site's
name in Host or Origin. The Core API gate (TokenGate) and the MCP gate (LanTokenAuth)
must refuse them without a token, keep accepting local programs, the dashboard and
the desktop webview, and leave Bearer-authenticated requests alone.
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route, WebSocketRoute

from raven.core import access, mcp_tokens
from raven.core.access import TokenGate, is_local_browser_context
from raven.mcp.auth import LanTokenAuth


@pytest.fixture
def vaults_root(tmp_path, monkeypatch):
    root = tmp_path / "vaults"
    root.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(root))
    return root


def _inner():
    async def ok(_r):
        return PlainTextResponse("ok")

    async def ws(socket):
        await socket.accept()
        await socket.send_text("hi")
        await socket.close()

    return Starlette(routes=[Route("/x", ok, methods=["GET", "POST"]), WebSocketRoute("/ws", ws)])


def _status(gate_cls, headers: list[tuple[str, str]], peer: str = "127.0.0.1") -> int:
    """Raw ASGI call so Host is exactly what the test says (or absent)."""
    sent: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http", "method": "GET", "path": "/x", "raw_path": b"/x", "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers],
        "client": (peer, 40000), "server": ("127.0.0.1", 8765), "scheme": "http",
        "http_version": "1.1", "root_path": "",
    }
    asyncio.run(gate_cls(_inner())(scope, receive, send))
    return sent[0]["status"]


GATES = [TokenGate, LanTokenAuth]

LOCAL_HOSTS = ["127.0.0.1:8765", "127.0.0.1", "localhost:8766", "LOCALHOST:8765", "localhost.", "[::1]:8765",
               "[::1]", "127.5.6.7:8765"]
FOREIGN_HOSTS = ["evil.example:8765", "evil.example", "192.168.1.5:8765", "100.101.1.2:8766", "api:8765",
                 "localhost.evil.example", "127.0.0.1.evil.example", "", "127.0.0.1:abc", "[::1", "::1",
                 "[::1]x", "evil.example:8765:1"]
LOCAL_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173", "https://localhost", "http://[::1]:5173",
                 "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "HTTP://LOCALHOST:5173"]
FOREIGN_ORIGINS = ["https://evil.example", "http://evil.example:8765", "null", "http://192.168.0.5:5173",
                   "http://100.101.1.2:5173", "http://localhost@evil.example", "http://localhost.evil.example",
                   "http://127.0.0.1.evil.example", "file://", "chrome-extension://abcdef", "tauri://evil",
                   "http://tauri.localhost.evil.example", "http://127.0.0.1:5173/path", ""]


@pytest.mark.parametrize("gate_cls", GATES)
@pytest.mark.parametrize("host", LOCAL_HOSTS)
def test_local_programs_and_pages_still_pass_without_a_token(vaults_root, gate_cls, host) -> None:
    assert _status(gate_cls, [("host", host)]) == 200
    for origin in LOCAL_ORIGINS:
        assert _status(gate_cls, [("host", host), ("origin", origin)]) == 200, origin


@pytest.mark.parametrize("gate_cls", GATES)
def test_a_client_that_sends_no_host_still_passes(vaults_root, gate_cls) -> None:
    """HTTP/1.0 tools may omit Host; a browser never does."""
    assert _status(gate_cls, []) == 200


@pytest.mark.parametrize("gate_cls", GATES)
@pytest.mark.parametrize("host", FOREIGN_HOSTS)
def test_a_foreign_host_needs_a_token_on_loopback(vaults_root, gate_cls, host) -> None:
    assert _status(gate_cls, [("host", host)]) == 401


@pytest.mark.parametrize("gate_cls", GATES)
@pytest.mark.parametrize("origin", FOREIGN_ORIGINS)
def test_a_foreign_origin_needs_a_token_on_loopback(vaults_root, gate_cls, origin) -> None:
    assert _status(gate_cls, [("host", "127.0.0.1:8765"), ("origin", origin)]) == 401


@pytest.mark.parametrize("gate_cls", GATES)
def test_repeated_host_or_origin_headers_need_a_token(vaults_root, gate_cls) -> None:
    assert _status(gate_cls, [("host", "127.0.0.1:8765"), ("host", "evil.example")]) == 401
    assert _status(gate_cls, [("host", "127.0.0.1"), ("origin", "tauri://localhost"), ("origin", "https://evil.example")]) == 401


@pytest.mark.parametrize("gate_cls", GATES)
@pytest.mark.parametrize("headers", [
    [("host", "evil.example:8765")],
    [("host", "127.0.0.1:8765"), ("origin", "https://evil.example")],
    [("host", "api:8765")],  # Docker spa_server rewrites Host and sends the user's token
    [("host", "100.101.1.2:8766"), ("origin", "http://100.101.1.2:5173")],  # remote dashboard
])
def test_a_bearer_token_is_not_affected_by_host_or_origin(vaults_root, gate_cls, headers) -> None:
    token = mcp_tokens.add_token("t28")
    auth = [("authorization", f"Bearer {token}")]
    assert _status(gate_cls, headers + auth) == 200
    assert _status(gate_cls, headers + auth, peer="192.168.1.50") == 200


@pytest.mark.parametrize("gate_cls", GATES)
def test_remote_sources_are_unchanged(vaults_root, gate_cls) -> None:
    """Without a token a remote source was refused before and still is, whatever its Host."""
    for host in ("127.0.0.1:8765", "192.168.0.52:8765"):
        assert _status(gate_cls, [("host", host)], peer="192.168.1.50") == 401


@pytest.mark.parametrize("gate_cls", GATES)
def test_the_refusal_says_why(vaults_root, gate_cls) -> None:
    async def go():
        transport = httpx.ASGITransport(app=gate_cls(_inner()), client=("127.0.0.1", 40000))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as c:
            return await c.get("/x", headers={"Origin": "https://evil.example"})

    res = asyncio.run(go())
    assert res.status_code == 401
    assert "Host/Origin" in res.json()["detail"]
    assert res.headers["www-authenticate"].startswith("Bearer")


def _websocket(gate_cls, origin: str | None) -> str:
    events: list[dict] = []
    incoming = [{"type": "websocket.connect"}]

    async def receive():
        return incoming.pop(0) if incoming else {"type": "websocket.disconnect", "code": 1000}

    async def send(message):
        events.append(message)

    headers = [(b"host", b"127.0.0.1:8765")] + ([(b"origin", origin.encode())] if origin else [])
    scope = {"type": "websocket", "path": "/ws", "raw_path": b"/ws", "query_string": b"", "headers": headers,
             "client": ("127.0.0.1", 40000), "server": ("127.0.0.1", 8765), "scheme": "ws", "root_path": "",
             "subprotocols": []}
    asyncio.run(gate_cls(_inner())(scope, receive, send))
    return events[0]["type"] + (f":{events[0].get('code')}" if events[0]["type"] == "websocket.close" else "")


@pytest.mark.parametrize("gate_cls", GATES)
def test_websockets_follow_the_same_rule(vaults_root, gate_cls) -> None:
    assert _websocket(gate_cls, "https://evil.example") == "websocket.close:1008"
    assert _websocket(gate_cls, "tauri://localhost") == "websocket.accept"
    assert _websocket(gate_cls, None) == "websocket.accept"


def test_the_rule_on_its_own() -> None:
    def ctx(*headers):
        return is_local_browser_context({"headers": [(k.encode(), v.encode()) for k, v in headers]})

    assert ctx()
    assert ctx(("host", "localhost:1"), ("origin", "http://localhost:2"))
    assert not ctx(("host", "evil.example"))
    assert not ctx(("origin", "null"))


def test_core_api_and_mcp_agree_on_every_combination(vaults_root, monkeypatch) -> None:
    for launcher in (True, False):
        monkeypatch.setattr(access, "_socket_peer", launcher)
        for host in LOCAL_HOSTS + FOREIGN_HOSTS:
            for origin in [None] + LOCAL_ORIGINS + FOREIGN_ORIGINS:
                headers = [("host", host)] + ([("origin", origin)] if origin is not None else [])
                assert _status(TokenGate, headers) == _status(LanTokenAuth, headers), headers


def test_the_real_mcp_app_refuses_a_foreign_host_before_any_mcp_handling(vaults_root) -> None:
    from raven.mcp.cli import build_http_app

    app = build_http_app("admin", "127.0.0.1")
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}})
    headers = {"content-type": "application/json", "accept": "application/json, text/event-stream"}

    async def call(base: str, extra: dict) -> httpx.Response:
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 40000))
        async with httpx.AsyncClient(transport=transport, base_url=base) as c:
            return await c.post("/mcp", content=body, headers={**headers, **extra})

    async def go():
        # The gate answers before the MCP app (or its lifespan) is involved.
        foreign = await call("http://evil.example:8766", {})
        cross = await call("http://127.0.0.1:8766", {"origin": "https://evil.example"})
        return foreign, cross

    foreign, cross = asyncio.run(go())
    assert foreign.status_code == 401 and foreign.json()["error"] == "unauthorized"
    assert cross.status_code == 401


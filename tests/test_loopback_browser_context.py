"""Issue #67 (replaces #28's Host/Origin rule): loopback is no exemption from the token.

#28 let a tokenless request on the loopback socket through when its Host was a loopback
name and its Origin (if any) a local page or the desktop webview. That rule judged
headers the client chooses: macOS Docker Desktop forwards a container's
``host.docker.internal`` connection to the host's loopback, and the container can send
``Host: 127.0.0.1`` and any Origin. So now the Core API gate (TokenGate) and the MCP gate
(LanTokenAuth) require a Bearer token from every source:

  1. no token → 401 (WebSocket: close 1008), whatever Host, Origin or Sec-Fetch-* say —
     loopback Host, ``tauri://localhost``, the vite dashboard shape, page navigations;
  2. a valid token → 200, whatever Host or Origin say (Docker ``spa_server`` rewrites Host,
     remote dashboards send their own Origin);
  3. a wrong or revoked token → 401;
  4. the Core API's dashboard *files* stay public (no vault data) — see
     ``raven/api/server.py::_is_public_static``; ``/api`` never is. MCP has no public path
     besides ``GET /healthz``.
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
from raven.core.access import TokenGate
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

    return Starlette(routes=[Route("/x", ok, methods=["GET", "POST", "HEAD"]), Route("/page/v/x", ok, methods=["GET", "HEAD", "POST"]),
                              Route("/api/vaults", ok, methods=["GET", "POST"]), Route("/mcp", ok, methods=["GET", "POST"]),
                              WebSocketRoute("/ws", ws)])


def _status(gate_cls, headers: list[tuple[str, str]], peer: str = "127.0.0.1", method: str = "GET", path: str = "/x") -> int:
    """Raw ASGI call so Host is exactly what the test says (or absent)."""
    sent: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http", "method": method, "path": path, "raw_path": path.encode(), "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers],
        "client": (peer, 40000), "server": ("127.0.0.1", 8765), "scheme": "http",
        "http_version": "1.1", "root_path": "",
    }
    asyncio.run(gate_cls(_inner())(scope, receive, send))
    return sent[0]["status"]


GATES = [TokenGate, LanTokenAuth]
LOOPBACK_PEERS = ["127.0.0.1", "127.5.6.7", "::1", "::ffff:127.0.0.1"]

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


# ─── 1. no token → 401 from loopback, whatever the headers ───


@pytest.mark.parametrize("gate_cls", GATES)
@pytest.mark.parametrize("peer", LOOPBACK_PEERS)
@pytest.mark.parametrize("host", LOCAL_HOSTS + FOREIGN_HOSTS)
def test_no_host_or_origin_lets_a_tokenless_loopback_request_through(vaults_root, gate_cls, peer, host) -> None:
    assert _status(gate_cls, [("host", host)], peer=peer) == 401
    for origin in LOCAL_ORIGINS + FOREIGN_ORIGINS:
        assert _status(gate_cls, [("host", host), ("origin", origin)], peer=peer) == 401, origin


@pytest.mark.parametrize("gate_cls", GATES)
def test_a_client_that_sends_no_host_needs_a_token_too(vaults_root, gate_cls) -> None:
    """HTTP/1.0 tools may omit Host — no exemption for that either."""
    assert _status(gate_cls, []) == 401


@pytest.mark.parametrize("gate_cls", GATES)
@pytest.mark.parametrize("headers", [
    [("host", "127.0.0.1:8765"), ("sec-fetch-site", "none")],  # typed in the address bar
    [("host", "127.0.0.1:8765"), ("sec-fetch-site", "same-origin")],
    [("host", "127.0.0.1:8765"), ("sec-fetch-site", "cross-site"), ("origin", "tauri://localhost")],  # desktop webview
    [("host", "127.0.0.1:8765"), ("sec-fetch-site", "cross-site")],
    [("host", "127.0.0.1:8765"), ("sec-fetch-site", "same-site")],
])
def test_fetch_metadata_never_stands_in_for_a_token(vaults_root, gate_cls, headers) -> None:
    assert _status(gate_cls, headers) == 401


@pytest.mark.parametrize("gate_cls", GATES)
def test_the_vite_dashboard_shape_needs_a_token(vaults_root, monkeypatch, gate_cls) -> None:
    """vite (changeOrigin + xfwd): Host rewritten to the API, XFF 127.0.0.1, page Origin kept."""
    monkeypatch.setattr(access, "_socket_peer", True)
    vite = [("host", "127.0.0.1:8765"), ("x-forwarded-for", "127.0.0.1"), ("x-forwarded-host", "localhost:5173"),
            ("x-forwarded-proto", "http"), ("x-forwarded-port", "5173")]
    for extra in ([("origin", "http://localhost:5173")], [("origin", "http://127.0.0.1:5173"), ("sec-fetch-site", "same-origin")],
                  [("origin", "https://evil.example")], []):
        assert _status(gate_cls, vite + extra) == 401, extra
    token = mcp_tokens.add_token("vite")
    assert _status(gate_cls, vite + [("origin", "http://localhost:5173"), ("authorization", f"Bearer {token}")]) == 200
    # a LAN browser through vite needs it just the same
    lan = [("host", "127.0.0.1:8765"), ("x-forwarded-for", "192.168.1.50"), ("origin", "http://192.168.0.52:5173")]
    assert _status(gate_cls, lan) == 401
    assert _status(gate_cls, lan + [("authorization", f"Bearer {token}")]) == 200


@pytest.mark.parametrize("gate_cls", GATES)
def test_the_refusal_says_why(vaults_root, gate_cls) -> None:
    async def go():
        transport = httpx.ASGITransport(app=gate_cls(_inner()), client=("127.0.0.1", 40000))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as c:
            return await c.get("/x", headers={"Origin": "tauri://localhost"})

    res = asyncio.run(go())
    assert res.status_code == 401
    assert "loopback" in res.json()["detail"] and "Bearer" in res.json()["detail"]
    assert res.headers["www-authenticate"].startswith("Bearer")


# ─── 2–3. a valid token passes whatever Host/Origin say; a wrong or revoked one does not ───


@pytest.mark.parametrize("gate_cls", GATES)
@pytest.mark.parametrize("headers", [
    [],
    [("host", "evil.example:8765")],
    [("host", "127.0.0.1:8765"), ("origin", "https://evil.example")],
    [("host", "localhost"), ("origin", "tauri://localhost")],
    [("host", "api:8765")],  # Docker spa_server rewrites Host and sends the user's token
    [("host", "100.101.1.2:8766"), ("origin", "http://100.101.1.2:5173")],  # remote dashboard
    [("host", "127.0.0.1:8765"), ("sec-fetch-site", "cross-site")],
])
def test_a_bearer_token_is_not_affected_by_host_or_origin(vaults_root, gate_cls, headers) -> None:
    token = mcp_tokens.add_token("t67")
    auth = [("authorization", f"Bearer {token}")]
    assert _status(gate_cls, headers + auth) == 200
    assert _status(gate_cls, headers + auth, peer="192.168.1.50") == 200
    assert _status(gate_cls, headers + [("authorization", "Bearer rvn_wrong_token")]) == 401
    mcp_tokens.revoke_token("t67")
    assert _status(gate_cls, headers + auth) == 401


@pytest.mark.parametrize("gate_cls", GATES)
def test_remote_sources_are_unchanged(vaults_root, gate_cls) -> None:
    """Without a token a remote source was refused before and still is, whatever its Host."""
    for host in ("127.0.0.1:8765", "192.168.0.52:8765"):
        assert _status(gate_cls, [("host", host)], peer="192.168.1.50") == 401


def test_core_api_and_mcp_agree_on_every_combination(vaults_root, monkeypatch) -> None:
    for launcher in (True, False):
        monkeypatch.setattr(access, "_socket_peer", launcher)
        for host in LOCAL_HOSTS + FOREIGN_HOSTS:
            for origin in [None] + LOCAL_ORIGINS + FOREIGN_ORIGINS:
                headers = [("host", host)] + ([("origin", origin)] if origin is not None else [])
                assert _status(TokenGate, headers) == _status(LanTokenAuth, headers) == 401, headers


# ─── WebSocket ───


def _websocket(gate_cls, headers: list[tuple[bytes, bytes]], peer: str = "127.0.0.1") -> str:
    events: list[dict] = []
    incoming = [{"type": "websocket.connect"}]

    async def receive():
        return incoming.pop(0) if incoming else {"type": "websocket.disconnect", "code": 1000}

    async def send(message):
        events.append(message)

    scope = {"type": "websocket", "path": "/ws", "raw_path": b"/ws", "query_string": b"",
             "headers": [(b"host", b"127.0.0.1:8765")] + headers,
             "client": (peer, 40000), "server": ("127.0.0.1", 8765), "scheme": "ws", "root_path": "",
             "subprotocols": []}
    asyncio.run(gate_cls(_inner())(scope, receive, send))
    return events[0]["type"] + (f":{events[0].get('code')}" if events[0]["type"] == "websocket.close" else "")


@pytest.mark.parametrize("gate_cls", GATES)
@pytest.mark.parametrize("peer", ["127.0.0.1", "::1"])
def test_websockets_follow_the_same_rule(vaults_root, gate_cls, peer) -> None:
    for origin in (None, b"tauri://localhost", b"http://localhost:5173", b"https://evil.example"):
        headers = [(b"origin", origin)] if origin else []
        assert _websocket(gate_cls, headers, peer) == "websocket.close:1008", origin
    assert _websocket(gate_cls, [(b"authorization", b"Bearer rvn_wrong")], peer) == "websocket.close:1008"
    token = mcp_tokens.add_token("ws")
    assert _websocket(gate_cls, [(b"authorization", f"Bearer {token}".encode())], peer) == "websocket.accept"


# ─── real apps ───


def test_the_real_mcp_app_refuses_tokenless_loopback_before_any_mcp_handling(vaults_root) -> None:
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
        return [await call("http://evil.example:8766", {}),
                await call("http://127.0.0.1:8766", {"origin": "https://evil.example"}),
                await call("http://127.0.0.1:8766", {}),
                await call("http://localhost:8766", {"origin": "tauri://localhost"})]

    for res in asyncio.run(go()):
        assert res.status_code == 401 and res.json()["error"] == "unauthorized"


def test_the_real_api_app_serves_the_desktop_webview_only_with_a_credential(vaults_root) -> None:
    from fastapi.testclient import TestClient

    from raven.api.server import app

    tokenless = TestClient(app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:8765", headers={"Authorization": ""})
    assert tokenless.get("/api/vaults", headers={"Origin": "tauri://localhost", "Sec-Fetch-Site": "cross-site"}).status_code == 401
    # conftest's TestClient carries the test session credential, like the desktop webview's
    client = TestClient(app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:8765")
    ok = client.get("/api/vaults", headers={"Origin": "tauri://localhost", "Sec-Fetch-Site": "cross-site"})
    assert ok.status_code == 200
    assert ok.headers.get("access-control-allow-origin") == "tauri://localhost"


NAV = [("host", "127.0.0.1:8765"), ("sec-fetch-site", "cross-site"), ("sec-fetch-mode", "navigate"), ("sec-fetch-dest", "document")]


@pytest.mark.parametrize("gate_cls", GATES)
def test_a_bare_gate_gives_no_navigation_exemption(vaults_root, gate_cls) -> None:
    """#28's page-navigation exemption is gone; only an explicit ``public`` predicate opens a path."""
    for path in ("/page/v/x", "/", "/api/vaults", "/mcp"):
        assert _status(gate_cls, NAV, path=path) == 401, path


def test_the_core_serves_dashboard_files_but_not_the_api_to_a_link_from_another_site(vaults_root, monkeypatch, tmp_path) -> None:
    """The Core's dashboard build is public (no vault data); the API behind it is not."""
    import raven.api.server as server

    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>raven</html>", encoding="utf-8")
    monkeypatch.setattr(server, "_DASHBOARD_DIST", dist)

    async def go(method, path):
        transport = httpx.ASGITransport(app=server.app, client=("127.0.0.1", 40000))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as c:
            return await c.request(method, path, headers=dict(NAV[1:]))

    for method, path in (("GET", "/api/vaults"), ("GET", "/api"), ("POST", "/page/v/x"), ("GET", "/docs"), ("GET", "/openapi.json")):
        assert asyncio.run(go(method, path)).status_code == 401, (method, path)
    # The public predicate lets GET /page/... through the gate; whether the SPA fallback
    # route exists depends on a build at import time, so only "not refused" is asserted.
    assert asyncio.run(go("GET", "/page/v/x")).status_code != 401

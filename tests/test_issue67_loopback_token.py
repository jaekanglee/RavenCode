"""Issue #67: the Core API and MCP need a Bearer token from every source — loopback too.

macOS Docker Desktop forwards a container's ``host.docker.internal`` connection to the
host's loopback, so the gate sees peer 127.0.0.1, and the container writes Host/Origin
itself. No source, Host or Origin earns a tokenless pass any more. What stays open:

- ``GET /healthz`` — fixed body, never reaches the app (compose healthchecks);
- the Core API's dashboard static files (``raven/api/server.py::_is_public_static``);
- the desktop webview's per-launch session credential (``access.set_session_token``),
  Core API only and only from a loopback source.
"""
from __future__ import annotations

import asyncio
import http.client
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
LOOPBACK_PEERS = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.8.8.8"]
# what a Docker Desktop container (or a rebinding page) can put in the headers
FORGED = [
    {},
    {"Host": "127.0.0.1:8765"},
    {"Host": "localhost:8765", "Origin": "http://127.0.0.1:5173"},
    {"Host": "127.0.0.1:8765", "Origin": "tauri://localhost"},
    {"Host": "[::1]:8765", "Origin": "http://tauri.localhost"},
    {"Host": "127.0.0.1:8765", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"},
    {"Host": "evil.example"},
]
ACCEPT = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
INITIALIZE = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                         "clientInfo": {"name": "probe", "version": "0"}}}


@pytest.fixture
def vaults(tmp_path, monkeypatch):
    root = tmp_path / "vaults"
    root.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(root))
    access.set_session_token(None)  # only what each test sets up
    return root


def _core():
    from raven.api import app
    return app


def _mcp():
    from raven.mcp.cli import build_http_app
    return build_http_app("read", "127.0.0.1")


def _call(app, peer="127.0.0.1", headers=None, method="GET", path="/api/vaults", body=None):
    async def go():
        transport = httpx.ASGITransport(app=app, client=(peer, 54321))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            return await client.request(method, path, headers=headers or {},
                                        content=json.dumps(body) if body is not None else None)
    return asyncio.run(go())


def _mcp_call(peer="127.0.0.1", headers=None):
    return _call(_mcp(), peer, {**ACCEPT, **(headers or {})}, "POST", "/mcp", INITIALIZE)


def _mcp_gate_passes(peer, headers) -> bool:
    """Does the MCP gate hand the request to the app? (The real MCP app needs its lifespan
    task group, so in-process the gate wraps a stub; the SDK test below runs it for real.)"""
    from raven.mcp.auth import LanTokenAuth

    reached: list[bool] = []

    async def app(scope, receive, send):
        reached.append(True)
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    _call(LanTokenAuth(app), peer, {**ACCEPT, **headers}, "POST", "/mcp", INITIALIZE)
    return bool(reached)


# ─── no source is exempt ───


@pytest.mark.parametrize("peer", LOOPBACK_PEERS)
@pytest.mark.parametrize("headers", FORGED)
def test_core_tokenless_loopback_is_refused_whatever_the_headers(vaults, peer, headers):
    res = _call(_core(), peer, headers)
    assert res.status_code == 401, (peer, headers)
    assert res.headers["www-authenticate"] == 'Bearer realm="raven"'


@pytest.mark.parametrize("peer", LOOPBACK_PEERS)
@pytest.mark.parametrize("headers", FORGED)
def test_mcp_tokenless_loopback_is_refused_whatever_the_headers(vaults, peer, headers):
    res = _mcp_call(peer, headers)
    assert res.status_code == 401, (peer, headers)
    assert res.headers["www-authenticate"] == 'Bearer realm="raven-mcp"'


@pytest.mark.parametrize("peer", LOOPBACK_PEERS + ["192.168.1.50", "100.101.1.2"])
def test_valid_issued_token_passes_core_and_mcp_whatever_the_headers(vaults, peer):
    token = mcp_tokens.add_token("issued")
    for headers in FORGED:
        auth = {**headers, "Authorization": f"Bearer {token}"}
        assert _call(_core(), peer, auth).status_code == 200, (peer, headers)
        assert _mcp_gate_passes(peer, auth), (peer, headers)
        assert not _mcp_gate_passes(peer, headers), (peer, headers)


@pytest.mark.parametrize("auth", ["Bearer rvn_wrong_token", "Bearer ", "Basic dXNlcjpwYXNz", "rvn_no_scheme"])
def test_wrong_or_malformed_credentials_are_refused(vaults, auth):
    mcp_tokens.add_token("present")
    headers = {"Authorization": auth, "Host": "127.0.0.1:8765", "Origin": "tauri://localhost"}
    assert _call(_core(), headers=headers).status_code == 401
    assert _mcp_call(headers=headers).status_code == 401


def test_revoked_token_is_refused_at_once(vaults):
    token = mcp_tokens.add_token("gone")
    auth = {"Authorization": f"Bearer {token}"}
    assert _call(_core(), headers=auth).status_code == 200
    mcp_tokens.revoke_token("gone")
    assert _call(_core(), headers=auth).status_code == 401
    assert _mcp_call(headers=auth).status_code == 401


def test_token_in_the_url_is_never_read(vaults):
    token = mcp_tokens.add_token("query")
    for path in (f"/api/vaults?token={token}", f"/api/vaults?access_token={token}",
                 f"/api/vaults?authorization=Bearer%20{token}"):
        assert _call(_core(), path=path).status_code == 401, path


def test_no_issued_token_means_everything_is_refused(vaults):
    assert mcp_tokens.list_tokens() == []
    assert _call(_core()).status_code == 401
    assert _mcp_call().status_code == 401


# ─── the desktop session credential ───


def test_session_credential_opens_the_core_api_from_loopback_only(vaults):
    access.set_session_token("rvs_unit_secret")
    auth = {"Authorization": "Bearer rvs_unit_secret"}
    for peer in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
        assert _call(_core(), peer, auth).status_code == 200, peer
    for peer in ("192.168.1.50", "100.101.1.2", "10.0.2.2"):
        assert _call(_core(), peer, auth).status_code == 401, peer


def test_session_credential_via_a_lan_proxy_is_refused(vaults, monkeypatch):
    """vite (xfwd) relaying a LAN browser: the source is the LAN client, not this PC."""
    monkeypatch.setattr(access, "_socket_peer", True)
    access.set_session_token("rvs_unit_secret")
    headers = {"Authorization": "Bearer rvs_unit_secret", "X-Forwarded-For": "192.168.1.50"}
    assert _call(_core(), "127.0.0.1", headers).status_code == 401


def test_session_credential_is_not_an_mcp_credential(vaults):
    access.set_session_token("rvs_unit_secret")
    assert _mcp_call(headers={"Authorization": "Bearer rvs_unit_secret"}).status_code == 401


def test_cleared_or_wrong_session_credential_is_refused(vaults):
    access.set_session_token("rvs_unit_secret")
    assert _call(_core(), headers={"Authorization": "Bearer rvs_unit_secreT"}).status_code == 401
    access.set_session_token(None)
    assert _call(_core(), headers={"Authorization": "Bearer rvs_unit_secret"}).status_code == 401


# ─── WebSocket ───


def _websocket(gate, headers, peer="127.0.0.1"):
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
             "client": (peer, 40000), "server": ("127.0.0.1", 8765), "scheme": "ws",
             "root_path": "", "subprotocols": []}
    asyncio.run(gate(inner)(scope, receive, send))
    first = events[0]
    return first["type"] + (f":{first.get('code')}" if first["type"] == "websocket.close" else "")


def test_websocket_needs_a_token_on_both_gates(vaults):
    from raven.mcp.auth import LanTokenAuth

    token = mcp_tokens.add_token("ws")
    access.set_session_token("rvs_ws_secret")
    for gate in (access.TokenGate, LanTokenAuth):
        assert _websocket(gate, []) == "websocket.close:1008"
        assert _websocket(gate, [(b"origin", b"tauri://localhost")]) == "websocket.close:1008"
        assert _websocket(gate, [(b"authorization", b"Bearer rvn_wrong")]) == "websocket.close:1008"
        assert _websocket(gate, [(b"authorization", f"Bearer {token}".encode())]) == "websocket.accept"
    assert _websocket(access.TokenGate, [(b"authorization", b"Bearer rvs_ws_secret")]) == "websocket.accept"
    assert _websocket(LanTokenAuth, [(b"authorization", b"Bearer rvs_ws_secret")]) == "websocket.close:1008"
    assert _websocket(access.TokenGate, [(b"authorization", b"Bearer rvs_ws_secret")],
                      peer="192.168.1.50") == "websocket.close:1008"


# ─── /healthz ───


@pytest.mark.parametrize("app_factory", [_core, _mcp])
def test_health_check_answers_without_a_token_and_says_nothing(vaults, app_factory):
    res = _call(app_factory(), path="/healthz")
    assert res.status_code == 200
    assert res.content == b'{"ok":true}'
    assert "set-cookie" not in res.headers


@pytest.mark.parametrize("app_factory", [_core, _mcp])
@pytest.mark.parametrize("method,path", [("POST", "/healthz"), ("GET", "/healthz/"), ("GET", "/healthz/x"),
                                         ("GET", "/api/healthz"), ("GET", "/HEALTHZ"), ("DELETE", "/healthz")])
def test_only_get_healthz_exactly_is_public(vaults, app_factory, method, path):
    assert _call(app_factory(), method=method, path=path).status_code == 401, (method, path)


# ─── 401 text ───


@pytest.mark.parametrize("peer,headers,expect", [
    ("127.0.0.1", {}, "loopback"),
    ("::1", {"Host": "evil.example"}, "loopback"),
    ("192.168.1.50", {}, "remote"),
    ("100.101.1.2", {}, "remote"),
    ("127.0.0.1", {"X-Forwarded-For": "192.168.1.50", "X-Real-IP": "192.168.1.50"}, "unknown"),
])
def test_401_detail_matches_the_source(vaults, peer, headers, expect):
    detail = _call(_core(), peer, headers).json()["detail"]
    if expect == "loopback":
        assert "같은 PC(loopback)" in detail
    elif expect == "remote":
        assert "loopback" not in detail and "원격 접근" in detail
    else:
        assert "loopback" not in detail and "원격" not in detail and "Bearer" in detail


# ─── Core static files: public, exact, inside the build ───


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait(port, proc):
    deadline = time.monotonic() + 30
    while True:
        assert proc.poll() is None, "server exited during startup"
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.3).close()
            return
        except OSError:
            assert time.monotonic() < deadline, "server did not start"
            time.sleep(0.1)


def _raw(port, path, method="GET", headers=None):
    """Send ``path`` byte-for-byte (no client-side normalisation of `..` or `%`)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
    conn.putheader("Host", f"127.0.0.1:{port}")
    for k, v in (headers or {}).items():
        conn.putheader(k, v)
    conn.endheaders()
    res = conn.getresponse()
    body = res.read()
    conn.close()
    return res.status, body


def _issue(root: Path, name: str) -> str:
    old = os.environ.get("WIKI_VAULTS_DIR")
    os.environ["WIKI_VAULTS_DIR"] = str(root)
    try:
        return mcp_tokens.add_token(name)
    finally:
        if old is None:
            os.environ.pop("WIKI_VAULTS_DIR", None)
        else:
            os.environ["WIKI_VAULTS_DIR"] = old


@pytest.fixture
def static_core(tmp_path):
    dist = tmp_path / "site" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>INDEX</title>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log('APPJS')", encoding="utf-8")
    (dist / "favicon.svg").write_text("<svg>FAVICON</svg>", encoding="utf-8")
    (tmp_path / "site" / "SECRET.txt").write_text("OUTSIDE-SECRET", encoding="utf-8")
    root = tmp_path / "vaults"
    root.mkdir()
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if k not in {"RAVEN_HOST", "FORWARDED_ALLOW_IPS"}}
    env.update(WIKI_VAULTS_DIR=str(root), PYTHONPATH=str(REPO_ROOT), RAVEN_DASHBOARD_DIST=str(dist))
    proc = subprocess.Popen([sys.executable, "-m", "raven.api", "--port", str(port)], cwd=REPO_ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        _wait(port, proc)
        yield port, root
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_dashboard_static_files_need_no_token(static_core):
    port, _ = static_core
    for path, marker in (("/", b"INDEX"), ("/page/alpha/content/x", b"INDEX"), ("/assets/app.js", b"APPJS"),
                         ("/favicon.svg", b"FAVICON"), ("/vault/new", b"INDEX")):
        status, body = _raw(port, path)
        assert status == 200 and marker in body, (path, status, body[:80])
    assert _raw(port, "/", "HEAD")[0] != 401  # the gate lets it through (the SPA route itself is GET-only)


@pytest.mark.parametrize("path", [
    "/api/vaults", "/api", "/api/", "/api/vaults/alpha/raw", "/%61pi/vaults", "/api%2Fvaults",
    "/api/../api/vaults", "/api/./vaults", "/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect",
])
def test_api_and_api_docs_stay_behind_the_token(static_core, path):
    port, _ = static_core
    status, body = _raw(port, path)
    assert status == 401, (path, status, body[:120])


def test_api_paths_with_a_token_still_work(static_core):
    port, root = static_core
    token = _issue(root, "static")
    status, body = _raw(port, "/api/vaults", headers={"Authorization": f"Bearer {token}"})
    assert status == 200 and b"vaults" in body


@pytest.mark.parametrize("path", [
    "/..%2fSECRET.txt", "/%2e%2e/SECRET.txt", "/%2e%2e%2fSECRET.txt", "/assets/..%2f..%2fSECRET.txt",
    "//etc/passwd", "/%2fetc%2fpasswd", "/..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd", "/%252e%252e/SECRET.txt",
    "/../SECRET.txt", "/assets/../../SECRET.txt",
])
def test_static_paths_never_leave_the_build(static_core, path):
    port, _ = static_core
    status, body = _raw(port, path)
    assert b"OUTSIDE-SECRET" not in body and b"root:" not in body, (path, status)


def test_websocket_upgrade_on_a_static_path_is_refused(static_core):
    port, _ = static_core
    status, _ = _raw(port, "/", headers={"Connection": "Upgrade", "Upgrade": "websocket",
                                         "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="})
    assert status != 101


def test_public_static_predicate_is_exact(monkeypatch, tmp_path):
    from raven.api import server

    monkeypatch.setattr(server, "_DASHBOARD_DIST", tmp_path)

    def public(method, path):
        return server._is_public_static({"type": "http", "method": method, "path": path})

    assert public("GET", "/") and public("HEAD", "/assets/a.js") and public("GET", "/page/x")
    for method in ("POST", "PUT", "DELETE", "PATCH", "OPTIONS"):
        assert not public(method, "/")
    for path in ("/api", "/api/", "/api/vaults", "/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"):
        assert not public("GET", path), path
    monkeypatch.setattr(server, "_DASHBOARD_DIST", None)
    assert not public("GET", "/"), "no dashboard build → nothing is public"


# ─── real socket: standalone MCP, end to end with the SDK ───


async def _sdk(url, token):
    import httpx2
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    async with httpx2.AsyncClient(timeout=20, headers={"Authorization": f"Bearer {token}"}) as hc:
        async with streamable_http_client(url, http_client=hc) as (r, w, *_):
            async with ClientSession(r, w) as s:
                await s.initialize()
                return [t.name for t in (await s.list_tools()).tools]


def test_real_socket_mcp_default_policy(tmp_path):
    root = tmp_path / "vaults"
    root.mkdir()
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if k not in {"RAVEN_HOST", "FORWARDED_ALLOW_IPS"}}
    env.update(WIKI_VAULTS_DIR=str(root), PYTHONPATH=str(REPO_ROOT))
    token = _issue(root, "sdk")
    revoked = _issue(root, "gone")
    old = os.environ.get("WIKI_VAULTS_DIR")
    os.environ["WIKI_VAULTS_DIR"] = str(root)
    try:
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
        _wait(port, proc)
        with httpx.Client(timeout=10) as c:
            post = lambda h: c.post(url, content=json.dumps(INITIALIZE), headers={**ACCEPT, **h}).status_code  # noqa: E731
            assert post({}) == 401
            assert post({"Host": f"127.0.0.1:{port}", "Origin": f"http://127.0.0.1:{port}"}) == 401
            assert post({"Authorization": "Bearer rvn_wrong_token"}) == 401
            assert post({"Authorization": f"Bearer {revoked}"}) == 401
            assert c.post(f"{url}?token={token}", content=json.dumps(INITIALIZE), headers=ACCEPT).status_code == 401
            assert c.get(f"http://127.0.0.1:{port}/healthz").status_code == 200
        names = asyncio.run(asyncio.wait_for(_sdk(url, token), 25))
        assert len(names) > 5, names
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


# ─── review BLOCKER B1: path exceptions follow the router's path (root_path) ───


@pytest.mark.parametrize("root_path", ["/x", "/raven", "/api"])
def test_root_path_does_not_turn_the_api_public(vaults, monkeypatch, tmp_path, root_path):
    """With ``uvicorn --root-path`` the router strips the prefix; the gate must judge the same path."""
    from raven.api import server

    monkeypatch.setattr(server, "_DASHBOARD_DIST", tmp_path)  # a dashboard build is "served"

    async def go(path):
        transport = httpx.ASGITransport(app=_core(), client=("127.0.0.1", 54321), root_path=root_path)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            return await client.get(path)

    for path in (f"{root_path}/api/vaults", f"{root_path}/api", f"{root_path}/openapi.json", f"{root_path}/docs"):
        assert asyncio.run(go(path)).status_code == 401, path
    assert server._is_public_static({"type": "http", "method": "GET", "path": f"{root_path}/page/x",
                                     "root_path": root_path})
    assert not server._is_public_static({"type": "http", "method": "GET", "path": f"{root_path}/api/vaults",
                                         "root_path": root_path})


def test_route_path_matches_starlette():
    from starlette._utils import get_route_path

    for path, root in [("/x/api/v", "/x"), ("/x", "/x"), ("/xy/api", "/x"), ("/api/v", ""), ("/a/b", "/c"),
                       ("/api/api/v", "/api")]:
        scope = {"path": path, "root_path": root}
        assert access.route_path(scope) == get_route_path(scope), (path, root)


def test_health_check_under_a_root_path(vaults):
    async def go():
        transport = httpx.ASGITransport(app=_core(), client=("127.0.0.1", 54321), root_path="/x")
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            return await client.get("/x/healthz")

    res = asyncio.run(go())
    assert res.status_code == 200 and res.content == b'{"ok":true}'


def test_nul_in_a_static_path_is_not_a_server_error(static_core):
    port, _ = static_core
    status, body = _raw(port, "/%00")
    assert status == 200 and b"INDEX" in body

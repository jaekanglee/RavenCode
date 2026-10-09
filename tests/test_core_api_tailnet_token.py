"""Issue #24 — the Core API requires a Bearer token from every non-loopback source, tailnet included.

PR #21 trusted tailnet sources judged by a route inference (`is_tailnet_peer`), which
does not prove the accepted connection's WireGuard authentication. #24 removes that
trust for the Core API:

  1. loopback (127.0.0.0/8, ::1, IPv4-mapped) → no token, unchanged.
  2. every other source — tailnet IPv4/IPv6 included, even when the route check
     says "tailnet" — needs a valid `Authorization: Bearer` token; missing/invalid
     → 401 before any handler runs, on every method and on WebSocket handshakes.
  3. XFF from a local proxy cannot turn a tailnet/LAN client into a trusted one;
     only loopback XFF hops are honoured (launcher mode), unchanged.
  4. MCP keeps its own policy (ADR 2026-09-30): `LanTokenAuth` still trusts
     route-judged tailnet peers. That is a separate surface, not touched by #24.

In-process tests run with conftest's fake tailnet, i.e. the route check *does*
answer "tailnet" — so a 401 here proves the policy, not a failed route lookup.
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
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import httpx
import pytest

from raven.core import access, mcp_tokens

REPO_ROOT = Path(__file__).resolve().parents[1]
TAILNET = ["100.101.1.2", "100.64.0.1", "fd7a:115c:a1e0::77", "::ffff:100.101.1.2"]
METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]


@pytest.fixture
def vaults_root(tmp_path, monkeypatch):
    root = tmp_path / "vaults"
    root.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(root))
    return root


def _call(method, path, peer, headers=None, **kw):
    from raven.api import app

    transport = httpx.ASGITransport(app=app, client=(peer, 44444))

    async def go():
        async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
            return await c.request(method, path, headers=headers or {}, **kw)

    return asyncio.run(go())


@pytest.mark.parametrize("peer", TAILNET)
def test_route_says_tailnet_but_api_still_needs_a_token(vaults_root, peer):
    assert access.is_tailnet_peer(peer), "fixture precondition: route check says tailnet"
    res = _call("GET", "/api/vaults", peer)
    assert res.status_code == 401, peer
    assert res.headers["www-authenticate"].startswith("Bearer")


@pytest.mark.parametrize("peer", TAILNET)
def test_tailnet_wrong_and_valid_tokens(vaults_root, peer):
    assert _call("GET", "/api/vaults", peer, {"Authorization": "Bearer rvn_wrong_token_x"}).status_code == 401
    token = mcp_tokens.add_token(f"t-{abs(hash(peer))}")
    assert _call("GET", "/api/vaults", peer, {"Authorization": f"Bearer {token}"}).status_code == 200


@pytest.mark.parametrize("peer", ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"])
def test_loopback_still_needs_no_token(vaults_root, peer):
    assert _call("GET", "/api/vaults", peer).status_code == 200


@pytest.mark.parametrize("method", METHODS)
def test_every_method_from_tailnet_is_gated_before_handlers(vaults_root, monkeypatch, method):
    from raven.core.vault import Vault
    import raven.api.server as server

    Vault.create("alpha", vaults_root / "alpha")
    reached = []
    real = server.registry
    monkeypatch.setattr(server, "registry", lambda *a, **k: reached.append(1) or real(*a, **k))
    path = "/api/vaults/alpha?force=true" if method == "DELETE" else "/api/vaults/alpha/pages"
    res = _call(method, path, "100.101.1.2", json={"title": "x", "body": "y"} if method in ("POST", "PUT", "PATCH") else None)
    assert res.status_code == 401, (method, res.status_code)
    assert reached == []
    assert (vaults_root / "alpha").exists()


@pytest.mark.parametrize(
    "headers",
    [
        {"X-Forwarded-For": "127.0.0.1"},
        {"X-Forwarded-For": "::1"},
        {"Host": "127.0.0.1:8765"},
        {"Origin": "http://127.0.0.1:5173"},
        {"Origin": "tauri://localhost", "Host": "localhost"},
    ],
)
def test_forged_headers_do_not_lift_a_tailnet_client(vaults_root, headers):
    assert _call("GET", "/api/vaults", "100.101.1.2", headers).status_code == 401, headers


def test_local_proxy_xff_tailnet_source_needs_token(vaults_root, monkeypatch):
    """vite xfwd: a tailnet browser via the local dev proxy arrives as loopback + XFF tailnet."""
    monkeypatch.setattr(access, "_socket_peer", True)
    assert _call("GET", "/api/vaults", "127.0.0.1", {"X-Forwarded-For": "100.101.1.2"}).status_code == 401
    assert _call("GET", "/api/vaults", "127.0.0.1", {"X-Forwarded-For": "127.0.0.1"}).status_code == 200
    token = mcp_tokens.add_token("vite-remote")
    assert _call("GET", "/api/vaults", "127.0.0.1",
                 {"X-Forwarded-For": "100.101.1.2", "Authorization": f"Bearer {token}"}).status_code == 200


def test_websocket_handshake_from_tailnet_is_refused(vaults_root):
    from raven.api import app

    sent = []

    async def receive():
        return {"type": "websocket.connect"}

    async def send(msg):
        sent.append(msg)

    scope = {"type": "websocket", "path": "/ws", "raw_path": b"/ws", "query_string": b"",
             "headers": [], "client": ("100.101.1.2", 1), "server": ("raven", 80),
             "scheme": "ws", "root_path": "", "subprotocols": [], "asgi": {"version": "3.0"}}
    asyncio.run(app(scope, receive, send))
    assert sent and sent[0]["type"] == "websocket.close"


def test_api_gate_and_mcp_gate_differ_only_in_tailnet_trust():
    from raven.mcp.auth import LanTokenAuth

    assert access.TokenGate.trust_tailnet is False
    assert LanTokenAuth.trust_tailnet is True


def test_mcp_keeps_route_judged_tailnet_trust(vaults_root):
    """#24 scope is the Core API; MCP stays under ADR 2026-09-30 (explicitly, not by accident)."""
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    from raven.mcp.auth import LanTokenAuth

    async def ok(_r):
        return PlainTextResponse("ok")

    app = LanTokenAuth(Starlette(routes=[Route("/mcp", ok, methods=["POST"])]))

    async def go(peer):
        transport = httpx.ASGITransport(app=app, client=(peer, 1))
        async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
            return await c.post("/mcp")

    assert asyncio.run(go("100.101.1.2")).status_code == 200
    assert asyncio.run(go("192.168.1.50")).status_code == 401


# ─── real sockets ───


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait(port, proc, timeout=20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise AssertionError(proc.stderr.read() if proc.stderr else "exited")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return
        except OSError:
            time.sleep(0.1)
    raise AssertionError("server did not start")


def _status(url, headers=None, method="GET"):
    try:
        with urlopen(Request(url, headers=headers or {}, method=method), timeout=5) as r:
            return r.status
    except HTTPError as e:
        return e.code


@pytest.mark.real_tailnet
def test_real_socket_own_tailscale_ip_needs_token(vaults_root):
    """Self-request over this host's Tailscale address. NOT evidence about a remote node —
    it only shows the gate refuses a tailnet-routed source without a token."""
    access._TS_CACHE.clear()
    ips = sorted(ip for ip in access._tailscale_self_ips() if "." in ip)
    if not ips:
        pytest.skip("Tailscale not running on this host")
    from raven.core.vault import Vault

    Vault.create("alpha", vaults_root / "alpha")
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if k not in {"RAVEN_HOST", "FORWARDED_ALLOW_IPS"}}
    env.update(WIKI_VAULTS_DIR=str(vaults_root), RAVEN_ALLOW_REMOTE="1")
    proc = subprocess.Popen([sys.executable, "-m", "raven.api", "--host", "0.0.0.0", "--port", str(port)],
                            cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        _wait(port, proc)
        base = f"http://{ips[0]}:{port}"
        assert _status(f"{base}/api/vaults") == 401
        assert _status(f"{base}/api/vaults", {"Authorization": "Bearer rvn_wrong_token_x"}) == 401
        assert _status(f"{base}/api/vaults/alpha?force=true", method="DELETE") == 401
        assert (vaults_root / "alpha").exists()
        token = mcp_tokens.add_token("ts-self")
        assert _status(f"{base}/api/vaults", {"Authorization": f"Bearer {token}"}) == 200
        assert _status(f"http://127.0.0.1:{port}/api/vaults") == 200
    finally:
        proc.terminate()
        proc.wait(timeout=8)


def test_real_websocket_handshake_without_token_is_refused(vaults_root):
    """A real uvicorn + websockets handshake from a non-loopback source never upgrades."""
    websockets = pytest.importorskip("websockets.sync.client")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 9))
        lan = sock.getsockname()[0]
    except OSError:
        pytest.skip("no LAN IP")
    finally:
        sock.close()
    if lan.startswith(("127.", "100.")):
        pytest.skip("no LAN IP")
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if k not in {"RAVEN_HOST", "FORWARDED_ALLOW_IPS"}}
    env.update(WIKI_VAULTS_DIR=str(vaults_root), RAVEN_ALLOW_REMOTE="1")
    proc = subprocess.Popen([sys.executable, "-m", "raven.api", "--host", "0.0.0.0", "--port", str(port)],
                            cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        _wait(port, proc)
        with pytest.raises(Exception) as exc:
            websockets.connect(f"ws://{lan}:{port}/ws", open_timeout=5).close()
        assert "403" in str(exc.value) or "rejected" in str(exc.value).lower(), exc.value
    finally:
        proc.terminate()
        proc.wait(timeout=8)


def test_cross_origin_dashboard_can_read_the_auth_challenge(vaults_root):
    """E2E regression: a remote host's 401 is cross-origin for the dashboard (Tauri or
    a local dashboard). `WWW-Authenticate` is not CORS-safelisted, so without
    `Access-Control-Expose-Headers` the browser hides it and the token prompt never opens."""
    res = _call("GET", "/api/vaults", "100.101.1.2", {"Origin": "http://127.0.0.1:18953"})
    assert res.status_code == 401
    assert res.headers.get("access-control-allow-origin") == "http://127.0.0.1:18953"
    exposed = [h.strip().lower() for h in res.headers.get("access-control-expose-headers", "").split(",")]
    assert "www-authenticate" in exposed, res.headers

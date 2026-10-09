"""PR #27 review — MCP and the Core API judge the effective source identically.

Complements tests/test_core_api_forwarded.py (Core API XFF matrix) for the MCP gate:

  1. Same (socket peer, forwarding headers, launcher/strict mode) → same verdict from
     `TokenGate` (Core API) and `LanTokenAuth` (MCP), including XFF chains, repeated
     XFF header lines, IPv4-mapped IPv6 and Forwarded / X-Real-IP / Host / Origin.
  2. Loopback trust from XFF exists only when the socket peer is loopback *and* every
     XFF hop after the real client is loopback. A remote peer's XFF is never read; a
     direct loopback client adding XFF can only lower its own trust, never borrow it.
  3. Real sockets: a LAN client reaching loopback-bound standalone MCP through a local
     XFF-appending proxy needs a token, even when it sends `X-Forwarded-For: 127.0.0.1`.

Policy is unchanged here; these are regression guards only. Temporary vaults only.
"""
from __future__ import annotations

import asyncio
import http.client
import http.server
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from raven.core import access, mcp_tokens
from raven.core.access import TokenGate
from raven.mcp.auth import LanTokenAuth

REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def vaults_root(tmp_path, monkeypatch):
    root = tmp_path / "vaults"
    root.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(root))
    return root


def _inner():
    async def ok(_r):
        return PlainTextResponse("ok")

    return Starlette(routes=[Route("/x", ok, methods=["GET", "POST"])])


def _status(gate_cls, peer, headers: list[tuple[str, str]]):
    transport = httpx.ASGITransport(app=gate_cls(_inner()), client=(peer, 40000))

    async def go():
        async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
            return (await c.post("/x", headers=httpx.Headers(headers))).status_code

    return asyncio.run(go())


PEERS = ["127.0.0.1", "127.8.8.8", "::1", "::ffff:127.0.0.1", "100.101.1.2",
         "fd7a:115c:a1e0::9", "::ffff:100.101.1.2", "192.168.1.50", "172.18.0.1", "100.64.200.10"]

HEADER_SETS = [
    [],
    [("X-Forwarded-For", "127.0.0.1")],
    [("X-Forwarded-For", "::ffff:127.0.0.1")],
    [("X-Forwarded-For", "[::1]:5555")],
    [("X-Forwarded-For", "127.0.0.1, 127.0.0.1")],
    [("X-Forwarded-For", "127.0.0.1, 192.168.1.50")],          # spoof + real client appended
    [("X-Forwarded-For", "192.168.1.50, 127.0.0.1")],          # LAN client, two local hops
    [("X-Forwarded-For", "100.101.1.2")],
    [("X-Forwarded-For", "::ffff:100.101.1.2")],
    [("X-Forwarded-For", "127.0.0.1"), ("X-Forwarded-For", "192.168.1.50")],  # repeated lines
    [("X-Forwarded-For", "192.168.1.50"), ("X-Forwarded-For", "127.0.0.1")],
    [("X-Forwarded-For", "garbage")],
    [("X-Forwarded-For", "")],
    [("Forwarded", "for=127.0.0.1")],
    [("X-Real-IP", "127.0.0.1")],
    [("Host", "127.0.0.1"), ("Origin", "http://127.0.0.1")],
    [("Host", "localhost"), ("Origin", "tauri://localhost")],
]


@pytest.mark.parametrize("mode", ["launcher", "strict"])
@pytest.mark.parametrize("peer", PEERS)
@pytest.mark.parametrize("headers", HEADER_SETS, ids=lambda h: repr(h)[:60])
def test_core_api_and_mcp_gates_agree(vaults_root, monkeypatch, mode, peer, headers):
    monkeypatch.setattr(access, "_socket_peer", mode == "launcher")
    api = _status(TokenGate, peer, headers)
    mcp = _status(LanTokenAuth, peer, headers)
    assert api == mcp, (mode, peer, headers, api, mcp)
    assert api in (200, 401)


def _expected(mode, peer, headers):
    """The contract, spelled out independently of the implementation."""
    names = [k.lower() for k, _ in headers]
    forwarding = [k for k in names if k in ("x-forwarded-for", "forwarded", "x-real-ip")]
    loop = access.is_loopback_client
    if not forwarding:
        return 200 if loop(peer) else 401
    if mode == "strict" or not loop(peer):
        return 401
    if any(k != "x-forwarded-for" for k in forwarding):
        return 401
    hops = ",".join(v for k, v in headers if k.lower() == "x-forwarded-for").split(",")
    hops = [h.strip() for h in hops]
    for h in reversed(hops):
        if h.startswith("["):
            h = h[1:h.find("]")] if "]" in h else ""
        elif h.count(":") == 1:
            h = h.split(":", 1)[0]
        if not h or access._parse_ip(h) is None:
            return 401
        if not loop(h):
            return 401  # the first non-loopback hop from the right is the client: needs a token
    return 200


@pytest.mark.parametrize("mode", ["launcher", "strict"])
@pytest.mark.parametrize("peer", PEERS)
@pytest.mark.parametrize("headers", HEADER_SETS, ids=lambda h: repr(h)[:60])
def test_mcp_gate_matches_the_written_contract(vaults_root, monkeypatch, mode, peer, headers):
    monkeypatch.setattr(access, "_socket_peer", mode == "launcher")
    assert _status(LanTokenAuth, peer, headers) == _expected(mode, peer, headers), (mode, peer, headers)


# Known gap (reported in the PR #27 review, policy unchanged): when a loopback peer sends
# X-Forwarded-For *and* Forwarded / X-Real-IP, the gate reads XFF only and ignores the
# others. Exploitable only through an unofficial local proxy that passes the client's
# own XFF through untouched while recording the real address elsewhere (e.g. nginx with
# just `proxy_set_header X-Real-IP $remote_addr`) — the approved "unsupported proxy"
# residual risk. Shipped proxies (vite xfwd appends, spa_server rewrites) never produce
# this shape. strict xfail: flips to a failure when the gate fails closed here.
@pytest.mark.xfail(strict=True, reason="XFF read alone when Forwarded/X-Real-IP also present (reported)")
@pytest.mark.parametrize("gate_cls", [TokenGate, LanTokenAuth])
@pytest.mark.parametrize("other", [("X-Real-IP", "192.168.1.50"), ("Forwarded", "for=192.168.1.50")])
def test_known_gap_xff_with_other_forwarding_header_from_loopback(vaults_root, monkeypatch, gate_cls, other):
    monkeypatch.setattr(access, "_socket_peer", True)
    assert _status(gate_cls, "127.0.0.1", [("X-Forwarded-For", "127.0.0.1"), other]) == 401


def test_direct_loopback_client_cannot_gain_anything_from_xff(vaults_root, monkeypatch):
    """No proxy in between: XFF can only lower a loopback client's trust."""
    monkeypatch.setattr(access, "_socket_peer", True)
    assert _status(LanTokenAuth, "127.0.0.1", []) == 200
    assert _status(LanTokenAuth, "127.0.0.1", [("X-Forwarded-For", "127.0.0.1")]) == 200
    assert _status(LanTokenAuth, "127.0.0.1", [("X-Forwarded-For", "192.168.1.50")]) == 401
    # a remote peer claiming loopback via XFF gets nothing
    for peer in ("192.168.1.50", "100.101.1.2", "::ffff:192.168.1.50"):
        assert _status(LanTokenAuth, peer, [("X-Forwarded-For", "127.0.0.1")]) == 401, peer


def test_real_mcp_app_agrees_on_rejections(vaults_root, monkeypatch):
    """The real gated MCP app (not a stub) refuses the same spoofs before any MCP handling."""
    from raven.mcp.cli import build_http_app

    monkeypatch.setattr(access, "_socket_peer", True)
    app = build_http_app("admin", "0.0.0.0")
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    cases = [("192.168.1.50", [("X-Forwarded-For", "127.0.0.1")]),
             ("127.0.0.1", [("X-Forwarded-For", "127.0.0.1, 192.168.1.50")]),
             ("127.0.0.1", [("X-Forwarded-For", "127.0.0.1"), ("X-Forwarded-For", "100.101.1.2")]),
             ("::ffff:100.101.1.2", [("X-Forwarded-For", "::ffff:127.0.0.1")]),
             ("127.0.0.1", [("Forwarded", "for=127.0.0.1")])]
    for peer, headers in cases:
        transport = httpx.ASGITransport(app=app, client=(peer, 40000))

        async def go():
            async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
                return await c.post("/mcp", content=body, headers=httpx.Headers(
                    headers + [("Accept", "application/json, text/event-stream"),
                               ("Content-Type", "application/json")]))

        res = asyncio.run(go())
        assert res.status_code == 401, (peer, headers, res.status_code)
        assert res.headers["www-authenticate"] == 'Bearer realm="raven-mcp"'


# ─── real sockets: LAN client → local XFF proxy → loopback-bound standalone MCP ───


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))
        ip = s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()
    addr = access._parse_ip(ip)
    if addr is None or addr.is_loopback or any(addr in n for n in access.TAILNET_NETWORKS):
        return None
    return ip


def _start_proxy(upstream_port):
    """Appends the real peer to X-Forwarded-For, like vite `xfwd: true`."""

    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _fwd(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else None
            headers = {k: v for k, v in self.headers.items() if k.lower() not in ("connection", "content-length")}
            prior = self.headers.get("X-Forwarded-For")
            headers["X-Forwarded-For"] = f"{prior}, {self.client_address[0]}" if prior else self.client_address[0]
            conn = http.client.HTTPConnection("127.0.0.1", upstream_port, timeout=10)
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            conn.close()

        do_GET = do_POST = do_DELETE = _fwd

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("0.0.0.0", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_real_local_xff_proxy_in_front_of_standalone_mcp(vaults_root):
    lan = _lan_ip()
    if lan is None:
        pytest.skip("no LAN IPv4 on this host")
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if k not in {"RAVEN_HOST", "FORWARDED_ALLOW_IPS"}}
    env.update(WIKI_VAULTS_DIR=str(vaults_root), PYTHONPATH=str(REPO_ROOT), FORWARDED_ALLOW_IPS="*")
    proc = subprocess.Popen([sys.executable, "-m", "raven.mcp.cli", "--transport", "http",
                             "--host", "127.0.0.1", "--port", str(port), "--mode", "admin"],
                            cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    proxy = _start_proxy(port)
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.3).close()
                break
            except OSError:
                time.sleep(0.1)
        pport = proxy.server_address[1]
        init = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "p", "version": "0"}}})
        hdr = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}

        def post(host, extra=None):
            with httpx.Client(timeout=10) as c:
                return c.post(f"http://{host}:{pport}/mcp", content=init, headers={**hdr, **(extra or {})}).status_code

        assert post("127.0.0.1") == 200                                   # local client via proxy
        assert post(lan) == 401                                           # LAN client via proxy
        assert post(lan, {"X-Forwarded-For": "127.0.0.1"}) == 401         # LAN spoofs loopback
        assert post(lan, {"X-Real-IP": "127.0.0.1"}) == 401
        assert post(lan, {"Host": "127.0.0.1", "Origin": "http://127.0.0.1"}) == 401
        token = mcp_tokens.add_token("via-proxy")
        assert post(lan, {"Authorization": f"Bearer {token}"}) == 200
    finally:
        proxy.shutdown()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

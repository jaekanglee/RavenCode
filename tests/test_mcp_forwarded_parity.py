"""PR #27 review — MCP and the Core API judge the effective source identically.

Complements tests/test_core_api_forwarded.py (Core API XFF matrix) for the MCP gate:

  1. Same (socket peer, forwarding headers, launcher/strict mode) → same verdict from
     `TokenGate` (Core API) and `LanTokenAuth` (MCP), including XFF chains, repeated
     XFF header lines, IPv4-mapped IPv6 and Forwarded / X-Real-IP / Host / Origin.
     Since Issue #67 that verdict is 401 for every tokenless request — loopback too —
     and 200 with a valid token, whatever the headers say.
  2. The effective source (`access.effective_client`) — which still decides the
     this-PC-only endpoints (#15) and the 401 text — is loopback only when the socket
     peer is loopback *and* every XFF hop after the real client is loopback. A remote
     peer's XFF is never read; a direct loopback client adding XFF can only lower its
     own standing, never borrow it.
  3. Real sockets: through a local XFF-appending proxy in front of loopback-bound
     standalone MCP, every client needs a token — local or LAN, spoofed headers or not.

Temporary vaults only.
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
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as c:
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
    # Issue #29: XFF together with another client-address header, and those headers alone.
    [("X-Forwarded-For", "127.0.0.1"), ("X-Real-IP", "192.168.1.50")],
    [("X-Forwarded-For", "127.0.0.1"), ("Forwarded", "for=192.168.1.50")],
    [("X-Forwarded-For", "192.168.1.50"), ("X-Real-IP", "192.168.1.50")],
    [("X-Forwarded-For", "127.0.0.1"), ("True-Client-IP", "192.168.1.50")],
    [("X-Forwarded-For", "127.0.0.1"), ("CF-Connecting-IP", "192.168.1.50")],
    [("True-Client-IP", "127.0.0.1")],
    [("X-Client-IP", "192.168.1.50")],
]


@pytest.mark.parametrize("mode", ["launcher", "strict"])
@pytest.mark.parametrize("peer", PEERS)
@pytest.mark.parametrize("headers", HEADER_SETS, ids=lambda h: repr(h)[:60])
def test_core_api_and_mcp_gates_agree(vaults_root, monkeypatch, mode, peer, headers):
    monkeypatch.setattr(access, "_socket_peer", mode == "launcher")
    api = _status(TokenGate, peer, headers)
    mcp = _status(LanTokenAuth, peer, headers)
    assert api == mcp, (mode, peer, headers, api, mcp)
    assert api == 401  # Issue #67: no tokenless pass for any source


def _expected_loopback_source(mode, peer, headers):
    """Is the effective source this PC? The contract, spelled out independently of the implementation."""
    names = [k.lower() for k, _ in headers]
    client_headers = ("x-forwarded-for", "forwarded", "x-real-ip", "x-client-ip", "true-client-ip",
                      "cf-connecting-ip", "fastly-client-ip", "x-cluster-client-ip")
    forwarding = [k for k in names if k in client_headers]
    loop = access.is_loopback_client
    if not forwarding:
        return bool(loop(peer))
    if mode == "strict" or not loop(peer):
        return False
    if any(k != "x-forwarded-for" for k in forwarding):
        return False
    hops = ",".join(v for k, v in headers if k.lower() == "x-forwarded-for").split(",")
    hops = [h.strip() for h in hops]
    for h in reversed(hops):
        if h.startswith("["):
            h = h[1:h.find("]")] if "]" in h else ""
        elif h.count(":") == 1:
            h = h.split(":", 1)[0]
        if not h or access._parse_ip(h) is None:
            return False
        if not loop(h):
            return False  # the first non-loopback hop from the right is the client
    return True


@pytest.mark.parametrize("mode", ["launcher", "strict"])
@pytest.mark.parametrize("peer", PEERS)
@pytest.mark.parametrize("headers", HEADER_SETS, ids=lambda h: repr(h)[:60])
def test_mcp_gate_matches_the_written_contract(vaults_root, monkeypatch, mode, peer, headers):
    monkeypatch.setattr(access, "_socket_peer", mode == "launcher")
    # Issue #67: no source is exempt — every tokenless request is refused ...
    assert _status(LanTokenAuth, peer, headers) == 401, (mode, peer, headers)
    # ... and the source the gate reports downstream follows the written contract.
    scope = {"client": (peer, 40000), "headers": [(k.lower().encode(), v.encode()) for k, v in headers]}
    assert access.is_loopback_client(access.effective_client(scope)) == _expected_loopback_source(
        mode, peer, headers), (mode, peer, headers)


@pytest.mark.parametrize("mode", ["launcher", "strict"])
@pytest.mark.parametrize("peer", ["127.0.0.1", "::1", "192.168.1.50", "100.101.1.2"])
@pytest.mark.parametrize("headers", HEADER_SETS, ids=lambda h: repr(h)[:60])
def test_a_valid_token_passes_whatever_the_headers_say(vaults_root, monkeypatch, mode, peer, headers):
    monkeypatch.setattr(access, "_socket_peer", mode == "launcher")
    token = mcp_tokens.add_token("any")
    auth = headers + [("Authorization", f"Bearer {token}")]
    assert _status(TokenGate, peer, auth) == _status(LanTokenAuth, peer, auth) == 200


# Issue #29 (reported in the PR #27 review as a strict xfail): a loopback peer sending
# X-Forwarded-For *and* another client-address header used to be judged by XFF alone —
# an unofficial local proxy that passes the client's own XFF through untouched while
# recording the real address elsewhere (e.g. nginx with just
# `proxy_set_header X-Real-IP $remote_addr`) let `X-Forwarded-For: 127.0.0.1` through
# without a token. Now the source is unknown and a token is required.
OTHER_CLIENT_HEADERS = [
    ("X-Real-IP", "192.168.1.50"),
    ("Forwarded", "for=192.168.1.50"),
    ("Forwarded", 'for="[2001:db8::1]:4711"'),
    ("X-Client-IP", "192.168.1.50"),
    ("True-Client-IP", "192.168.1.50"),
    ("CF-Connecting-IP", "192.168.1.50"),
    ("Fastly-Client-IP", "192.168.1.50"),
    ("X-Cluster-Client-IP", "192.168.1.50"),
    # Even when the other header also says loopback: two disagreeing conventions
    # cannot be told apart from a spoof.
    ("X-Real-IP", "127.0.0.1"),
]


@pytest.mark.parametrize("gate_cls", [TokenGate, LanTokenAuth])
@pytest.mark.parametrize("other", OTHER_CLIENT_HEADERS)
@pytest.mark.parametrize("xff", ["127.0.0.1", "127.0.0.1, 127.0.0.1", "::1"])
def test_xff_with_another_client_header_from_loopback_needs_a_token(vaults_root, monkeypatch, gate_cls, other, xff):
    monkeypatch.setattr(access, "_socket_peer", True)
    assert _status(gate_cls, "127.0.0.1", [("X-Forwarded-For", xff), other]) == 401
    assert _status(gate_cls, "127.0.0.1", [other, ("X-Forwarded-For", xff)]) == 401  # order does not matter
    assert access.effective_client({"client": ("127.0.0.1", 1), "headers": [
        (b"x-forwarded-for", xff.encode()), (other[0].lower().encode(), other[1].encode())]}) is None


@pytest.mark.parametrize("gate_cls", [TokenGate, LanTokenAuth])
def test_a_token_still_passes_with_any_forwarding_headers(vaults_root, monkeypatch, gate_cls):
    monkeypatch.setattr(access, "_socket_peer", True)
    token = mcp_tokens.add_token("issue29")
    headers = [("X-Forwarded-For", "127.0.0.1"), ("X-Real-IP", "192.168.1.50"), ("Authorization", f"Bearer {token}")]
    assert _status(gate_cls, "127.0.0.1", headers) == 200


def _source(peer, headers):
    return access.effective_client({"client": (peer, 1), "headers": [(k.lower().encode(), v.encode()) for k, v in headers]})


def test_the_xff_only_proxy_path_is_unchanged(vaults_root, monkeypatch):
    """vite `xfwd` sends XFF plus X-Forwarded-Port/-Proto/-Host — none of those name a client."""
    monkeypatch.setattr(access, "_socket_peer", True)
    vite = [("X-Forwarded-For", "127.0.0.1"), ("X-Forwarded-Port", "5173"),
            ("X-Forwarded-Proto", "http"), ("X-Forwarded-Host", "127.0.0.1:5173")]
    lan = [("X-Forwarded-For", "192.168.1.50")] + vite[1:]
    assert _source("127.0.0.1", vite) == "127.0.0.1"
    assert _source("127.0.0.1", lan) == "192.168.1.50"
    token = mcp_tokens.add_token("vite")
    for gate_cls in (TokenGate, LanTokenAuth):
        assert _status(gate_cls, "127.0.0.1", vite) == 401  # #67: no tokenless pass, local browser included
        assert _status(gate_cls, "127.0.0.1", lan) == 401
        assert _status(gate_cls, "127.0.0.1", vite + [("Authorization", f"Bearer {token}")]) == 200


def test_direct_loopback_client_cannot_gain_anything_from_xff(vaults_root, monkeypatch):
    """No proxy in between: XFF can only lower a loopback client's standing, and never skips the token."""
    monkeypatch.setattr(access, "_socket_peer", True)
    assert _source("127.0.0.1", []) == "127.0.0.1"
    assert _source("127.0.0.1", [("X-Forwarded-For", "127.0.0.1")]) == "127.0.0.1"
    assert _source("127.0.0.1", [("X-Forwarded-For", "192.168.1.50")]) == "192.168.1.50"
    for headers in ([], [("X-Forwarded-For", "127.0.0.1")], [("X-Forwarded-For", "192.168.1.50")]):
        assert _status(LanTokenAuth, "127.0.0.1", headers) == 401, headers
    # a remote peer claiming loopback via XFF gets nothing — not even a loopback source
    for peer in ("192.168.1.50", "100.101.1.2", "::ffff:192.168.1.50"):
        assert _status(LanTokenAuth, peer, [("X-Forwarded-For", "127.0.0.1")]) == 401, peer
        assert not access.is_loopback_client(_source(peer, [("X-Forwarded-For", "127.0.0.1")])), peer


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
            async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as c:
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

        assert post("127.0.0.1") == 401                                   # local client via proxy (#67)
        assert post(lan) == 401                                           # LAN client via proxy
        assert post(lan, {"X-Forwarded-For": "127.0.0.1"}) == 401         # LAN spoofs loopback
        assert post(lan, {"X-Real-IP": "127.0.0.1"}) == 401
        assert post(lan, {"Host": "127.0.0.1", "Origin": "http://127.0.0.1"}) == 401
        assert post(lan, {"Authorization": "Bearer rvn_wrong_token"}) == 401
        token = mcp_tokens.add_token("via-proxy")
        assert post("127.0.0.1", {"Authorization": f"Bearer {token}"}) == 200
        assert post(lan, {"Authorization": f"Bearer {token}"}) == 200
    finally:
        proxy.shutdown()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

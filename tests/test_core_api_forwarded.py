"""Forwarded-header trust (PR #21 re-review P0).

The access gate trusts loopback/tailnet *sources*. uvicorn's ProxyHeadersMiddleware
rewrites ``scope["client"]`` from ``X-Forwarded-For`` *before* the app runs whenever
the peer matches ``forwarded_allow_ips`` (``--forwarded-allow-ips`` /
``FORWARDED_ALLOW_IPS``). With ``'*'`` a LAN host could send
``X-Forwarded-For: 127.0.0.1`` and arrive at the gate as loopback.

Contract:
  1. **Strict mode** (default — any server the gate did not configure itself, e.g.
     ``uvicorn raven.api:app``): a request carrying ``X-Forwarded-For`` /
     ``Forwarded`` / ``X-Real-IP`` gets no source-based trust at all → token required.
     uvicorn only rewrites the client when that header is present, so whatever
     ``forwarded_allow_ips`` says, a rewritten client can never be trusted.
  2. **Launcher mode** (``python -m raven.api``, desktop runtime — they run uvicorn
     with ``proxy_headers=False`` so ``scope["client"]`` is the real socket peer):
     the gate reads ``X-Forwarded-For`` itself, and only from a loopback peer (a proxy
     on this machine, e.g. the vite dev server with ``xfwd``). It walks the list from
     the right, skipping loopback hops; the first other entry is the source. A
     non-loopback peer's forwarding headers grant nothing. ``FORWARDED_ALLOW_IPS`` is
     ignored.
  3. Downstream handlers see the gate's effective source in ``request.client`` (so
     ``_require_loopback`` cannot be fooled either); an unknown source becomes
     ``"unknown"``.
"""
from __future__ import annotations

import asyncio
import http.server
import json
import os
import select
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from urllib.error import HTTPError

import httpx
import pytest

from raven.core import access, mcp_tokens

REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def vaults_root(tmp_path, monkeypatch):
    root = tmp_path / "vaults"
    root.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(root))
    return root


@pytest.fixture
def launcher_mode(monkeypatch):
    monkeypatch.setattr(access, "_socket_peer", True)


@pytest.fixture
def strict_mode(monkeypatch):
    monkeypatch.setattr(access, "_socket_peer", False)


def _call(method, path, peer, headers=None, **kw):
    from raven.api import app

    transport = httpx.ASGITransport(app=app, client=(peer, 44444))

    async def go():
        async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
            return await c.request(method, path, headers=headers or {}, **kw)

    return asyncio.run(go())


# ─── 1. strict mode — forwarding headers never earn source trust ───


@pytest.mark.parametrize("peer", ["127.0.0.1", "::1", "100.100.1.2", "192.168.1.50"])
@pytest.mark.parametrize(
    "headers",
    [
        {"X-Forwarded-For": "127.0.0.1"},
        {"X-Forwarded-For": "100.100.100.100"},
        {"X-Forwarded-For": "192.168.1.9, 127.0.0.1"},
        {"Forwarded": "for=127.0.0.1"},
        {"X-Real-IP": "127.0.0.1"},
    ],
)
def test_strict_mode_forwarding_headers_need_a_token(vaults_root, strict_mode, peer, headers):
    # The peer may already be the *result* of an upstream rewrite we cannot see.
    assert _call("GET", "/api/vaults", peer, headers).status_code == 401, (peer, headers)


def test_strict_mode_without_forwarding_headers_is_unchanged(vaults_root, strict_mode):
    assert _call("GET", "/api/vaults", "127.0.0.1").status_code == 200
    assert _call("GET", "/api/vaults", "100.100.1.2").status_code == 200
    assert _call("GET", "/api/vaults", "192.168.1.50").status_code == 401


def test_strict_mode_token_still_works_but_handlers_see_unknown_source(vaults_root, strict_mode, tmp_path):
    token = mcp_tokens.add_token("t")
    auth = {"Authorization": f"Bearer {token}", "X-Forwarded-For": "127.0.0.1"}
    assert _call("GET", "/api/vaults", "127.0.0.1", auth).status_code == 200
    # path-taking loopback-only endpoint must not believe the (possibly rewritten) client
    res = _call("POST", "/api/backup/export", "127.0.0.1", auth, json={"dest_path": str(tmp_path / "x.zip")})
    assert res.status_code == 403, res.text


# ─── 2. launcher mode — the gate does its own, narrow XFF handling ───


@pytest.mark.parametrize(
    "xff, expected",
    [
        ("127.0.0.1", 200),                         # local browser via local proxy
        ("::ffff:127.0.0.1", 200),                  # node reports v4-mapped
        ("100.101.1.2", 200),                       # tailnet browser via local proxy
        ("fd7a:115c:a1e0::9", 200),
        ("192.168.1.50", 401),                      # LAN browser via local proxy
        ("127.0.0.1, 192.168.1.50", 401),           # LAN spoofs loopback, proxy appends real IP
        ("100.101.1.2, 192.168.1.50", 401),         # LAN spoofs tailnet
        ("192.168.1.50, 127.0.0.1", 401),           # two local hops; real client is LAN
        ("192.168.1.50,127.0.0.1,127.0.0.1", 401),
        ("127.0.0.1, 127.0.0.1", 200),
        ("garbage", 401),
        ("127.0.0.1, garbage", 401),
        ("", 401),
        ("192.168.1.50:5555", 401),
        ("[::1]:5555", 200),
    ],
)
def test_launcher_mode_reads_xff_only_from_loopback_proxy(vaults_root, launcher_mode, xff, expected):
    assert _call("GET", "/api/vaults", "127.0.0.1", {"X-Forwarded-For": xff}).status_code == expected, xff


@pytest.mark.parametrize("peer", ["192.168.1.50", "100.101.1.2", "10.0.0.3"])
def test_launcher_mode_ignores_forwarding_headers_from_non_loopback_peer(vaults_root, launcher_mode, peer):
    # a direct remote client cannot vouch for anyone — not even a tailnet peer acting as a proxy
    for h in ({"X-Forwarded-For": "127.0.0.1"}, {"Forwarded": "for=127.0.0.1"}, {"X-Real-IP": "127.0.0.1"}):
        assert _call("GET", "/api/vaults", peer, h).status_code == 401, (peer, h)


def test_launcher_mode_other_forwarding_headers_from_loopback_need_token(vaults_root, launcher_mode):
    for h in ({"Forwarded": "for=127.0.0.1"}, {"X-Real-IP": "127.0.0.1"}):
        assert _call("GET", "/api/vaults", "127.0.0.1", h).status_code == 401, h


def test_launcher_mode_handlers_see_effective_source(vaults_root, launcher_mode, tmp_path):
    token = mcp_tokens.add_token("t")
    auth = {"Authorization": f"Bearer {token}", "X-Forwarded-For": "192.168.1.50"}
    res = _call("POST", "/api/backup/export", "127.0.0.1", auth, json={"dest_path": str(tmp_path / "x.zip")})
    assert res.status_code == 403, res.text  # LAN via local proxy is not "this PC"


def test_mcp_gate_uses_the_same_forwarded_rule(vaults_root, strict_mode):
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    from raven.mcp.auth import LanTokenAuth

    async def ok(_r):
        return PlainTextResponse("ok")

    app = LanTokenAuth(Starlette(routes=[Route("/mcp", ok, methods=["POST"])]))
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 1))

    async def go():
        async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
            return await c.post("/mcp", headers={"X-Forwarded-For": "127.0.0.1"})

    assert asyncio.run(go()).status_code == 401


def test_launchers_run_uvicorn_without_proxy_headers(monkeypatch):
    from raven.api.main import main as api_main

    captured = {}
    monkeypatch.setattr("raven.api.main.uvicorn.run", lambda app, **kw: captured.update(kw))
    monkeypatch.delenv("RAVEN_HOST", raising=False)
    monkeypatch.setattr(access, "_socket_peer", False)
    assert api_main([]) == 0
    assert captured["proxy_headers"] is False
    assert access._socket_peer is True


# ─── 3. real uvicorn processes (LAN source = this machine's LAN IP) ───


def _lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))
        ip = s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()
    return None if ip.startswith(("127.", "100.")) else ip


@pytest.fixture
def lan_ip():
    ip = _lan_ip()
    if ip is None:
        pytest.skip("no non-loopback, non-tailnet IPv4 on this host")
    return ip


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _env(vaults_root, **extra):
    env = {k: v for k, v in os.environ.items()
           if k not in {"RAVEN_HOST", "RAVEN_DESKTOP_HOST", "RAVEN_ALLOW_REMOTE",
                        "FORWARDED_ALLOW_IPS", "WIKI_VAULTS_DIR"}}
    env["WIKI_VAULTS_DIR"] = str(vaults_root)
    env.update(extra)
    return env


def _wait(port, proc, timeout=20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise AssertionError(f"exited early: {proc.stderr.read() if proc.stderr else ''}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return
        except OSError:
            time.sleep(0.1)
    raise AssertionError("server did not start")


def _status(url, headers=None, method="GET"):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}, method=method), timeout=5) as r:
            return r.status
    except HTTPError as e:
        return e.code


def _stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()


SPOOFS = [
    {"X-Forwarded-For": "127.0.0.1"},
    {"X-Forwarded-For": "100.100.100.100"},
    {"X-Forwarded-For": "::1"},
    {"X-Forwarded-For": "127.0.0.1, 127.0.0.1"},
    {"Forwarded": "for=127.0.0.1"},
    {"X-Real-IP": "127.0.0.1"},
]


def _assert_spoofs_refused(base, vaults_root):
    from raven.core.vault import Vault

    Vault.create("alpha", vaults_root / "alpha")
    for h in SPOOFS:
        assert _status(f"{base}/api/vaults", h) == 401, h
        assert _status(f"{base}/api/vaults/alpha?force=true", h, method="DELETE") == 401, h
    assert (vaults_root / "alpha").exists()


@pytest.mark.parametrize(
    "argv_extra, env_extra",
    [
        (["--forwarded-allow-ips", "*"], {}),
        ([], {"FORWARDED_ALLOW_IPS": "*"}),
        (["--forwarded-allow-ips", "*", "--proxy-headers"], {}),
    ],
    ids=["flag", "env", "flag+proxy-headers"],
)
def test_real_direct_uvicorn_with_wildcard_forwarded_ips(vaults_root, lan_ip, argv_extra, env_extra):
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "raven.api:app", "--host", "0.0.0.0", "--port", str(port),
         "--log-level", "warning", *argv_extra],
        cwd=REPO_ROOT, env=_env(vaults_root, **env_extra),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        _wait(port, proc)
        _assert_spoofs_refused(f"http://{lan_ip}:{port}", vaults_root)
        assert _status(f"http://127.0.0.1:{port}/api/vaults") == 200
    finally:
        _stop(proc)


def test_real_standalone_ignores_forwarded_allow_ips_env(vaults_root, lan_ip):
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "raven.api", "--host", "0.0.0.0", "--port", str(port)],
        cwd=REPO_ROOT, env=_env(vaults_root, RAVEN_ALLOW_REMOTE="1", FORWARDED_ALLOW_IPS="*"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        _wait(port, proc)
        _assert_spoofs_refused(f"http://{lan_ip}:{port}", vaults_root)
        assert _status(f"http://127.0.0.1:{port}/api/vaults") == 200
    finally:
        _stop(proc)


def test_real_desktop_api_and_mcp_ignore_forwarded_allow_ips_env(vaults_root, lan_ip):
    mcp_port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "raven.desktop.runtime", "--host", "0.0.0.0", "--mcp",
         "--mcp-port", str(mcp_port)],
        cwd=REPO_ROOT,
        env=_env(vaults_root, RAVEN_ALLOW_REMOTE="1", FORWARDED_ALLOW_IPS="*", PORT_API=str(_free_port())),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 25
        ready = None
        while time.monotonic() < deadline and ready is None:
            r, _, _ = select.select([proc.stdout], [], [], 0.1)
            if r:
                ready = json.loads(proc.stdout.readline())
            elif proc.poll() is not None:
                raise AssertionError(proc.stderr.read())
        assert ready and ready.get("mcp_port") == mcp_port, ready
        _assert_spoofs_refused(f"http://{lan_ip}:{ready['port']}", vaults_root)
        for h in SPOOFS:
            assert _status(f"http://{lan_ip}:{mcp_port}/mcp", h, method="POST") == 401, h
    finally:
        _stop(proc)


class _XffProxy(http.server.ThreadingHTTPServer):
    """Minimal forwarding proxy that appends the client IP like vite's ``xfwd: true``."""


def _start_xff_proxy(upstream_port):
    class H(http.server.BaseHTTPRequestHandler):
        def _fwd(self):
            prior = self.headers.get("X-Forwarded-For")
            xff = f"{prior}, {self.client_address[0]}" if prior else self.client_address[0]
            headers = {k: v for k, v in self.headers.items() if k.lower() not in {"host", "x-forwarded-for"}}
            headers["X-Forwarded-For"] = xff
            length = int(self.headers.get("Content-Length") or 0)
            body_in = self.rfile.read(length) if length else None
            req = urllib.request.Request(f"http://127.0.0.1:{upstream_port}{self.path}",
                                         data=body_in, headers=headers, method=self.command)
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    code, body = r.status, r.read()
            except HTTPError as e:
                code, body = e.code, e.read()
            self.send_response(code)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = do_DELETE = _fwd

        def log_message(self, *a):
            pass

    srv = _XffProxy(("0.0.0.0", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_real_local_xff_proxy_in_front_of_standalone(vaults_root, lan_ip, tmp_path):
    """raven.sh shape: loopback API + LAN-facing local proxy that appends XFF (vite xfwd)."""
    from raven.core.vault import Vault

    Vault.create("alpha", vaults_root / "alpha")
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "raven.api", "--port", str(port)],
        cwd=REPO_ROOT, env=_env(vaults_root, FORWARDED_ALLOW_IPS="*"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    proxy = _start_xff_proxy(port)
    try:
        _wait(port, proc)
        pport = proxy.server_address[1]
        assert _status(f"http://127.0.0.1:{pport}/api/vaults") == 200            # local browser
        assert _status(f"http://{lan_ip}:{pport}/api/vaults") == 401              # LAN browser
        assert _status(f"http://{lan_ip}:{pport}/api/vaults", {"X-Forwarded-For": "127.0.0.1"}) == 401
        assert _status(f"http://{lan_ip}:{pport}/api/vaults/alpha?force=true", method="DELETE") == 401
        token = mcp_tokens.add_token("lan")
        auth = {"Authorization": f"Bearer {token}"}
        assert _status(f"http://{lan_ip}:{pport}/api/vaults", auth) == 200
        # authenticated LAN user via the local proxy is still not "this PC"
        req_body = json.dumps({"dest_path": str(tmp_path / "x.zip")}).encode()
        req = urllib.request.Request(f"http://{lan_ip}:{pport}/api/backup/export", data=req_body,
                                     headers={**auth, "Content-Type": "application/json"}, method="POST")
        try:
            urllib.request.urlopen(req, timeout=5)
            code = 200
        except HTTPError as e:
            code = e.code
        assert code == 403
        assert (vaults_root / "alpha").exists()
    finally:
        proxy.shutdown()
        _stop(proc)

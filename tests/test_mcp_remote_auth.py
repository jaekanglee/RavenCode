"""Issue #26 — every non-loopback MCP HTTP request needs a Bearer token, tailnet included.

Before #26 the desktop MCP gate (`LanTokenAuth`) let route-judged tailnet peers in
without a token, and standalone `raven.mcp.cli` (`./raven.sh start`, the team
launchd instance, Docker `mcp-http`) had no gate at all and served uvicorn with
`forwarded_allow_ips="*"` + `proxy_headers=True` (any client could claim any address).

Contract (all MCP HTTP listeners — desktop runtime, standalone, team, Docker):
  1. direct loopback → no token.
  2. any other source — tailnet IPv4/IPv6 included, LAN, Docker/CGNAT — needs a valid
     `Authorization: Bearer` from `raven mcp token add`; missing/invalid → 401 before
     the MCP app runs: initialize, tools/list, tools/call, GET stream, DELETE session.
     No issued token → every non-loopback request is refused (fail-closed).
  3. X-Forwarded-For / Host / Origin cannot lift a source (Core API proxy policy).
  4. stdio is not a network listener — out of scope.

In-process tests run with conftest's fake tailnet: the route check *does* answer
"tailnet", so a 401 proves the policy, not a failed route lookup. Real-socket tests
use this host's own Tailscale address — NOT evidence about a remote tailnet node.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from raven.core import access, mcp_tokens

REPO_ROOT = Path(__file__).resolve().parents[1]
TAILNET = ["100.101.1.2", "100.64.0.1", "fd7a:115c:a1e0::77", "::ffff:100.101.1.2"]
OTHER = ["192.168.1.50", "10.0.0.7", "172.18.0.1", "fd00::5"]  # LAN, Docker bridge, ULA
# 100.64.200.0/24 = the Docker CGNAT test network: inside the tailnet range, so it is
# covered by TAILNET-style judgement here and by the real Docker E2E.
ACCEPT = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def _rpc(method, params=None, id_=1):
    return {"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}}


INITIALIZE = _rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                 "clientInfo": {"name": "probe", "version": "0"}})
LIST_TOOLS = _rpc("tools/list", id_=2)
DELETE_CALL = _rpc("tools/call", {"name": "wiki_delete",
                                  "arguments": {"vault": "alpha", "slug": "content/victim"}}, id_=3)


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vaults"
    root.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(root))
    from fastapi.testclient import TestClient

    from raven.api import app
    from raven.core.vault import Vault

    Vault.create("alpha", root / "alpha")
    with TestClient(app) as c:  # conftest: loopback peer
        for slug in ("content/victim", "content/keeper"):
            r = c.post("/api/vaults/alpha/pages", json={"slug": slug, "title": slug, "content": "x"})
            assert r.status_code == 200, r.text
    return root


def _victim(root: Path) -> Path:
    return root / "alpha" / "content" / "victim.md"


def _apps():
    from raven.desktop.runtime import _build_mcp_app
    from raven.mcp.cli import build_http_app

    return {"desktop": _build_mcp_app("admin", "0.0.0.0"), "standalone": build_http_app("admin", "0.0.0.0")}


def _call(app, peer, method="POST", body=None, headers=None):
    transport = httpx.ASGITransport(app=app, client=(peer, 44444))

    async def go():
        async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
            return await c.request(method, "/mcp", headers={**ACCEPT, **(headers or {})},
                                   content=json.dumps(body) if body is not None else None)

    return asyncio.run(go())


# ─── in-process: the gate sits in front of every MCP entry point ───


@pytest.mark.parametrize("launcher", ["desktop", "standalone"])
def test_both_launchers_wrap_the_mcp_app_in_the_gate(vault, launcher):
    from raven.mcp.auth import LanTokenAuth

    app = _apps()[launcher]
    assert isinstance(app, LanTokenAuth), launcher
    assert app.trust_tailnet is False


@pytest.mark.parametrize("launcher", ["desktop", "standalone"])
@pytest.mark.parametrize("peer", TAILNET + OTHER)
@pytest.mark.parametrize("body,method", [(INITIALIZE, "POST"), (LIST_TOOLS, "POST"),
                                         (DELETE_CALL, "POST"), (None, "GET"), (None, "DELETE")])
def test_non_loopback_mcp_without_token_is_refused(vault, launcher, peer, body, method):
    if peer in TAILNET:
        assert access.is_tailnet_peer(peer), "fixture precondition: route check says tailnet"
    res = _call(_apps()[launcher], peer, method, body)
    assert res.status_code == 401, (launcher, peer, method, res.status_code)
    assert res.headers["www-authenticate"] == 'Bearer realm="raven-mcp"'
    assert _victim(vault).exists()


@pytest.mark.parametrize("launcher", ["desktop", "standalone"])
def test_fail_closed_with_no_token_issued_and_wrong_token(vault, launcher):
    assert not (vault / ".mcp-tokens.json").exists()
    app = _apps()[launcher]
    assert _call(app, "100.101.1.2", body=DELETE_CALL,
                 headers={"Authorization": "Bearer rvn_not_issued_x"}).status_code == 401
    mcp_tokens.add_token("someone")
    assert _call(app, "100.101.1.2", body=DELETE_CALL,
                 headers={"Authorization": "Bearer rvn_wrong_token_x"}).status_code == 401
    assert _victim(vault).exists()


@pytest.mark.parametrize("launcher", ["desktop", "standalone"])
@pytest.mark.parametrize("headers", [
    {"X-Forwarded-For": "127.0.0.1"},
    {"X-Forwarded-For": "::1"},
    {"Forwarded": "for=127.0.0.1"},
    {"X-Real-IP": "127.0.0.1"},
    {"Host": "127.0.0.1:8766"},
    {"Origin": "http://127.0.0.1:8766"},
    {"Host": "localhost", "Origin": "tauri://localhost"},
])
def test_forged_headers_do_not_lift_a_remote_client(vault, launcher, headers):
    assert _call(_apps()[launcher], "100.101.1.2", body=DELETE_CALL, headers=headers).status_code == 401
    assert _call(_apps()[launcher], "192.168.1.50", body=DELETE_CALL, headers=headers).status_code == 401
    assert _victim(vault).exists()


def test_401_never_echoes_the_presented_token(vault):
    res = _call(_apps()["standalone"], "100.101.1.2", body=INITIALIZE,
                headers={"Authorization": "Bearer rvn_secret_value_zz"})
    assert res.status_code == 401
    assert "rvn_secret_value_zz" not in res.text
    assert "rvn_secret_value_zz" not in json.dumps(dict(res.headers))


def test_standalone_http_serves_with_the_core_api_proxy_policy(vault, monkeypatch):
    """`forwarded_allow_ips="*"` + `proxy_headers=True` let uvicorn rewrite the client
    from any X-Forwarded-For; the launcher must serve like the Core API (serve_kwargs)."""
    import uvicorn

    from raven.mcp import cli
    from raven.mcp.auth import LanTokenAuth

    seen = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: seen.update(app=app, **kw))
    monkeypatch.setattr(access, "_socket_peer", False)
    assert cli.main(["--transport", "http", "--host", "0.0.0.0", "--port", "1", "--mode", "admin"]) == 0
    assert isinstance(seen["app"], LanTokenAuth)
    assert seen.get("proxy_headers") is False
    assert "forwarded_allow_ips" not in seen
    assert access._socket_peer is True


# ─── real sockets: desktop runtime, standalone, team launchd args ───


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait(port, proc, timeout=30.0):
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


def _team_args():
    # plistlib refuses this file (its XML comments contain "--"); launchd does not.
    raw = (REPO_ROOT / "deploy/launchd/com.raven.mcp-team.plist").read_text(encoding="utf-8")
    raw = re.sub(r"<!--.*?-->", "", raw, flags=re.S)
    block = re.search(r"<key>ProgramArguments</key>\s*<array>(.*?)</array>", raw, re.S).group(1)
    return re.findall(r"<string>(.*?)</string>", block)


def _launch(kind, root):
    env = {k: v for k, v in os.environ.items()
           if k not in {"RAVEN_HOST", "FORWARDED_ALLOW_IPS", "RAVEN_MCP_HOST"}}
    env.update(WIKI_VAULTS_DIR=str(root), RAVEN_ALLOW_REMOTE="1", PYTHONPATH=str(REPO_ROOT))
    if kind == "desktop":
        cmd = [sys.executable, "-m", "raven.desktop.runtime", "--host", "0.0.0.0",
               "--mcp", "--mcp-mode", "admin", "--mcp-port", str(_free_port())]
    elif kind == "standalone":
        cmd = [sys.executable, "-m", "raven.mcp.cli", "--transport", "http",
               "--host", "0.0.0.0", "--port", str(_free_port()), "--mode", "admin"]
    else:  # team launchd instance — the plist's own arguments, repo python, free port
        args = _team_args()
        cmd = [sys.executable] + args[1:]
        cmd[cmd.index("--port") + 1] = str(_free_port())
    proc = subprocess.Popen(cmd, cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)
    if kind == "desktop":
        port = json.loads(proc.stdout.readline())["mcp_port"]
    else:
        port = int(cmd[cmd.index("--port") + 1])
    _wait(port, proc)
    return proc, port


def _stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def _post(url, body, headers=None):
    with httpx.Client(timeout=10) as c:
        return c.post(url, content=json.dumps(body), headers={**ACCEPT, **(headers or {})})


async def _sdk(url, token=None, call=None):
    import httpx2
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with httpx2.AsyncClient(timeout=20, headers=headers) as hc:
        async with streamable_http_client(url, http_client=hc) as (r, w, *_):
            async with ClientSession(r, w) as s:
                await s.initialize()
                names = [t.name for t in (await s.list_tools()).tools]
                result = await s.call_tool(*call) if call else None
                return names, result


def _sdk_run(url, token=None, call=None, timeout=25):
    return asyncio.run(asyncio.wait_for(_sdk(url, token, call), timeout))


def _remote_contract(url, root, team=False):
    """No token → 401 everywhere and wiki_delete never runs; forged headers too."""
    for body in (INITIALIZE, LIST_TOOLS, DELETE_CALL):
        res = _post(url, body)
        assert res.status_code == 401, (url, body["method"], res.status_code)
        assert res.headers["www-authenticate"] == 'Bearer realm="raven-mcp"'
    for forged in ({"X-Forwarded-For": "127.0.0.1"}, {"Host": "127.0.0.1"},
                   {"Origin": "http://127.0.0.1"}, {"Authorization": "Bearer rvn_wrong_token_x"}):
        assert _post(url, DELETE_CALL, forged).status_code == 401, forged
    assert _victim(root).exists()
    # the SDK (mcp 2.x) surfaces the 401 as a failed initialize — MCPError -32603
    # "Server returned an error response", no status code — not as a hang
    with pytest.raises(BaseException) as exc:
        _sdk_run(url)
    assert not isinstance(exc.value, (asyncio.TimeoutError, TimeoutError)), repr(exc.value)


@pytest.mark.parametrize("kind", ["desktop", "standalone", "team"])
def test_real_socket_lan_needs_a_token(vault, kind):
    lan = _lan_ip()
    if lan is None:
        pytest.skip("no LAN IPv4 on this host")
    proc, port = _launch(kind, vault)
    try:
        _remote_contract(f"http://{lan}:{port}/mcp", vault)
        names, _ = _sdk_run(f"http://127.0.0.1:{port}/mcp")  # loopback: no token
        assert "wiki_search" in names
        token = mcp_tokens.add_token(f"lan-{kind}")
        # after the failure, a client that adds the header reconnects fine
        names, _ = _sdk_run(f"http://{lan}:{port}/mcp", token)
        assert "wiki_search" in names
    finally:
        _stop(proc)


@pytest.mark.real_tailnet
@pytest.mark.parametrize("kind", ["desktop", "standalone", "team"])
def test_real_socket_own_tailscale_ip_needs_a_token(vault, kind):
    """Self-request over this host's Tailscale IPv4. NOT a remote tailnet node."""
    access._TS_CACHE.clear()
    ips = sorted(ip for ip in access._tailscale_self_ips() if "." in ip)
    if not ips:
        pytest.skip("Tailscale not running on this host")
    proc, port = _launch(kind, vault)
    try:
        url = f"http://{ips[0]}:{port}/mcp"
        _remote_contract(url, vault)
        token = mcp_tokens.add_token(f"ts-{kind}")
        if kind == "team":  # write mode: no wiki_delete registered
            names, _ = _sdk_run(url, token)
            assert "wiki_delete" not in names and "wiki_update" in names
            return
        names, result = _sdk_run(url, token, ("wiki_delete", {"vault": "alpha", "slug": "content/victim"}))
        assert "wiki_delete" in names
        assert not result.is_error and not _victim(vault).exists()
    finally:
        _stop(proc)


def test_team_launchd_instance_is_an_http_listener_behind_the_gate():
    args = _team_args()
    assert args[1:3] == ["-m", "raven.mcp.cli"]
    assert args[args.index("--transport") + 1] == "http"
    assert args[args.index("--host") + 1] == "0.0.0.0"  # LAN-wide: only the gate protects it

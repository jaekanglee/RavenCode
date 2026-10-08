"""Lifecycle contract for the desktop Python Core (real Raven API + optional MCP)."""
from __future__ import annotations

import json
import os
import select
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]


def _wait_for_ready(process: subprocess.Popen[str], timeout: float = 15.0) -> dict:
    assert process.stdout is not None
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        readable, _, _ = select.select([process.stdout], [], [], 0.1)
        if readable:
            line = process.stdout.readline()
            if line:
                return json.loads(line)
        if process.poll() is not None:
            stderr = process.stderr.read() if process.stderr else ""
            raise AssertionError(f"desktop core exited early: {stderr}")
    raise AssertionError("desktop core did not report readiness")


def test_desktop_core_starts_real_api_and_stops_cleanly() -> None:
    process = subprocess.Popen(
        [sys.executable, "-m", "raven.desktop.runtime"],
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        ready = _wait_for_ready(process)
        assert ready["host"] == "127.0.0.1"
        assert isinstance(ready["port"], int) and ready["port"] > 0

        # The real Raven API should respond on /api/vaults
        url = f"http://{ready['host']}:{ready['port']}/api/vaults"
        with urlopen(url, timeout=5) as response:
            assert response.status == 200
            data = json.load(response)
            assert data["ok"] is True
            assert isinstance(data["vaults"], list)
    finally:
        process.terminate()
        process.wait(timeout=5)

    assert process.returncode is not None


def _free_port() -> int:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_desktop_core_with_mcp_starts_mcp_listener() -> None:
    """--mcp flag starts an MCP HTTP listener alongside the API."""
    mcp_port = _free_port()
    process = subprocess.Popen(
        [sys.executable, "-m", "raven.desktop.runtime", "--mcp", "--mcp-port", str(mcp_port)],
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        ready = _wait_for_ready(process)
        assert ready["host"] == "127.0.0.1"
        assert isinstance(ready["port"], int) and ready["port"] > 0
        assert "mcp_port" in ready
        assert isinstance(ready["mcp_port"], int) and ready["mcp_port"] > 0

        # MCP endpoint should respond to initialize
        mcp_url = f"http://{ready['host']}:{ready['mcp_port']}/mcp"
        payload = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "0.1"},
            },
        }).encode()
        req = Request(
            mcp_url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
        )
        with urlopen(req, timeout=10) as response:
            assert response.status == 200
            body = response.read().decode()
            assert "serverInfo" in body
            assert '"name":"wiki"' in body
    finally:
        process.terminate()
        process.wait(timeout=5)

    assert process.returncode is not None


def _pick_resolvable_vault(base: str) -> str:
    """First registered vault whose path resolves (stale pytest tmp vaults 409)."""
    with urlopen(f"{base}/api/vaults", timeout=5) as response:
        vaults = json.load(response)["vaults"]
    for v in vaults:
        try:
            with urlopen(f"{base}/api/vaults/{v['name']}/search?q=a", timeout=10):
                return v["name"]
        except HTTPError:
            continue
    raise AssertionError("no resolvable vault registered for this test")


# Endpoints whose handlers (or the core modules under them) write warnings to
# stderr — hybrid_search's sqlite-vec notice fires unconditionally, the LLM
# modules only when a key is set and the call fails. All must stay 200 once the
# shell has dropped the pipe.
_STDERR_WRITING_ENDPOINTS = [
    ("GET", "/hybrid-search?query=raven&limit=2", None),
    ("GET", "/rag/query?query=raven", None),
    ("POST", "/suggest-tags", {"content": "raven vault search", "title": "t"}),
    ("GET", "/lint/contradictions", None),
    ("GET", "/ai-advice", None),
]


def test_desktop_core_survives_closed_stderr_pipe() -> None:
    """Endpoints that write warnings to stderr must keep working after the
    shell stops reading the pipe.

    Regression for the desktop search outage: Tauri pipes the core's stderr,
    reads it only on a readiness failure, then drops the handle. Every later
    ``sys.stderr.write`` (e.g. hybrid_search's sqlite-vec warning) raised
    BrokenPipeError inside the request handler → 500 on /hybrid-search and
    /rag/query while the plain /search kept working.
    """
    process = subprocess.Popen(
        [sys.executable, "-m", "raven.desktop.runtime"],
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        ready = _wait_for_ready(process)
        # Mirror the shell: drop both read ends after readiness.
        process.stderr.close()
        process.stdout.close()

        base = f"http://{ready['host']}:{ready['port']}"
        name = _pick_resolvable_vault(base)

        failures = []
        for method, path, body in _STDERR_WRITING_ENDPOINTS:
            url = f"{base}/api/vaults/{name}{path}"
            data = json.dumps(body).encode() if body is not None else None
            req = Request(url, data=data, method=method,
                          headers={"Content-Type": "application/json"})
            try:
                with urlopen(req, timeout=60) as response:
                    assert response.status == 200
                    assert json.load(response) is not None
            except HTTPError as exc:
                failures.append(f"{method} {path} → {exc.code}")
        assert not failures, failures
    finally:
        process.terminate()
        process.wait(timeout=5)


# ─── Issue #14 — unauthenticated Core API exposure (bind host + CORS) ───
#
# The Tauri shell launched this runtime with `--host 0.0.0.0` by default
# (core.rs), and the runtime then set RAVEN_ALLOW_ALL_CORS=1. raven/api has no
# authentication at all, so that pair put every vault read and
# `DELETE /api/vaults/{name}?force=true` (shutil.rmtree) on the LAN behind
# wildcard CORS. The contract pinned here is fail-closed:
#   * default / blank / invalid      → loopback only
#   * wildcard (0.0.0.0, ::)         → loopback unless RAVEN_ALLOW_REMOTE opts in
#   * any non-loopback host          → loopback unless RAVEN_ALLOW_REMOTE opts in
#   * CORS                           → never widened to `*` automatically
#
# Reachability is read from the kernel's listening sockets (lsof), never from
# the readiness JSON — that line hardcodes 127.0.0.1 and is what used to lie.

_LOOPBACK = {"127.0.0.1", "::1"}


def _lan_ip() -> str:
    """A routable non-loopback IPv4 on this machine (used for reachability only)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))  # TEST-NET-1: no packet actually leaves the host
        return s.getsockname()[0]
    finally:
        s.close()


def _listening_hosts(port: int) -> set[str]:
    """Bind addresses the kernel reports as LISTENing on `port`."""
    out = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fn"],
        capture_output=True, text=True, check=False,
    ).stdout
    hosts = set()
    for line in out.splitlines():
        if line.startswith("n"):
            addr = line[1:].rsplit(":", 1)[0]
            if addr.startswith("["):  # IPv6 literal, e.g. [::1]
                addr = addr[1:addr.index("]")]
            hosts.add(addr)
    return hosts


def _is_exposed(hosts: set[str]) -> bool:
    return bool(hosts - _LOOPBACK)


def _spawn_core(
    env_overrides: dict[str, str], host_arg: str | None = None
) -> subprocess.Popen[str]:
    """Start the runtime with host-related env scrubbed, then apply overrides.

    `host_arg` is passed as `--host` — exactly what the Tauri shell does
    (core.rs → runtime_launch_spec → `--host <h>`); the runtime reads
    `RAVEN_HOST` first, then that argument.
    """
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in {
            "RAVEN_HOST",
            "RAVEN_DESKTOP_HOST",
            "RAVEN_ALLOW_ALL_CORS",
            "RAVEN_ALLOW_REMOTE",
        }
    }
    env.update(env_overrides)
    argv = [sys.executable, "-m", "raven.desktop.runtime"]
    if host_arg is not None:
        argv += ["--host", host_arg]
    return subprocess.Popen(
        argv,
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )


def test_host_validator_is_fail_closed() -> None:
    """The bind-host validator: default/blank/invalid/loopback → 127.0.0.1."""
    from raven.desktop.runtime import safe_bind_host

    for bad in (None, "", "   ", "not-a-host", "999.1.1.1", "0.0.0.0/0"):
        assert safe_bind_host(bad) == "127.0.0.1", bad
    for loopback in ("127.0.0.1", "::1", "[::1]", "localhost"):
        assert safe_bind_host(loopback) == "127.0.0.1", loopback


def test_wildcard_is_refused_without_opt_in() -> None:
    """0.0.0.0 / :: are never a default — only an explicit opt-in returns them."""
    from raven.desktop.runtime import safe_bind_host

    assert safe_bind_host("0.0.0.0") == "127.0.0.1"
    assert safe_bind_host("0.0.0.0", allow_remote=True) == "0.0.0.0"
    for ipv6_wildcard in ("::", "0:0:0:0:0:0:0:0"):
        assert safe_bind_host(ipv6_wildcard) == "127.0.0.1", ipv6_wildcard
        # normalised to the canonical spelling, not echoed verbatim
        assert safe_bind_host(ipv6_wildcard, allow_remote=True) == "::"
    # IPv4-mapped IPv6 reaches the whole IPv4 space — still remote
    assert safe_bind_host("::ffff:0.0.0.0") == "127.0.0.1"
    assert safe_bind_host("::ffff:127.0.0.1") == "127.0.0.1"


def test_non_loopback_requires_opt_in() -> None:
    """A named address is still remote access — gated, since the API has no auth."""
    from raven.desktop.runtime import safe_bind_host

    assert safe_bind_host("192.168.0.5") == "127.0.0.1"
    assert safe_bind_host("100.116.203.33") == "127.0.0.1"
    assert safe_bind_host("192.168.0.5", allow_remote=True) == "192.168.0.5"


def test_default_bind_is_loopback_only() -> None:
    """No host configured → the API must not be reachable off-box."""
    process = _spawn_core({})
    try:
        ready = _wait_for_ready(process)
        hosts = _listening_hosts(ready["port"])
        assert hosts, f"nothing listening on {ready['port']}"
        assert not _is_exposed(hosts), f"API reachable beyond loopback: {hosts}"
    finally:
        process.terminate()
        process.wait(timeout=5)


def test_blank_or_invalid_host_falls_back_to_loopback() -> None:
    for bad in ("", "   ", "not-a-host", "999.1.1.1"):
        process = _spawn_core({}, host_arg=bad)
        try:
            ready = _wait_for_ready(process)
            hosts = _listening_hosts(ready["port"])
            assert not _is_exposed(hosts), f"{bad!r} → {hosts}"
        finally:
            process.terminate()
            process.wait(timeout=5)


def test_wildcard_bind_requires_explicit_opt_in() -> None:
    """0.0.0.0 is not a default; it is refused unless opted in explicitly."""
    process = _spawn_core({}, host_arg="0.0.0.0")
    try:
        ready = _wait_for_ready(process)
        hosts = _listening_hosts(ready["port"])
        assert not _is_exposed(hosts), f"0.0.0.0 bound without opt-in: {hosts}"
    finally:
        process.terminate()
        process.wait(timeout=5)


def test_wildcard_bind_is_honoured_with_opt_in() -> None:
    """The gate is real, not a no-op: RAVEN_ALLOW_REMOTE=1 + 0.0.0.0 binds wide."""
    process = _spawn_core({"RAVEN_ALLOW_REMOTE": "1"}, host_arg="0.0.0.0")
    try:
        ready = _wait_for_ready(process)
        hosts = _listening_hosts(ready["port"])
        assert _is_exposed(hosts), f"opt-in ignored, still loopback-only: {hosts}"
    finally:
        process.terminate()
        process.wait(timeout=5)


def test_explicit_non_loopback_host_is_honoured_with_opt_in() -> None:
    """With the opt-in, a named address binds that address — and nothing wider."""
    lan = _lan_ip()
    if lan.startswith("127."):
        pytest.skip("no non-loopback IPv4 on this host")
    process = _spawn_core({"RAVEN_ALLOW_REMOTE": "1"}, host_arg=lan)
    try:
        ready = _wait_for_ready(process)
        hosts = _listening_hosts(ready["port"])
        assert hosts, f"nothing listening on {ready['port']}"
        assert not _is_exposed(hosts - {lan}), f"bound beyond the named host: {hosts}"
    finally:
        process.terminate()
        process.wait(timeout=5)


def test_no_automatic_wildcard_cors() -> None:
    """The runtime must not flip RAVEN_ALLOW_ALL_CORS on its own.

    Regression for the LAN-wide exposure: with the API on 0.0.0.0 the runtime
    set RAVEN_ALLOW_ALL_CORS=1, so any web page open in a LAN browser could call
    the unauthenticated API cross-origin. CORS is not access control and must
    not be widened automatically — not even when remote binding was opted into.
    """
    process = _spawn_core({"RAVEN_ALLOW_REMOTE": "1"}, host_arg="0.0.0.0")
    try:
        ready = _wait_for_ready(process)
        base = f"http://{ready['host']}:{ready['port']}"
        req = Request(f"{base}/api/vaults", headers={"Origin": "https://evil.example.com"})
        with urlopen(req, timeout=5) as response:
            allow = response.headers.get("access-control-allow-origin")
        assert allow != "*", "wildcard CORS enabled automatically"
        assert allow != "https://evil.example.com", "arbitrary origin allowed"
    finally:
        process.terminate()
        process.wait(timeout=5)


def test_desktop_origin_still_allowed_by_cors() -> None:
    """Desktop compatibility: the Tauri webview origin must keep working."""
    process = _spawn_core({})
    try:
        ready = _wait_for_ready(process)
        base = f"http://{ready['host']}:{ready['port']}"
        req = Request(f"{base}/api/vaults", headers={"Origin": "http://tauri.localhost"})
        with urlopen(req, timeout=5) as response:
            allow = response.headers.get("access-control-allow-origin")
        assert allow == "http://tauri.localhost", f"desktop origin rejected: {allow!r}"
    finally:
        process.terminate()
        process.wait(timeout=5)

def test_standalone_cli_bind_default_ignores_cors_switch() -> None:
    """`raven.api.main` must not let a CORS switch decide network exposure.

    Regression: the argparse default was
    `"0.0.0.0" if os.environ.get("RAVEN_ALLOW_ALL_CORS") else "127.0.0.1"`.
    Turning CORS off/on silently changed the bind, so a deployment that set the
    CORS flag for a proxy use-case opened the unauthenticated API on every
    interface. The default is loopback; remote binding needs an explicit host.
    """
    from raven.api.main import main as api_main

    class _Stop(Exception):
        pass

    captured: dict[str, object] = {}

    def fake_run(app: str, host: str, port: int, reload: bool, log_level: str) -> None:
        captured.update(host=host, port=port)
        raise _Stop

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setenv("RAVEN_ALLOW_ALL_CORS", "1")
    monkeypatch.delenv("RAVEN_HOST", raising=False)
    monkeypatch.setattr("raven.api.main.uvicorn.run", fake_run)
    try:
        with pytest.raises(_Stop):
            api_main([])
    finally:
        monkeypatch.undo()

    assert captured["host"] == "127.0.0.1", captured

def test_standalone_cli_honours_explicit_host(monkeypatch) -> None:
    """The explicit escape hatch still works — the gate is not a no-op."""
    from raven.api.main import main as api_main

    captured: dict[str, object] = {}

    def fake_run(app: str, host: str, port: int, reload: bool, log_level: str) -> None:
        captured.update(host=host)

    monkeypatch.setattr("raven.api.main.uvicorn.run", fake_run)
    monkeypatch.delenv("RAVEN_HOST", raising=False)
    assert api_main(["--host", "0.0.0.0"]) == 0
    assert captured["host"] == "0.0.0.0"

    monkeypatch.setenv("RAVEN_HOST", "0.0.0.0")
    assert api_main([]) == 0
    assert captured["host"] == "0.0.0.0"

def test_remote_bind_wraps_real_api_in_lan_token_gate() -> None:
    """Remote mode must not hand an unauthenticated API to the LAN.

    `RAVEN_ALLOW_REMOTE=1` on its own was the whole opt-in, so the destructive
    surface (`DELETE /api/vaults/{name}?force=true` → `shutil.rmtree`) stayed
    open to every host on the network. The runtime now wraps the *real*
    `raven.api.app` object in the same `LanTokenAuth` MCP uses, so a LAN client
    is refused before the request reaches the app.
    """
    import asyncio

    import httpx
    from raven.api import app as api_app
    from raven.desktop.runtime import _is_loopback_host
    from raven.mcp.auth import LanTokenAuth

    assert not _is_loopback_host("0.0.0.0")
    assert not _is_loopback_host("::")
    assert not _is_loopback_host("::ffff:0.0.0.0")
    assert not _is_loopback_host("192.168.1.5")
    for local in ("127.0.0.1", "::1", "localhost"):
        assert _is_loopback_host(local), local

    async def call(client_ip: str) -> httpx.Response:
        transport = httpx.ASGITransport(app=LanTokenAuth(api_app), client=(client_ip, 44444))
        async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
            return await c.get("/api/vaults")

    assert asyncio.run(call("192.168.1.50")).status_code == 401
    assert asyncio.run(call("127.0.0.1")).status_code == 200

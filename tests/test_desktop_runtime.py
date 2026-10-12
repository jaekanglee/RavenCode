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
    (core.rs → runtime_launch_spec → `--host <h>`); `--host` beats an
    inherited `RAVEN_HOST`.
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

    def fake_run(app: str, host: str, port: int, reload: bool, log_level: str, **_kw) -> None:
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

def test_standalone_cli_honours_explicit_host_only_with_opt_in(monkeypatch) -> None:
    """The escape hatch still works — but only with RAVEN_ALLOW_REMOTE (Issue #14).

    This test used to assert that `--host 0.0.0.0` / `RAVEN_HOST=0.0.0.0` bound
    every interface with no opt-in: the standalone half of the PR #21 BLOCKER.
    """
    from raven.api.main import main as api_main

    captured: dict[str, object] = {}

    def fake_run(app: str, host: str, port: int, reload: bool, log_level: str, **_kw) -> None:
        captured.update(host=host)

    monkeypatch.setattr("raven.api.main.uvicorn.run", fake_run)
    monkeypatch.delenv("RAVEN_HOST", raising=False)
    monkeypatch.delenv("RAVEN_ALLOW_REMOTE", raising=False)
    assert api_main(["--host", "0.0.0.0"]) == 2
    assert captured == {}

    monkeypatch.setenv("RAVEN_ALLOW_REMOTE", "1")
    assert api_main(["--host", "0.0.0.0"]) == 0
    assert captured["host"] == "0.0.0.0"

    captured.clear()
    monkeypatch.setenv("RAVEN_HOST", "0.0.0.0")
    assert api_main([]) == 0
    assert captured["host"] == "0.0.0.0"

def test_remote_bind_serves_api_behind_its_own_token_gate() -> None:
    """Remote mode must not hand an unauthenticated API to the LAN.

    The gate now lives in `raven.api.app` itself (raven/core/access.py), so the
    plain app object — what every launcher serves — refuses a LAN client before
    the request reaches a handler. No runtime-side wrapper is involved.
    """
    import asyncio

    import httpx
    from raven.api import app as api_app
    from raven.desktop.runtime import _is_loopback_host

    assert not _is_loopback_host("0.0.0.0")
    assert not _is_loopback_host("::")
    assert not _is_loopback_host("::ffff:0.0.0.0")
    assert not _is_loopback_host("192.168.1.5")
    for local in ("127.0.0.1", "::1", "localhost"):
        assert _is_loopback_host(local), local

    async def call(client_ip: str) -> httpx.Response:
        transport = httpx.ASGITransport(app=api_app, client=(client_ip, 44444))
        async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
            return await c.get("/api/vaults")

    assert asyncio.run(call("192.168.1.50")).status_code == 401
    assert asyncio.run(call("127.0.0.1")).status_code == 200

def test_wildcard_cors_switch_cannot_open_the_api() -> None:
    """Issue #14 acceptance: the default must not answer `Access-Control-Allow-Origin: *`.

    `RAVEN_ALLOW_ALL_CORS=1` was a bare opt-in that turned every browser page on
    the machine into a client of an unauthenticated API (including
    `DELETE /api/vaults/{name}?force=true`). CORS is not access control, so the
    switch must no longer be able to widen the policy to `*`.
    """
    process = _spawn_core({"RAVEN_ALLOW_ALL_CORS": "1"}, host_arg="0.0.0.0")
    try:
        ready = _wait_for_ready(process)
        base = f"http://{ready['host']}:{ready['port']}"
        for origin in ("https://evil.example.com", "http://127.0.0.1:5173"):
            req = Request(f"{base}/api/vaults", headers={"Origin": origin})
            with urlopen(req, timeout=5) as response:
                allow = response.headers.get("access-control-allow-origin")
            assert allow != "*", f"wildcard CORS granted for {origin}"
    finally:
        process.terminate()
        process.wait(timeout=5)

def test_wildcard_cors_env_is_not_honoured_in_isolated_import() -> None:
    """The `*` path must be gone from the module, not merely unreachable here.

    Imported in a clean interpreter so the assertion reflects the shipped
    policy rather than whatever this test session already imported.
    """
    code = (
        "import raven.api.server as s;"
        "print(s._allow_all_cors, s._cors_origins == ['*'])"
    )
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in {"RAVEN_ALLOW_ALL_CORS", "RAVEN_EXTRA_CORS_ORIGIN"}
    }
    env["RAVEN_ALLOW_ALL_CORS"] = "1"
    env["RAVEN_EXTRA_CORS_ORIGIN"] = "*"
    out = subprocess.run(
        [sys.executable, "-c", code],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        env=env,
        check=True,
    ).stdout.strip()
    assert out == "False False", f"wildcard CORS still reachable: {out}"

def test_tailscale_host_without_tailnet_does_not_fall_open(monkeypatch) -> None:
    """`--host tailscale` with no tailnet must not bind every interface.

    The standalone CLI printed "falling back to 0.0.0.0" and did exactly that —
    a fail-open path to the unauthenticated API on a machine where the operator
    asked for the (authenticated) tailnet. The desktop runtime already falls back
    to loopback; the CLI must agree.
    """
    from raven.api.main import main as api_main

    captured: dict[str, object] = {}

    def fake_run(app: str, host: str, port: int, reload: bool, log_level: str, **_kw) -> None:
        captured.update(host=host)

    monkeypatch.setattr("raven.api.main.get_tailscale_ip", lambda: None)
    monkeypatch.setattr("raven.api.main.uvicorn.run", fake_run)
    monkeypatch.delenv("RAVEN_HOST", raising=False)
    assert api_main(["--host", "tailscale"]) == 0
    assert captured["host"] == "127.0.0.1", captured


# ─── Issue #22: the readiness endpoint must be served by this Core ───────────


def _listener(host: str, port: int = 0) -> socket.socket:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, port))
    s.listen(8)
    return s


def _accepts_loopback(sock: socket.socket) -> bool:
    """A loopback connect to ``sock``'s port lands in ``sock``'s own accept queue."""
    port = sock.getsockname()[1]
    with socket.create_connection(("127.0.0.1", port), timeout=1):
        readable, _, _ = select.select([sock], [], [], 1)
        if not readable:
            return False
        conn, _ = sock.accept()
        conn.close()
        return True


def test_api_socket_takes_default_port_when_free(monkeypatch) -> None:
    from raven.desktop import runtime

    port = _free_port()
    monkeypatch.setattr(runtime, "DEFAULT_API_PORT", port)
    sock = runtime._bind_api_socket("127.0.0.1")
    try:
        assert sock.getsockname()[1] == port
        assert _accepts_loopback(sock)
    finally:
        sock.close()


def test_api_socket_skips_port_held_on_loopback_for_wildcard_bind(monkeypatch) -> None:
    """Another server on 127.0.0.1:P — a 0.0.0.0:P bind succeeds on macOS but loses loopback."""
    from raven.desktop import runtime

    other = _listener("127.0.0.1")
    port = other.getsockname()[1]
    monkeypatch.setattr(runtime, "DEFAULT_API_PORT", port)
    try:
        sock = runtime._bind_api_socket("0.0.0.0")
        try:
            assert sock.getsockname()[1] != port
            assert _accepts_loopback(sock)
        finally:
            sock.close()
    finally:
        other.close()


def test_api_socket_skips_port_held_on_wildcard_for_loopback_bind(monkeypatch) -> None:
    """Another server on 0.0.0.0:P — a 127.0.0.1:P bind succeeds on macOS and would shadow it."""
    from raven.desktop import runtime

    other = _listener("0.0.0.0")
    port = other.getsockname()[1]
    monkeypatch.setattr(runtime, "DEFAULT_API_PORT", port)
    try:
        sock = runtime._bind_api_socket("127.0.0.1")
        try:
            assert sock.getsockname()[1] != port
            assert _accepts_loopback(sock)
        finally:
            sock.close()
    finally:
        other.close()


def test_api_socket_reuses_a_just_closed_port(monkeypatch) -> None:
    """A port our previous run left in TIME_WAIT is still the one we take."""
    from raven.desktop import runtime

    previous = _listener("127.0.0.1")
    port = previous.getsockname()[1]
    client = socket.create_connection(("127.0.0.1", port), timeout=1)
    conn, _ = previous.accept()
    conn.close()  # server side closes first → TIME_WAIT on port
    client.close()
    previous.close()
    monkeypatch.setattr(runtime, "DEFAULT_API_PORT", port)
    sock = runtime._bind_api_socket("127.0.0.1")
    try:
        assert sock.getsockname()[1] == port
    finally:
        sock.close()


def test_identity_probe_rejects_an_endpoint_served_by_another_process() -> None:
    """Answering the probe is not enough — this process must be the one that received it."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from raven.desktop.runtime import _ProbeResponder, _endpoint_is_self

    class Other(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — http.server API
            self.send_response(204)
            self.end_headers()

        def log_message(self, *_args):
            pass

    other = HTTPServer(("127.0.0.1", 0), Other)
    threading.Thread(target=other.serve_forever, daemon=True).start()
    try:
        responder = _ProbeResponder(app=None, nonce="n")
        assert _endpoint_is_self(responder, "n", other.server_address[1]) is False
    finally:
        other.shutdown()
        other.server_close()


def test_identity_probe_is_answered_in_process_and_not_forwarded() -> None:
    import asyncio

    from raven.desktop.runtime import _ProbeResponder

    forwarded = []

    async def app(scope, receive, send):
        forwarded.append(scope["path"])

    responder = _ProbeResponder(app, nonce="abc")
    sent = []

    async def send(message):
        sent.append(message)

    async def run(headers):
        await responder({"type": "http", "path": "/", "headers": headers}, None, send)

    asyncio.run(run([(b"x-raven-core-probe", b"wrong")]))
    assert forwarded == ["/"] and not responder.seen.is_set()
    asyncio.run(run([(b"x-raven-core-probe", b"abc")]))
    assert forwarded == ["/"] and responder.seen.is_set()
    assert sent[0]["status"] == 204


def _isolated_env(root: Path, name: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("RAVEN_", "WIKI_", "PORT_"))}
    env.update(HOME=str(root / name / "home"), WIKI_VAULTS_DIR=str(root / name / "reg"))
    Path(env["HOME"]).mkdir(parents=True)
    subprocess.run(
        [sys.executable, "-c", f"from raven.core.vault import Vault; Vault.create('shared', {str(root / name / 'vault')!r})"],
        cwd=REPO_ROOT, env=env, check=True, capture_output=True,
    )
    return env


def test_remote_core_never_hands_the_webview_another_servers_vault(tmp_path: Path) -> None:
    """Issue #22 end to end: another Raven API on 127.0.0.1:P, Desktop Core asked for 0.0.0.0.

    Before the fix the Core also bound *:P, reported 127.0.0.1:P, and a page
    written through that endpoint landed in the other server's vault.
    """
    port = _free_port()
    other_env = _isolated_env(tmp_path, "other")
    other = subprocess.Popen(
        [sys.executable, "-m", "raven.api", "--port", str(port)],
        cwd=REPO_ROOT, env=other_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    core = None
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.3).close()
                break
            except OSError:
                assert time.monotonic() < deadline, "other server did not start"
                time.sleep(0.1)

        core_env = _isolated_env(tmp_path, "desktop")
        core_env.update(RAVEN_ALLOW_REMOTE="1", PORT_API=str(port))
        core = subprocess.Popen(
            [sys.executable, "-m", "raven.desktop.runtime", "--host", "0.0.0.0"],
            cwd=REPO_ROOT, env=core_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        ready = _wait_for_ready(core)
        assert ready["host"] == "127.0.0.1"
        assert ready["port"] != port

        body = json.dumps({"slug": "content/i22", "title": "i22", "content": "x"}).encode()
        req = Request(
            f"http://127.0.0.1:{ready['port']}/api/vaults/shared/pages",
            data=body, headers={"Content-Type": "application/json"}, method="POST",
        )
        with urlopen(req, timeout=10) as response:
            assert response.status == 200
        assert (tmp_path / "desktop" / "vault" / "content" / "i22.md").exists()
        assert not (tmp_path / "other" / "vault" / "content" / "i22.md").exists()
    finally:
        for proc in (core, other):
            if proc is not None:
                proc.terminate()
                proc.wait(timeout=10)


# ─── Issue #23: the Core must not outlive the shell that launched it ─────────


def test_watched_parent_pid_requires_the_actual_parent(monkeypatch) -> None:
    from raven.desktop import runtime

    monkeypatch.setattr(runtime.os, "getppid", lambda: 4242)
    monkeypatch.delenv(runtime.PARENT_PID_ENV, raising=False)
    assert runtime._watched_parent_pid() is None
    monkeypatch.setenv(runtime.PARENT_PID_ENV, "4242")
    assert runtime._watched_parent_pid() == 4242
    # A live process that is not our parent (e.g. inherited) or a malformed value
    # → no watch, never a false shutdown.
    monkeypatch.setenv(runtime.PARENT_PID_ENV, str(os.getpid()))
    assert runtime._watched_parent_pid() is None
    monkeypatch.setenv(runtime.PARENT_PID_ENV, "abc")
    assert runtime._watched_parent_pid() is None
    # The named shell no longer exists → it died before main() ran: still watched.
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    gone.wait()
    monkeypatch.setenv(runtime.PARENT_PID_ENV, str(gone.pid))
    assert runtime._watched_parent_pid() == gone.pid


_SHELL_STANDIN = r"""
import os, subprocess, sys, time
env = dict(os.environ, RAVEN_DESKTOP_PARENT_PID=str(os.getpid()))
core = subprocess.Popen([sys.executable, "-m", "raven.desktop.runtime"], env=env,
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
print(core.pid, core.stdout.readline().strip(), flush=True)
time.sleep(120)
"""

_SHELL_DIES_DURING_STARTUP = r"""
import os, subprocess, sys
env = dict(os.environ, RAVEN_DESKTOP_PARENT_PID=str(os.getpid()))
core = subprocess.Popen([sys.executable, "-m", "raven.desktop.runtime"], env=env,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(core.pid, flush=True)
"""  # exits right away — before the Core has even imported its modules


def test_core_exits_and_frees_its_port_when_the_shell_is_terminated(tmp_path: Path) -> None:
    """A stand-in shell launches the Core like the Tauri shell does, then gets SIGTERM.

    The shell has no SIGTERM handler, so its RunEvent::Exit cleanup never runs —
    before the fix the Core lived on and kept the API port bound.
    """
    import signal

    env = {k: v for k, v in os.environ.items() if not k.startswith(("RAVEN_", "WIKI_", "PORT_"))}
    env.update(HOME=str(tmp_path / "home"), WIKI_VAULTS_DIR=str(tmp_path / "reg"), PORT_API=str(_free_port()))
    (tmp_path / "home").mkdir()
    shell = subprocess.Popen(
        [sys.executable, "-c", _SHELL_STANDIN], cwd=REPO_ROOT, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    core_pid = None
    try:
        first = shell.stdout.readline().split(" ", 1)
        core_pid = int(first[0])
        port = json.loads(first[1])["port"]

        time.sleep(1.0)  # parent alive → the Core keeps serving
        with urlopen(f"http://127.0.0.1:{port}/api/vaults", timeout=5) as response:
            assert response.status == 200

        shell.send_signal(signal.SIGTERM)
        shell.wait(timeout=5)

        deadline = time.monotonic() + 10
        while True:
            try:
                os.kill(core_pid, 0)
            except ProcessLookupError:
                break
            assert time.monotonic() < deadline, "Core outlived its shell"
            time.sleep(0.1)
        with pytest.raises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
        core_pid = None
    finally:
        if shell.poll() is None:
            shell.kill()
            shell.wait(timeout=5)
        if core_pid is not None:
            try:
                os.kill(core_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_shell_passes_the_parent_pid_env_the_runtime_watches() -> None:
    """The Rust shell and the Python Core must agree on the env name (#23)."""
    from raven.desktop.runtime import PARENT_PID_ENV

    core_rs = (REPO_ROOT / "desktop" / "src-tauri" / "src" / "core.rs").read_text(encoding="utf-8")
    assert f'cmd.env("{PARENT_PID_ENV}", std::process::id()' in core_rs


def test_core_exits_when_the_shell_dies_before_readiness(tmp_path: Path) -> None:
    """The shell can die while the Core is still starting (#23 PR #51 review).

    The watch is decided at the top of main(); a shell that is already gone by
    then must still bring the Core down once start-up finishes.
    """
    import signal

    port = _free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("RAVEN_", "WIKI_", "PORT_"))}
    env.update(HOME=str(tmp_path / "home"), WIKI_VAULTS_DIR=str(tmp_path / "reg"), PORT_API=str(port))
    (tmp_path / "home").mkdir()
    shell = subprocess.run(
        [sys.executable, "-c", _SHELL_DIES_DURING_STARTUP], cwd=REPO_ROOT, env=env,
        capture_output=True, text=True, timeout=30, check=True,
    )
    core_pid = int(shell.stdout.strip())
    try:
        deadline = time.monotonic() + 20
        while True:
            try:
                os.kill(core_pid, 0)
            except ProcessLookupError:
                break
            assert time.monotonic() < deadline, "Core outlived a shell that died during start-up"
            time.sleep(0.1)
        with pytest.raises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
        core_pid = None
    finally:
        if core_pid is not None:
            try:
                os.kill(core_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


# ─── Issue #49: nobody may take 127.0.0.1:P after a 0.0.0.0 Core is ready ────

_BIND_ATTEMPT = r"""
import socket, sys
port, reuseport = int(sys.argv[1]), sys.argv[2] == "1"
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
if reuseport:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
try:
    s.bind(("127.0.0.1", port))
    s.listen(1)
    print("BOUND")
except OSError:
    print("REFUSED")
"""


@pytest.mark.parametrize("reuseport", [False, True], ids=["reuseaddr", "reuseaddr+reuseport"])
def test_wildcard_core_keeps_loopback_from_other_processes(monkeypatch, reuseport) -> None:
    """macOS let a later 127.0.0.1:P bind shadow our 0.0.0.0:P; the guard socket stops it.

    Linux refuses that bind on its own (and refuses the guard too, which is fine).
    """
    from raven.desktop import runtime

    monkeypatch.setattr(runtime, "DEFAULT_API_PORT", _free_port())
    wild = runtime._bind_api_socket("0.0.0.0")
    port = wild.getsockname()[1]
    guard = runtime._bind_loopback_guard(port)
    ours = [wild] + ([guard] if guard is not None else [])
    try:
        if sys.platform == "darwin":
            assert guard is not None
        attempt = subprocess.run(
            [sys.executable, "-c", _BIND_ATTEMPT, str(port), "1" if reuseport else "0"],
            capture_output=True, text=True, timeout=10,
        )
        assert attempt.stdout.strip() == "REFUSED"
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            readable, _, _ = select.select(ours, [], [], 1)
            assert readable, "loopback did not reach our sockets"
            readable[0].accept()[0].close()
    finally:
        for s in ours:
            s.close()


@pytest.mark.parametrize(
    "platform, err, falls_back",
    [("linux", "EADDRINUSE", True), ("linux", "EACCES", False), ("darwin", "EADDRINUSE", False)],
)
def test_loopback_guard_falls_back_only_on_linux_eaddrinuse(monkeypatch, platform, err, falls_back) -> None:
    """Only Linux's expected refusal means "wildcard alone is safe"; anything else is raised."""
    import errno

    from raven.desktop import runtime

    made = []

    class FailingSocket:
        def __init__(self, *_a):
            self.closed = False
            made.append(self)

        def setsockopt(self, *_a):
            pass

        def bind(self, _addr):
            raise OSError(getattr(errno, err), "simulated")

        def listen(self, _n):
            pass

        def close(self):
            self.closed = True

    monkeypatch.setattr(runtime.socket, "socket", FailingSocket)
    monkeypatch.setattr(runtime.sys, "platform", platform)
    if falls_back:
        assert runtime._bind_loopback_guard(12345) is None
    else:
        with pytest.raises(OSError):
            runtime._bind_loopback_guard(12345)
    assert made and made[0].closed


_GUARD_FAILS = r"""
import errno, json, os, sys
import raven.desktop.runtime as r
held = []
real_bind = r._bind_api_socket
def bind_api(host):
    s = real_bind(host); held.append(s); return s
def no_guard(port):
    raise OSError(errno.EADDRINUSE, "simulated: someone else holds 127.0.0.1")
r._bind_api_socket, r._bind_loopback_guard = bind_api, no_guard
sys.argv = ["runtime", "--host", "0.0.0.0"]
rc = r.main()
sys.__stdout__.write(json.dumps({"rc": rc, "api_socket_closed": held[0].fileno() == -1}) + "\n")
"""


def test_wildcard_core_fails_closed_when_the_guard_cannot_be_held() -> None:
    """No guard (outside Linux's expected case) → no readiness, exit 1, API socket closed."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("RAVEN_", "PORT_"))}
    env.update(RAVEN_ALLOW_REMOTE="1", PORT_API=str(_free_port()))
    out = subprocess.run(
        [sys.executable, "-c", _GUARD_FAILS], cwd=REPO_ROOT, env=env,
        capture_output=True, text=True, timeout=30,
    )
    lines = [line for line in out.stdout.splitlines() if line.strip()]
    assert len(lines) == 1, f"readiness must not be printed: {out.stdout!r}"
    assert json.loads(lines[0]) == {"rc": 1, "api_socket_closed": True}
    assert "refusing to report ready" in out.stderr


_GUARD_RECORDED = r"""
import sys
import raven.desktop.runtime as r
def recorded(port):
    print("GUARD REQUESTED", flush=True)
    return None
r._bind_loopback_guard = recorded
sys.argv = ["runtime", "--host", "127.0.0.1"]
r.main()
"""


def test_loopback_core_takes_no_guard_socket() -> None:
    """The guard is only for a wildcard bind; the default loopback Core is unchanged."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("RAVEN_", "PORT_"))}
    env["PORT_API"] = str(_free_port())
    proc = subprocess.Popen(
        [sys.executable, "-c", _GUARD_RECORDED], cwd=REPO_ROOT, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    try:
        first = proc.stdout.readline()
        assert "GUARD REQUESTED" not in first
        assert json.loads(first)["host"] == "127.0.0.1"
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def test_remote_core_still_serves_loopback_after_another_server_starts(tmp_path: Path) -> None:
    """Issue #49 end to end: Core on 0.0.0.0 reports ready, then another Raven API tries 127.0.0.1:P."""
    core_env = _isolated_env(tmp_path, "desktop")
    core_env.update(RAVEN_ALLOW_REMOTE="1", PORT_API=str(_free_port()))
    core = subprocess.Popen(
        [sys.executable, "-m", "raven.desktop.runtime", "--host", "0.0.0.0"],
        cwd=REPO_ROOT, env=core_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    other = None
    try:
        port = _wait_for_ready(core)["port"]
        other = subprocess.Popen(
            [sys.executable, "-m", "raven.api", "--port", str(port)],
            cwd=REPO_ROOT, env=_isolated_env(tmp_path, "other"),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            other.wait(timeout=15)  # cannot bind → exits
        except subprocess.TimeoutExpired:
            pass

        body = json.dumps({"slug": "content/i49", "title": "i49", "content": "x"}).encode()
        req = Request(
            f"http://127.0.0.1:{port}/api/vaults/shared/pages",
            data=body, headers={"Content-Type": "application/json"}, method="POST",
        )
        with urlopen(req, timeout=10) as response:
            assert response.status == 200
        assert (tmp_path / "desktop" / "vault" / "content" / "i49.md").exists()
        assert not (tmp_path / "other" / "vault" / "content" / "i49.md").exists()
    finally:
        for proc in (other, core):
            if proc is not None and proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=10)


# ─── Issue #50: the advertised MCP endpoint must be served by this Core ──────


def _local_non_loopback_ip() -> str | None:
    """A non-loopback address of this host (stands in for the Tailscale IP)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # TEST-NET-1; UDP connect sends nothing
            ip = s.getsockname()[0]
    except OSError:
        return None
    return None if ip in ("0.0.0.0", "127.0.0.1") else ip


def _mcp_conflicts():
    cases = [("127.0.0.1", "0.0.0.0", "loopback-taken/wildcard-mcp"), ("0.0.0.0", "127.0.0.1", "wildcard-taken/loopback-mcp")]
    ip = _local_non_loopback_ip()
    if ip:
        cases.append((ip, "0.0.0.0", "advertised-ip-taken/wildcard-mcp"))
    return cases


@pytest.mark.parametrize("other_host, mcp_host, _id", _mcp_conflicts(), ids=[c[2] for c in _mcp_conflicts()])
def test_mcp_yields_when_another_server_owns_an_overlapping_address(other_host, mcp_host, _id) -> None:
    """The old trial bind said "free" for all three on macOS (#50)."""
    from raven.desktop import runtime

    other = _listener(other_host)
    port = other.getsockname()[1]
    advertised = other_host if mcp_host == "0.0.0.0" and other_host != "127.0.0.1" else "127.0.0.1"
    try:
        assert runtime._bind_mcp_socket(mcp_host, port, advertised) is None
    finally:
        other.close()


@pytest.mark.parametrize("mcp_host", ["127.0.0.1", "0.0.0.0"])
def test_mcp_keeps_its_port_when_nothing_else_answers(mcp_host) -> None:
    from raven.desktop import runtime

    port = _free_port()
    sock = runtime._bind_mcp_socket(mcp_host, port, "127.0.0.1")
    try:
        assert sock is not None and sock.getsockname()[1] == port
        assert _accepts_loopback(sock)
    finally:
        if sock is not None:
            sock.close()


def test_runtime_runs_api_only_when_the_mcp_port_is_answered_by_another_server(tmp_path: Path) -> None:
    """Conflict → API only: readiness carries no mcp_port (existing yield policy)."""
    other = _listener("127.0.0.1")
    mcp_port = other.getsockname()[1]
    env = _isolated_env(tmp_path, "desktop")
    env.update(RAVEN_ALLOW_REMOTE="1", PORT_API=str(_free_port()))
    core = subprocess.Popen(
        [sys.executable, "-m", "raven.desktop.runtime", "--host", "0.0.0.0", "--mcp", "--mcp-port", str(mcp_port)],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        ready = _wait_for_ready(core)
        assert "mcp_port" not in ready
        with urlopen(f"http://127.0.0.1:{ready['port']}/api/vaults", timeout=5) as response:
            assert response.status == 200
    finally:
        core.terminate()
        core.wait(timeout=10)
        other.close()


_MCP_SERVED_ELSEWHERE = r"""
import sys
import raven.desktop.runtime as r
# Simulate losing the race after the ownership check: serve MCP on some other
# port while the advertised one is held by another process.
r._bind_mcp_socket = lambda host, port, adv: r._claim_port(host, 0, {"127.0.0.1"})
sys.argv = ["runtime", "--host", "127.0.0.1", "--mcp", "--mcp-port", sys.argv[1]]
r.main()
"""


def test_runtime_does_not_advertise_an_mcp_endpoint_it_does_not_answer(tmp_path: Path) -> None:
    other = _listener("127.0.0.1")
    mcp_port = other.getsockname()[1]
    env = _isolated_env(tmp_path, "desktop")
    env["PORT_API"] = str(_free_port())
    core = subprocess.Popen(
        [sys.executable, "-c", _MCP_SERVED_ELSEWHERE, str(mcp_port)],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        ready = _wait_for_ready(core)
        assert "mcp_port" not in ready
    finally:
        core.terminate()
        core.wait(timeout=10)
        other.close()
    assert "answered by another process" in core.stderr.read()


class _FakeServer:
    def __init__(self, started: bool) -> None:
        self.started = started
        self.should_exit = False


def test_stop_mcp_releases_the_socket_of_a_server_that_never_started() -> None:
    """uvicorn closes a passed socket only after a started server shuts down."""
    import threading
    from raven.desktop import runtime

    sock = _listener("127.0.0.1")
    port = sock.getsockname()[1]
    thread = threading.Thread(target=lambda: None)
    thread.start()
    assert runtime._stop_mcp(_FakeServer(started=False), thread, [sock], port) is True
    assert sock.fileno() == -1
    with pytest.raises(ConnectionRefusedError):
        socket.create_connection(("127.0.0.1", port), timeout=1).close()


def test_stop_mcp_closes_a_stuck_startup_and_reports_it(capsys) -> None:
    import threading
    from raven.desktop import runtime

    sock = _listener("127.0.0.1")
    release = threading.Event()
    thread = threading.Thread(target=release.wait, daemon=True)
    thread.start()
    server = _FakeServer(started=False)
    try:
        assert runtime._stop_mcp(server, thread, [sock], 1234) is False
        assert server.should_exit and sock.fileno() == -1
        assert "did not stop within 2s (socket released)" in capsys.readouterr().err
    finally:
        release.set()


def test_stop_mcp_reports_a_started_listener_that_does_not_stop(capsys) -> None:
    """Never a silent "yielded": a live thread is reported as an error."""
    import threading
    from raven.desktop import runtime

    sock = _listener("127.0.0.1")
    release = threading.Event()
    thread = threading.Thread(target=release.wait, daemon=True)
    thread.start()
    try:
        assert runtime._stop_mcp(_FakeServer(started=True), thread, [sock], 1234) is False
        assert "MCP was not cleanly yielded" in capsys.readouterr().err
    finally:
        release.set()
        sock.close()


_MCP_STARTUP_FAILS = r"""
import sys
import raven.desktop.runtime as r
async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        await receive()
        await send({"type": "lifespan.startup.failed", "message": "boom"})
r._build_mcp_app = lambda mode, host: app
sys.argv = ["runtime", "--host", "0.0.0.0", "--mcp", "--mcp-port", sys.argv[1]]
raise SystemExit(r.main())
"""


def test_runtime_releases_the_mcp_port_when_mcp_startup_fails(tmp_path: Path) -> None:
    """Before: API-only readiness while *:P still listened with nobody accepting."""
    mcp_port = _free_port()
    env = _isolated_env(tmp_path, "desktop")
    env.update(RAVEN_ALLOW_REMOTE="1", PORT_API=str(_free_port()))
    core = subprocess.Popen(
        [sys.executable, "-c", _MCP_STARTUP_FAILS, str(mcp_port)],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        ready = _wait_for_ready(core)
        assert "mcp_port" not in ready
        with pytest.raises(ConnectionRefusedError):
            socket.create_connection(("127.0.0.1", mcp_port), timeout=1).close()
    finally:
        core.terminate()
        core.wait(timeout=10)


_MCP_LOSES_LOOPBACK_AFTER_CLAIM = r"""
import os, sys, time
from pathlib import Path
import raven.desktop.runtime as r
signal_dir = Path(sys.argv[2])
claim = r._bind_mcp_socket
def claim_then_wait(host, port, adv):
    sock = claim(host, port, adv)
    (signal_dir / "claimed").touch()
    while not (signal_dir / "go").exists():
        time.sleep(0.02)
    return sock
r._bind_mcp_socket = claim_then_wait
sys.argv = ["runtime", "--host", "0.0.0.0", "--mcp", "--mcp-port", sys.argv[1]]
raise SystemExit(r.main())
"""


def test_runtime_releases_the_mcp_port_after_losing_the_identity_check(tmp_path: Path) -> None:
    """Another process takes 127.0.0.1:P between our claim and readiness (macOS allows it).

    The Core must go API only, stop its MCP listener, and leave the other server alone.
    """
    ip = _local_non_loopback_ip()
    if ip is None:
        pytest.skip("needs a non-loopback address to see our wildcard listener")
    mcp_port = _free_port()
    env = _isolated_env(tmp_path, "desktop")
    env.update(RAVEN_ALLOW_REMOTE="1", PORT_API=str(_free_port()))
    signal_dir = tmp_path / "signal"
    signal_dir.mkdir()
    core = subprocess.Popen(
        [sys.executable, "-c", _MCP_LOSES_LOOPBACK_AFTER_CLAIM, str(mcp_port), str(signal_dir)],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    other = None
    try:
        deadline = time.monotonic() + 15
        while not (signal_dir / "claimed").exists():
            assert time.monotonic() < deadline and core.poll() is None
            time.sleep(0.02)
        try:
            other = _listener("127.0.0.1", mcp_port)
        except OSError:
            pytest.skip("this kernel refuses 127.0.0.1:P next to a listening 0.0.0.0:P")
        finally:
            (signal_dir / "go").touch()
        ready = _wait_for_ready(core)
        assert "mcp_port" not in ready
        with pytest.raises(ConnectionRefusedError):
            socket.create_connection((ip, mcp_port), timeout=1).close()
        assert _accepts_loopback(other)
    finally:
        core.terminate()
        core.wait(timeout=10)
        if other is not None:
            other.close()


# Issue #54: the MCP side of #49 — hold loopback and the advertised address.

_MCP_ADVERTISES = r"""
import sys
import raven.desktop.runtime as r
ip = sys.argv[2]
r._advertised_mcp_host = lambda host: ip
sys.argv = ["runtime", "--host", "0.0.0.0", "--mcp", "--mcp-port", sys.argv[1]]
raise SystemExit(r.main())
"""


def _mcp_status(host: str, port: int) -> int:
    try:
        with urlopen(Request(f"http://{host}:{port}/mcp"), timeout=5) as response:
            return response.status
    except HTTPError as exc:
        return exc.code


@pytest.mark.parametrize("opts", [("SO_REUSEADDR",), ("SO_REUSEPORT",), ("SO_REUSEADDR", "SO_REUSEPORT")])
def test_no_process_can_take_an_mcp_address_after_readiness(tmp_path: Path, opts) -> None:
    """Before: macOS let a later bind of 127.0.0.1:P or the advertised IP:P win every agent request."""
    ip = _local_non_loopback_ip()
    if ip is None:
        pytest.skip("needs a non-loopback address to stand in for the Tailscale IP")
    mcp_port = _free_port()
    env = _isolated_env(tmp_path, "desktop")
    env.update(RAVEN_ALLOW_REMOTE="1", PORT_API=str(_free_port()))
    core = subprocess.Popen(
        [sys.executable, "-c", _MCP_ADVERTISES, str(mcp_port), ip],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        ready = _wait_for_ready(core)
        assert (ready["mcp_port"], ready["mcp_host"]) == (mcp_port, ip)
        for host in ("127.0.0.1", ip):
            intruder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                for opt in opts:
                    intruder.setsockopt(socket.SOL_SOCKET, getattr(socket, opt), 1)
                with pytest.raises(OSError):
                    intruder.bind((host, mcp_port))
            finally:
                intruder.close()
        # Still our gated MCP: loopback passes the gate, the advertised IP needs a token.
        assert _mcp_status("127.0.0.1", mcp_port) != 401
        assert _mcp_status(ip, mcp_port) == 401
    finally:
        core.terminate()
        core.wait(timeout=10)


@pytest.mark.skipif(not sys.platform == "darwin", reason="macOS lets a specific bind overlap a listening wildcard")
def test_mcp_guards_release_what_they_took_when_one_address_is_held(capsys) -> None:
    from raven.desktop import runtime

    ip = _local_non_loopback_ip()
    if ip is None:
        pytest.skip("needs a non-loopback address")
    wildcard = _listener("0.0.0.0")
    port = wildcard.getsockname()[1]
    other = _listener(ip, port)
    try:
        with pytest.raises(OSError):
            runtime._bind_mcp_guards(port, ip)
        # The loopback guard taken first was closed, so the address is free again.
        _listener("127.0.0.1", port).close()
    finally:
        other.close()
        wildcard.close()


def test_mcp_guards_hold_loopback_and_the_advertised_address() -> None:
    from raven.desktop import runtime

    ip = _local_non_loopback_ip()
    if ip is None:
        pytest.skip("needs a non-loopback address")
    wildcard = _listener("0.0.0.0")
    port = wildcard.getsockname()[1]
    guards = runtime._bind_mcp_guards(port, ip)
    try:
        if sys.platform.startswith("linux"):
            assert guards == []  # Linux refuses the overlap outright; the wildcard alone is safe
        else:
            assert sorted(g.getsockname() for g in guards) == sorted([("127.0.0.1", port), (ip, port)])
    finally:
        for guard in guards:
            guard.close()
        wildcard.close()


_MCP_ADDRESS_TAKEN_AFTER_CLAIM = r"""
import sys, time
from pathlib import Path
import raven.desktop.runtime as r
signal_dir, ip = Path(sys.argv[2]), sys.argv[3]
r._advertised_mcp_host = lambda host: ip
claim = r._bind_mcp_socket
def claim_then_wait(host, port, adv):
    sock = claim(host, port, adv)
    (signal_dir / "claimed").touch()
    while not (signal_dir / "go").exists():
        time.sleep(0.02)
    return sock
r._bind_mcp_socket = claim_then_wait
sys.argv = ["runtime", "--host", "0.0.0.0", "--mcp", "--mcp-port", sys.argv[1]]
raise SystemExit(r.main())
"""


@pytest.mark.parametrize("taken", ["loopback", "advertised"])
def test_runtime_goes_api_only_when_an_mcp_guard_cannot_be_held(tmp_path: Path, taken) -> None:
    """Another process takes 127.0.0.1:P or IP:P between our claim and the guards."""
    ip = _local_non_loopback_ip()
    if ip is None:
        pytest.skip("needs a non-loopback address to stand in for the Tailscale IP")
    mcp_port = _free_port()
    env = _isolated_env(tmp_path, "desktop")
    env.update(RAVEN_ALLOW_REMOTE="1", PORT_API=str(_free_port()))
    signal_dir = tmp_path / "signal"
    signal_dir.mkdir()
    core = subprocess.Popen(
        [sys.executable, "-c", _MCP_ADDRESS_TAKEN_AFTER_CLAIM, str(mcp_port), str(signal_dir), ip],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    other = None
    try:
        deadline = time.monotonic() + 15
        while not (signal_dir / "claimed").exists():
            assert time.monotonic() < deadline and core.poll() is None
            time.sleep(0.02)
        try:
            other = _listener("127.0.0.1" if taken == "loopback" else ip, mcp_port)
        except OSError:
            pytest.skip("this kernel refuses a specific bind next to a listening 0.0.0.0:P")
        finally:
            (signal_dir / "go").touch()
        ready = _wait_for_ready(core)
        assert "mcp_port" not in ready
        # None of our MCP sockets is left: the address nobody else holds refuses.
        free_host = ip if taken == "loopback" else "127.0.0.1"
        with pytest.raises(ConnectionRefusedError):
            socket.create_connection((free_host, mcp_port), timeout=1).close()
        with socket.create_connection((other.getsockname()[0], mcp_port), timeout=1):
            readable, _, _ = select.select([other], [], [], 1)
            assert readable  # the other server is untouched
            other.accept()[0].close()
    finally:
        core.terminate()
        core.wait(timeout=10)
        if other is not None:
            other.close()
    assert "could not hold every MCP address" in core.stderr.read()


@pytest.mark.parametrize("ts_ip, expected", [(None, "127.0.0.1"), ("100.101.102.103", "100.101.102.103")])
def test_mcp_advertises_the_tailnet_address_only_when_one_is_up(monkeypatch, ts_ip, expected) -> None:
    from raven.desktop import netwatch, runtime

    # Issue #58: the Desktop Core uses the watcher's lookup, not raven.api.main's.
    found = netwatch.Lookup("ip", ts_ip) if ts_ip else netwatch.Lookup("none")
    monkeypatch.setattr("raven.desktop.netwatch.lookup_tailscale", lambda: found)
    assert runtime._advertised_mcp_host("0.0.0.0") == expected
    assert runtime._advertised_mcp_host("127.0.0.1") == "127.0.0.1"


def test_mcp_guards_hold_loopback_once_without_a_tailnet() -> None:
    """No tailnet → advertised is loopback → exactly one guard (none on Linux)."""
    from raven.desktop import runtime

    wildcard = _listener("0.0.0.0")
    port = wildcard.getsockname()[1]
    guards = runtime._bind_mcp_guards(port, "127.0.0.1")
    try:
        expected = [] if sys.platform.startswith("linux") else [("127.0.0.1", port)]
        assert [g.getsockname() for g in guards] == expected
    finally:
        for guard in guards:
            guard.close()
        wildcard.close()


def test_mcp_guards_close_what_they_took_on_any_error(monkeypatch) -> None:
    """A guard taken before a later one fails must not stay bound (any errno)."""
    import errno as errno_mod
    from raven.desktop import runtime

    taken: list[socket.socket] = []

    def guard(host, port):
        if host != "127.0.0.1":
            raise OSError(errno_mod.EADDRNOTAVAIL, "simulated: address not on this host")
        sock = _listener(host)
        taken.append(sock)
        return sock

    monkeypatch.setattr(runtime, "_bind_guard", guard)
    with pytest.raises(OSError):
        runtime._bind_mcp_guards(1, "100.101.102.103")
    assert taken and all(s.fileno() == -1 for s in taken)


def test_mcp_guards_accept_the_linux_fallback(monkeypatch) -> None:
    """Linux EADDRINUSE → _bind_guard returns None → wildcard alone, no error."""
    from raven.desktop import runtime

    monkeypatch.setattr(runtime, "_bind_guard", lambda host, port: None)
    assert runtime._bind_mcp_guards(1, "100.101.102.103") == []


def test_stop_mcp_releases_every_socket_of_a_stuck_startup() -> None:
    import threading
    from raven.desktop import runtime

    socks = [_listener("127.0.0.1"), _listener("127.0.0.1")]
    release = threading.Event()
    thread = threading.Thread(target=release.wait, daemon=True)
    thread.start()
    try:
        assert runtime._stop_mcp(_FakeServer(started=False), thread, socks, 1) is False
        assert all(s.fileno() == -1 for s in socks)
    finally:
        release.set()


_MCP_RECORDS_GUARDS = r"""
import sys
import raven.desktop.runtime as r
real = r._bind_mcp_guards
def recorded(port, advertised):
    print(f"MCP-GUARDS {advertised}", file=sys.stderr, flush=True)
    return real(port, advertised)
r._bind_mcp_guards = recorded
argv = sys.argv[1:]
sys.argv = ["runtime", *argv]
raise SystemExit(r.main())
"""


def _run_core(tmp_path: Path, script: str, *args: str) -> subprocess.Popen[str]:
    env = _isolated_env(tmp_path, "desktop")
    env.update(RAVEN_ALLOW_REMOTE="1", PORT_API=str(_free_port()))
    return subprocess.Popen(
        [sys.executable, "-c", script, *args],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )


@pytest.mark.parametrize("mode", ["loopback", "specific"])
def test_specific_mcp_binds_keep_their_endpoint_and_take_no_guards(tmp_path: Path, mode) -> None:
    """Loopback / specific-address MCP already holds the exact address it advertises."""
    if mode == "loopback":
        host, args = "127.0.0.1", ["--host", "127.0.0.1"]
    else:
        host = _local_non_loopback_ip()
        if host is None:
            pytest.skip("needs a non-loopback address")
        args = ["--host", "0.0.0.0", "--mcp-host", host]
    mcp_port = _free_port()
    core = _run_core(tmp_path, _MCP_RECORDS_GUARDS, *args, "--mcp", "--mcp-port", str(mcp_port))
    try:
        ready = _wait_for_ready(core)
        assert (ready["mcp_port"], ready["mcp_host"]) == (mcp_port, host)
        intruder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            intruder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            intruder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            with pytest.raises(OSError):
                intruder.bind((host, mcp_port))
        finally:
            intruder.close()
    finally:
        core.terminate()
        core.wait(timeout=10)
    assert "MCP-GUARDS" not in core.stderr.read()


_MCP_GUARD_ERRNO = r"""
import errno, sys
import raven.desktop.runtime as r
ip = sys.argv[2]
r._advertised_mcp_host = lambda host: ip
real = r._bind_guard
def guard(host, port):
    if host == ip:
        raise OSError(errno.EACCES, "simulated: not allowed")
    return real(host, port)
r._bind_guard = guard
sys.argv = ["runtime", "--host", "0.0.0.0", "--mcp", "--mcp-port", sys.argv[1]]
raise SystemExit(r.main())
"""


def test_runtime_goes_api_only_and_releases_everything_on_another_guard_errno(tmp_path: Path) -> None:
    """Not Linux EADDRINUSE → no fallback: MCP yields, wildcard and loopback guard are released."""
    ip = _local_non_loopback_ip()
    if ip is None:
        pytest.skip("needs a non-loopback address")
    mcp_port = _free_port()
    core = _run_core(tmp_path, _MCP_GUARD_ERRNO, str(mcp_port), ip)
    try:
        ready = _wait_for_ready(core)
        assert set(ready) == {"host", "port", "bind_host"}
        for host in ("127.0.0.1", ip):
            with pytest.raises(ConnectionRefusedError):
                socket.create_connection((host, mcp_port), timeout=1).close()
    finally:
        core.terminate()
        core.wait(timeout=10)
    assert "could not hold every MCP address" in core.stderr.read()


def test_runtime_goes_api_only_when_the_advertised_address_is_not_local(tmp_path: Path) -> None:
    """A stale/invalid advertised address (TEST-NET-1 here) never yields an advertised MCP."""
    mcp_port = _free_port()
    core = _run_core(tmp_path, _MCP_ADVERTISES, str(mcp_port), "192.0.2.1")
    try:
        ready = _wait_for_ready(core)
        assert set(ready) == {"host", "port", "bind_host"}
        with pytest.raises(ConnectionRefusedError):
            socket.create_connection(("127.0.0.1", mcp_port), timeout=1).close()
    finally:
        core.terminate()
        core.wait(timeout=10)


_MCP_STARTUP_FAILS_ADVERTISED = r"""
import sys
import raven.desktop.runtime as r
ip = sys.argv[2]
r._advertised_mcp_host = lambda host: ip
async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        await receive()
        await send({"type": "lifespan.startup.failed", "message": "boom"})
r._build_mcp_app = lambda mode, host: app
sys.argv = ["runtime", "--host", "0.0.0.0", "--mcp", "--mcp-port", sys.argv[1]]
raise SystemExit(r.main())
"""


def test_runtime_releases_every_mcp_socket_when_mcp_startup_fails(tmp_path: Path) -> None:
    ip = _local_non_loopback_ip()
    if ip is None:
        pytest.skip("needs a non-loopback address")
    mcp_port = _free_port()
    core = _run_core(tmp_path, _MCP_STARTUP_FAILS_ADVERTISED, str(mcp_port), ip)
    try:
        ready = _wait_for_ready(core)
        assert set(ready) == {"host", "port", "bind_host"}
        for host in ("127.0.0.1", ip):
            with pytest.raises(ConnectionRefusedError):
                socket.create_connection((host, mcp_port), timeout=1).close()
    finally:
        core.terminate()
        core.wait(timeout=10)


def test_sigterm_releases_every_mcp_socket(tmp_path: Path) -> None:
    ip = _local_non_loopback_ip()
    if ip is None:
        pytest.skip("needs a non-loopback address")
    mcp_port = _free_port()
    core = _run_core(tmp_path, _MCP_ADVERTISES, str(mcp_port), ip)
    try:
        ready = _wait_for_ready(core)
        assert set(ready) == {"host", "port", "bind_host", "mcp_port", "mcp_host"}
        core.terminate()
        assert core.wait(timeout=15) == 0
        for host in ("127.0.0.1", ip):
            with pytest.raises(ConnectionRefusedError):
                socket.create_connection((host, mcp_port), timeout=1).close()
    finally:
        if core.poll() is None:
            core.kill()
            core.wait(timeout=10)


# Issue #16: readiness reports the real bind, and `host` is always dialable.

def _start_core(tmp_path: Path, *argv: str, remote: bool = True, extra_env: dict | None = None):
    env = _isolated_env(tmp_path, "desktop")
    env["PORT_API"] = str(_free_port())
    if remote:
        env["RAVEN_ALLOW_REMOTE"] = "1"
    env.update(extra_env or {})
    return subprocess.Popen(
        [sys.executable, "-m", "raven.desktop.runtime", *argv],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )


def _status(url: str, token: str | None = None) -> int:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        with urlopen(Request(url, headers=headers), timeout=5) as response:
            return response.status
    except HTTPError as exc:
        return exc.code


@pytest.mark.parametrize("argv, remote", [((), False), (("--host", "127.0.0.1"), True), (("--host", "localhost"), True)])
def test_loopback_readiness_reports_a_loopback_bind(tmp_path, argv, remote) -> None:
    core = _start_core(tmp_path, *argv, remote=remote)
    try:
        ready = _wait_for_ready(core)
        assert (ready["host"], ready["bind_host"]) == ("127.0.0.1", "127.0.0.1")
        assert _status(f"http://127.0.0.1:{ready['port']}/api/vaults") == 200
    finally:
        core.terminate()
        core.wait(timeout=10)


def test_wildcard_readiness_reports_the_wildcard_bind_and_a_loopback_endpoint(tmp_path) -> None:
    """Before #16 readiness said 127.0.0.1 and hid that the API listened on every interface."""
    core = _start_core(tmp_path, "--host", "0.0.0.0")
    try:
        ready = _wait_for_ready(core)
        assert (ready["host"], ready["bind_host"]) == ("127.0.0.1", "0.0.0.0")
        base = f"http://127.0.0.1:{ready['port']}"
        assert _status(f"{base}/api/vaults") == 200
        with urlopen(f"{base}/api/system/info", timeout=5) as response:
            assert json.load(response)["bind_host"] == "0.0.0.0"  # what the admin screen shows
    finally:
        core.terminate()
        core.wait(timeout=10)


def test_specific_address_readiness_points_at_that_address(tmp_path) -> None:
    """Before #16 readiness said 127.0.0.1 although nothing listened there."""
    ip = _local_non_loopback_ip()
    if ip is None:
        pytest.skip("needs a non-loopback address")
    env = _isolated_env(tmp_path, "tok")
    token = subprocess.run(
        [sys.executable, "-c", "from raven.core import mcp_tokens; print(mcp_tokens.add_token('t'))"],
        cwd=REPO_ROOT, env=env, check=True, capture_output=True, text=True,
    ).stdout.strip()
    core = _start_core(tmp_path, "--host", ip, extra_env={"WIKI_VAULTS_DIR": env["WIKI_VAULTS_DIR"]})
    try:
        ready = _wait_for_ready(core)
        assert (ready["host"], ready["bind_host"]) == (ip, ip)
        base = f"http://{ip}:{ready['port']}"
        assert _status(f"{base}/api/vaults") == 401  # not a loopback client — token required
        assert _status(f"{base}/api/vaults", token) == 200
        with pytest.raises(OSError):
            socket.create_connection(("127.0.0.1", ready["port"]), timeout=1).close()
    finally:
        core.terminate()
        core.wait(timeout=10)


_RECORD_IDENTITY_PROBE = r"""
import sys
import raven.desktop.runtime as r
real = r._endpoint_is_self
def probe(responder, nonce, port, host=r.LOOPBACK_HOST):
    print(f"PROBE {host}", file=sys.stderr, flush=True)
    return real(responder, nonce, port, host)
r._endpoint_is_self = probe
sys.argv = ["runtime", "--host", sys.argv[1]]
raise SystemExit(r.main())
"""


def test_identity_check_covers_a_specific_address_bind(tmp_path) -> None:
    """#22's "is the endpoint really ours" check used to be skipped for a specific bind."""
    ip = _local_non_loopback_ip()
    if ip is None:
        pytest.skip("needs a non-loopback address")
    env = _isolated_env(tmp_path, "desktop")
    env.update(PORT_API=str(_free_port()), RAVEN_ALLOW_REMOTE="1")
    core = subprocess.Popen(
        [sys.executable, "-c", _RECORD_IDENTITY_PROBE, ip],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        assert _wait_for_ready(core)["host"] == ip
    finally:
        core.terminate()
        core.wait(timeout=10)
    assert f"PROBE {ip}" in core.stderr.read()


@pytest.mark.parametrize(
    "host, message",
    [
        ("::", "IPv6 bind (::) is not supported"),
        ("999.1.1.1", "cannot resolve bind host '999.1.1.1'"),
        ("192.0.2.1", "cannot serve the API on 192.0.2.1"),  # a valid IP that is not on this host
    ],
)
def test_unusable_bind_host_fails_without_readiness(tmp_path, host, message) -> None:
    core = _start_core(tmp_path, "--host", host)
    out, err = core.communicate(timeout=30)
    assert core.returncode == 1
    assert out == ""
    assert message in err


def test_readiness_never_reports_a_wildcard_as_the_endpoint(tmp_path) -> None:
    core = _start_core(tmp_path, "--host", "0.0.0.0", "--mcp", "--mcp-port", str(_free_port()))
    try:
        ready = _wait_for_ready(core)
        assert ready["host"] != "0.0.0.0" and ready.get("mcp_host") != "0.0.0.0"
        assert set(ready) <= {"host", "port", "bind_host", "mcp_port", "mcp_host"}
    finally:
        core.terminate()
        core.wait(timeout=10)


_NAMED_HOST = r"""
import socket, sys
import raven.desktop.runtime as r
ip, real = sys.argv[1], socket.gethostbyname
socket.gethostbyname = lambda name: ip if name == "core.test" else real(name)
sys.argv = ["runtime", "--host", sys.argv[2]]
raise SystemExit(r.main())
"""


def test_named_bind_host_is_bound_and_reported_by_its_address(tmp_path) -> None:
    """The shell parses bind_host as an IP; a name used to be reported verbatim (or as loopback)."""
    ip = _local_non_loopback_ip()
    if ip is None:
        pytest.skip("needs a non-loopback address")
    env = _isolated_env(tmp_path, "desktop")
    env.update(PORT_API=str(_free_port()), RAVEN_ALLOW_REMOTE="1")
    core = subprocess.Popen(
        [sys.executable, "-c", _NAMED_HOST, ip, "core.test"],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        ready = _wait_for_ready(core)
        assert (ready["host"], ready["bind_host"]) == (ip, ip)
    finally:
        core.terminate()
        core.wait(timeout=10)


def test_unresolvable_bind_host_fails_without_readiness(tmp_path) -> None:
    core = _start_core(tmp_path, "--host", "no-such-host.invalid")
    out, err = core.communicate(timeout=30)
    assert core.returncode == 1 and out == ""
    assert "cannot resolve bind host 'no-such-host.invalid'" in err

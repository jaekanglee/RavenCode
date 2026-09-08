"""Lifecycle contract for the desktop Python Core (real Raven API + optional MCP)."""
from __future__ import annotations

import json
import select
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


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

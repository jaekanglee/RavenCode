"""Desktop Python Core — starts the real Raven API on a random loopback port.

Readiness protocol:
  stdout line 1 → {"host": "127.0.0.1", "port": <int>}
  With --mcp:    → {..., "mcp_port": <int>, "mcp_host": "<dialable address>"}

  ``mcp_host`` is not normalised to loopback like ``host`` — the shell shows it
  so the operator can see where external agents should point. A 0.0.0.0 bind is
  reported as the Tailscale IP (else loopback), since 0.0.0.0 is not dialable.

The Tauri shell reads this line, then exposes the endpoint(s) to the webview
via the ``core_endpoint`` / ``mcp_endpoint`` commands.

External access (Tailscale) — opt-in (Issue #14):
  ``--host 0.0.0.0`` binds all interfaces (same pattern as ``python -m raven.api``),
  but only when ``RAVEN_ALLOW_REMOTE=1`` is set. The API app carries its own
  access gate (``raven/core/access.py::TokenGate``, shared with MCP and with
  ``python -m raven.api``) — loopback clients pass, every other source (tailnet
  included, #24) needs a Bearer token from ``raven mcp token add``. Anything else —
  unset, blank, malformed, wildcard, or a named address — falls back to
  loopback. The readiness JSON always reports 127.0.0.1 so the local webview
  keeps working.

  MCP binds separately (--mcp-host). v0.7.182 §31: when the API binds 0.0.0.0,
  MCP binds 0.0.0.0 too, behind ``raven.mcp.auth.LanTokenAuth`` (the same gated
  app as standalone ``raven.mcp.cli``) — loopback clients pass, every other source
  (tailnet included since #26, LAN) needs a Bearer token issued with
  ``raven mcp token add``. With no token issued every non-loopback request gets 401.
  Narrow it again with --mcp-host / RAVEN_MCP_HOST (e.g. the Tailscale IP).

MCP is best-effort (v0.7.184+)
------------------------------
MCP now defaults to ON in the shell, so a broken MCP listener must never take
the whole desktop app down with it. Every MCP failure — port already taken by
``./raven.sh start``, SDK import error, bind race, startup timeout — degrades to
"API only": a warning on stderr, ``mcp_port`` omitted from the readiness JSON,
and the app boots normally. Before v0.7.184 any of these returned 1 before the
readiness line was printed, which the Tauri side surfaced as a hard
"Python Core readiness 형식 오류" and no window at all.

SDK: mcp>=2.0. 2.0 removed ``mcp.server.fastmcp``; the ergonomic server class is
``mcp.server.mcpserver.MCPServer`` and ``transport_security`` moved off the
constructor onto ``streamable_http_app()``.
"""
from __future__ import annotations

import argparse
import asyncio
import errno
import json
import os
import select
import secrets
import signal
import socket
import sys
import threading
import time


# Issue #14: bind policy and the access gate are shared with the standalone
# API (`python -m raven.api`) — one implementation in raven/core/access.py.
from raven.core.access import (  # noqa: E402 — re-exported for callers/tests
    LOOPBACK_HOST,
    allow_remote_from_env,
    is_loopback_host as _is_loopback_host,
    safe_bind_host,
    serve_kwargs,
)

# v0.7.184+: 8765였다 — API 기본 포트와 같은 값이어서, --mcp를 켜는 순간
# API가 8765를 선점한 뒤 MCP가 같은 포트에 bind를 시도해 반드시 실패했다.
# raven.sh의 포트 매트릭스(API 8765 / MCP 8766 / team 8767)와 맞춘다.
DEFAULT_MCP_PORT = int(os.environ.get("PORT_MCP", "8766"))


DEFAULT_API_PORT = int(os.environ.get("PORT_API", "8765"))

# Issue #23: the Tauri shell sets this to its own PID. If the shell dies without
# running its exit hook (SIGTERM/SIGHUP, crash, SIGKILL) the Core is reparented
# and notices, instead of living on as an orphan holding the API/MCP ports.
PARENT_PID_ENV = "RAVEN_DESKTOP_PARENT_PID"


def _watched_parent_pid() -> int | None:
    """The shell PID to watch, or None when not launched by the shell.

    A value that names a live process other than our parent (inherited by a
    process the shell did not spawn directly), or is malformed, disables the
    watch rather than shutting down a Core whose parent is alive. A value naming
    a process that no longer exists means the shell died before we got here
    (during interpreter start-up), so it is still watched and the Core exits.
    """
    raw = os.environ.get(PARENT_PID_ENV, "").strip()
    if not raw:
        return None
    try:
        pid = int(raw)
    except ValueError:
        pid = None
    if pid is not None and pid != os.getppid():
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return pid  # parent already gone — the wait loop shuts us down
        except OSError:
            pass  # exists but not ours to signal: alive, not our parent
    if pid is None or pid != os.getppid():
        print(
            f"⚠️  [Desktop Core] {PARENT_PID_ENV}={raw!r} is not this process's parent — "
            "not watching for parent exit",
            file=sys.stderr,
        )
        return None
    return pid


class _PipeSafeStream:
    """Wrap stdout/stderr so a closed pipe never becomes a request failure.

    The Tauri shell pipes both streams, reads stdout for the readiness line
    (and stderr only if that fails), then drops the handles. Afterwards every
    ``sys.stderr.write`` raised BrokenPipeError inside whichever request
    handler happened to log a warning — hybrid-search / rag returned 500 while
    endpoints that stay quiet kept working. Once a write fails with an OSError
    the stream is swapped for ``os.devnull`` and later writes are dropped.
    """

    def __init__(self, stream):
        self._stream = stream

    def _fallback(self) -> None:
        try:
            self._stream = open(os.devnull, "w", encoding="utf-8")
        except OSError:
            self._stream = None

    def write(self, data: str) -> int:
        if self._stream is None:
            return len(data)
        try:
            return self._stream.write(data)
        except OSError:
            self._fallback()
            return len(data)

    def flush(self) -> None:
        if self._stream is None:
            return
        try:
            self._stream.flush()
        except OSError:
            self._fallback()

    def __getattr__(self, name: str):
        return getattr(self._stream, name)


def _harden_std_streams() -> None:
    sys.stdout = _PipeSafeStream(sys.stdout)
    sys.stderr = _PipeSafeStream(sys.stderr)


_OS_PORT_ATTEMPTS = 20
_PROBE_HEADER = "x-raven-core-probe"


def _answered_by_other(listener: socket.socket | None, host: str, port: int) -> bool:
    """Connect to ``host:port`` and report whether someone other than ``listener`` answered.

    ``listener`` (when given) is already listening, so a connection that lands
    in its accept queue reached us. A refusal means nobody listens there. A
    connection we did not receive, a timeout or any other error counts as
    another owner — an unclear answer never claims the port.
    """
    try:
        probe = socket.create_connection((host, port), timeout=0.5)
    except ConnectionRefusedError:
        return False
    except OSError:
        return True
    with probe:
        if listener is None:
            return True
        readable, _, _ = select.select([listener], [], [], 0.2)
        if not readable:
            return True
        conn, _ = listener.accept()
        conn.close()
        return False


def _bind_api_socket(host: str = LOOPBACK_HOST) -> socket.socket:
    """Bind and listen on the API socket — preferred port first, else OS-assigned.

    Issue #22: macOS/BSD let ``0.0.0.0:P`` bind under SO_REUSEADDR while another
    process listens on ``127.0.0.1:P`` (and vice versa), and the more specific
    bind keeps the loopback traffic — so the webview, which dials 127.0.0.1,
    reached the other server. A bind that succeeds is therefore not enough:
    the port counts as taken if anything else answers on loopback (where the
    webview dials) or on the bind host itself. SO_REUSEADDR stays so a port
    left in TIME_WAIT by our own previous run is still reused.

    The check runs on the socket we keep: it is already listening when probed
    and is handed to uvicorn as is, so there is no gap between the check and
    the real bind for another process to take. (Probing before listening does
    not work — macOS drops a SYN to a bound, non-listening socket.)
    """
    dial_hosts = {LOOPBACK_HOST}
    if host not in ("0.0.0.0", LOOPBACK_HOST):
        dial_hosts.add(host)
    for port in [DEFAULT_API_PORT] + [0] * _OS_PORT_ATTEMPTS:
        # Before we bind: a server on 0.0.0.0:P still answers loopback here, but
        # once our more specific 127.0.0.1:P bind exists we would shadow it and
        # the check below would only ever see ourselves.
        if port and any(_answered_by_other(None, h, port) for h in dial_hosts):
            continue
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
            sock.listen(2048)
        except OSError:
            sock.close()
            continue
        actual = sock.getsockname()[1]
        if any(_answered_by_other(sock, h, actual) for h in dial_hosts):
            sock.close()
            continue
        return sock
    raise OSError(f"no API port on {host} that is free on {', '.join(sorted(dial_hosts))}")


def _bind_loopback_guard(port: int) -> socket.socket | None:
    """Also hold ``127.0.0.1:port`` next to a ``0.0.0.0:port`` API socket.

    Issue #49: on macOS another process could bind the more specific
    ``127.0.0.1:port`` after readiness (SO_REUSEADDR or SO_REUSEPORT) and take
    every webview request. Holding that exact address ourselves makes such a
    bind fail with EADDRINUSE; uvicorn serves both sockets.

    Linux already refuses that bind while the wildcard listens — and refuses
    ours too, with EADDRINUSE — so on Linux that one error means the wildcard
    socket alone is safe and None is returned. Any other failure (another
    errno, or any error elsewhere — on macOS it would mean someone else holds
    the address) is raised so the caller can refuse to report ready.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((LOOPBACK_HOST, port))
        sock.listen(2048)
    except OSError as exc:
        sock.close()
        if sys.platform.startswith("linux") and exc.errno == errno.EADDRINUSE:
            return None
        raise
    return sock


class _ProbeResponder:
    """ASGI wrapper that answers this process's own identity probe.

    A request carrying the per-start nonce in ``x-raven-core-probe`` is answered
    here (204) and recorded; every other request goes to the app untouched. The
    nonce lives only in memory and is never sent back, so seeing the event set
    proves the probe reached *this* process — whatever the response looked like.

    This is identity, not authentication: the nonce grants nothing and is not
    checked anywhere else. A client that sends it only gets an empty 204 instead
    of reaching the app; access control stays with the app's TokenGate.
    """

    def __init__(self, app, nonce: str) -> None:
        self.app = app
        self._nonce = nonce.encode()
        self.seen = threading.Event()

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and (_PROBE_HEADER.encode(), self._nonce) in scope.get("headers", []):
            self.seen.set()
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})
            return
        await self.app(scope, receive, send)


def _endpoint_is_self(responder: _ProbeResponder, nonce: str, port: int) -> bool:
    """Probe the readiness endpoint and check that this process received it."""
    import http.client

    try:
        conn = http.client.HTTPConnection(LOOPBACK_HOST, port, timeout=3)
        conn.request("GET", "/", headers={_PROBE_HEADER: nonce})
        conn.getresponse().read()
        conn.close()
    except OSError:
        pass
    return responder.seen.wait(timeout=1)


def _port_is_free(host: str, port: int) -> bool:
    """True if `port` can be bound on `host` right now.

    Used to detect a standalone `./raven.sh start` MCP already serving 8766 so
    the desktop app cedes the port instead of racing it.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
        return True
    except OSError:
        return False


def _resolve_mcp_host(explicit: str | None, api_host: str) -> str:
    """Pick the MCP bind address — follows the API, explicit override wins.

    Binding 0.0.0.0 is safe because the MCP app is wrapped in LanTokenAuth
    (every non-loopback client, tailnet included since #26, needs a token). Before
    v0.7.182 §31 this fell back to the Tailscale IP since MCP had no auth at all.
    """
    if explicit:
        return explicit
    return api_host


def _advertised_mcp_host(bind_host: str) -> str:
    """Address to report in the readiness line — 0.0.0.0 is not dialable.

    The shell shows it as the MCP endpoint; prefer the tailnet address (reachable
    from the owner's other devices — with a token since #26), else loopback.
    """
    if bind_host != "0.0.0.0":
        return bind_host
    try:
        from raven.api.main import get_tailscale_ip

        ts_ip = get_tailscale_ip()
    except Exception:  # noqa: BLE001 — no tailnet is a normal state, not an error
        ts_ip = None
    return ts_ip or LOOPBACK_HOST


def _build_mcp_app(mode: str, host: str):
    """The same gated streamable-http app as standalone ``raven.mcp.cli`` (Issue #26)."""
    from raven.mcp.cli import build_http_app

    return build_http_app(mode, host)


def main() -> int:
    parser = argparse.ArgumentParser(prog="raven-desktop-core")
    parser.add_argument(
        "--host",
        default=None,
        help="Bind address (default: RAVEN_HOST or 127.0.0.1; 0.0.0.0 needs RAVEN_ALLOW_REMOTE=1)",
    )
    parser.add_argument("--mcp", action="store_true", help="Enable MCP HTTP listener")
    parser.add_argument("--mcp-port", type=int, default=DEFAULT_MCP_PORT, help="MCP HTTP port")
    parser.add_argument(
        "--mcp-host",
        default=os.environ.get("RAVEN_MCP_HOST") or None,
        help="MCP bind host (default: Tailscale IP when the API binds 0.0.0.0, else loopback)",
    )
    parser.add_argument("--mcp-mode", choices=["read", "write", "admin"], default="read")
    args = parser.parse_args()

    # Before uvicorn/logging capture sys.stderr: a dropped shell pipe must not
    # turn into BrokenPipeError inside request handlers (see _PipeSafeStream).
    _harden_std_streams()

    # Issue #23: decide what to watch now, while the shell is almost certainly
    # still our parent; the check itself runs in the wait loop after readiness,
    # which also catches a shell that died during API/MCP start-up.
    parent_pid = _watched_parent_pid()

    import uvicorn

    # 우선순위: --host > RAVEN_HOST > loopback (standalone `raven.api.main`과 동일).
    # Tauri는 RAVEN_DESKTOP_HOST > RAVEN_HOST로 고른 값을 --host로 넘기므로, 자식이
    # 상속한 RAVEN_HOST가 그 결정을 뒤집으면 안 된다.
    bind_host = args.host if args.host is not None else os.environ.get("RAVEN_HOST", "")
    # `--host tailscale` is itself the opt-in: the tailnet is authenticated by
    # Tailscale (same trust rule as `raven.mcp.auth`), so it needs no extra flag.
    tailscale_requested = bind_host.strip().lower() in ("tailscale", "auto-tailscale", "ts")
    allow_remote = allow_remote_from_env() or tailscale_requested
    # Issue #14: resolve before anything else touches the host. A wildcard or
    # named address only survives when remote access was opted into.
    bind_host = safe_bind_host(bind_host, allow_remote)
    if tailscale_requested:
        from raven.api.main import get_tailscale_ip
        ts_ip = get_tailscale_ip()
        if ts_ip:
            bind_host = ts_ip
            print(f"🔒 [Desktop Core] Auto-bound to Tailscale IP: {ts_ip}", file=sys.stderr)
        else:
            # No tailnet is not an excuse to fall back to every interface.
            bind_host = LOOPBACK_HOST

    api_sock = _bind_api_socket(bind_host)
    api_port = api_sock.getsockname()[1]
    api_socks = [api_sock]
    if bind_host == "0.0.0.0":
        try:
            guard = _bind_loopback_guard(api_port)
        except OSError as exc:
            # Fail closed (#49): without the guard another process could take
            # loopback after readiness, so do not report ready at all.
            api_sock.close()
            print(
                f"Python Core: could not hold {LOOPBACK_HOST}:{api_port} next to 0.0.0.0 "
                f"({exc}) — refusing to report ready",
                file=sys.stderr,
            )
            return 1
        if guard is not None:
            api_socks.append(guard)

    # Issue #14: RAVEN_ALLOW_ALL_CORS is NOT set here. `raven.api.main` imports
    # `raven.api.server` (which snapshots the CORS config) before this module
    # would set it, so the old auto-assignment never took effect — but leaving
    # it in place invited a future import-order change to silently reopen `*`.
    # CORS is allow-listed by origin in raven/api/server.py; it is not an access
    # control, and a non-browser client ignores it entirely.

    # CORS: allow the Tauri webview origin (prod + dev) before app import.
    extra = os.environ.get("RAVEN_EXTRA_CORS_ORIGIN", "")
    os.environ["RAVEN_EXTRA_CORS_ORIGIN"] = (
        f"{extra},http://tauri.localhost,http://localhost:5173"
        if extra
        else "http://tauri.localhost,http://localhost:5173"
    )

    os.environ["RAVEN_BOUND_HOST"] = bind_host
    os.environ["RAVEN_BOUND_PORT"] = str(api_port)

    # Issue #14: the access gate is part of `raven.api.app` itself
    # (raven/api/server.py → raven/core/access.py::TokenGate), so the desktop and
    # standalone launchers serve the exact same policy. Wrapping it again here
    # would be a second, divergent copy of the rule.
    if not _is_loopback_host(bind_host):
        print(
            "🔐 [Desktop Core] API bound to "
            f"{bind_host} — loopback only without a token; LAN and tailnet need a Bearer token "
            "(raven mcp token add <name>)",
            file=sys.stderr,
        )
    # Issue #22: a per-start nonce lets the readiness check confirm that the
    # endpoint handed to the webview is served by this process (see below).
    from raven.api import app as api_app

    probe_nonce = secrets.token_hex(16)
    api_target = _ProbeResponder(api_app, probe_nonce)

    api_config = uvicorn.Config(
        api_target,
        host=bind_host,
        port=api_port,
        log_level="warning",
        # PR #21 P0: FORWARDED_ALLOW_IPS must not let uvicorn rewrite the client
        # before the gate runs — the gate reads proxy headers itself.
        **serve_kwargs(),
    )
    api_server = uvicorn.Server(api_config)

    # Optional MCP server — best-effort, never fatal (see module docstring).
    mcp_server: uvicorn.Server | None = None
    if args.mcp:
        mcp_host = _resolve_mcp_host(args.mcp_host, bind_host)
        if mcp_host == "0.0.0.0":
            print(
                "🔐 [Desktop Core] MCP bound to 0.0.0.0 — loopback only without a token; "
                "tailnet/LAN need a Bearer token (raven mcp token add <name>)",
                file=sys.stderr,
            )
        if not _port_is_free(mcp_host, args.mcp_port):
            print(
                f"⚠️  [Desktop Core] MCP port {args.mcp_port} already in use "
                f"(standalone ./raven.sh start?) — skipping desktop MCP, API only.",
                file=sys.stderr,
            )
        else:
            try:
                mcp_app = _build_mcp_app(args.mcp_mode, mcp_host)
                mcp_config = uvicorn.Config(
                    mcp_app,
                    host=mcp_host,
                    port=args.mcp_port,
                    log_level="warning",
                    **serve_kwargs(),
                )
                mcp_server = uvicorn.Server(mcp_config)
            except Exception as exc:  # noqa: BLE001 — degrade, don't take the app down
                print(
                    f"⚠️  [Desktop Core] MCP disabled — failed to build server: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )

    def stop(_signum: int, _frame: object) -> None:
        api_server.should_exit = True
        if mcp_server is not None:
            mcp_server.should_exit = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    api_thread = threading.Thread(target=api_server.run, kwargs={"sockets": api_socks}, daemon=True)
    api_thread.start()

    mcp_thread: threading.Thread | None = None
    if mcp_server is not None:
        mcp_thread = threading.Thread(target=mcp_server.run, daemon=True)
        mcp_thread.start()

    # Wait for API readiness — this one IS fatal; without the API there is no app.
    deadline = time.monotonic() + 10
    while not api_server.started:
        if time.monotonic() > deadline:
            print("Python Core: uvicorn startup timeout", file=sys.stderr)
            return 1
        time.sleep(0.05)

    # Wait for MCP readiness — degrade to API-only on timeout or thread death.
    mcp_ready = False
    if mcp_server is not None and mcp_thread is not None:
        mcp_deadline = time.monotonic() + 10
        while True:
            if mcp_server.started:
                mcp_ready = True
                break
            if not mcp_thread.is_alive():
                print(
                    "⚠️  [Desktop Core] MCP listener died during startup "
                    "(port conflict?) — continuing API only.",
                    file=sys.stderr,
                )
                break
            if time.monotonic() > mcp_deadline:
                print(
                    "⚠️  [Desktop Core] MCP startup timeout — continuing API only.",
                    file=sys.stderr,
                )
                mcp_server.should_exit = True
                break
            time.sleep(0.05)

    # Issue #22: never hand the webview an endpoint some other server answers.
    # A specific non-loopback bind (e.g. the Tailscale IP) is not on loopback at
    # all, so the readiness address cannot be ours there — that is #16.
    if bind_host in ("0.0.0.0", LOOPBACK_HOST):
        if not _endpoint_is_self(api_target, probe_nonce, api_port):
            print(
                f"Python Core: {LOOPBACK_HOST}:{api_port} is answered by another process — "
                "refusing to report it as ready",
                file=sys.stderr,
            )
            api_server.should_exit = True
            if mcp_server is not None:
                mcp_server.should_exit = True
            api_thread.join(timeout=5)
            if mcp_thread is not None:
                mcp_thread.join(timeout=5)
            return 1
    else:
        print(
            f"⚠️  [Desktop Core] API bound to {bind_host} only — the loopback readiness "
            f"endpoint {LOOPBACK_HOST}:{api_port} is not served by this process (#16)",
            file=sys.stderr,
        )

    ready = {"host": LOOPBACK_HOST, "port": api_port}
    if mcp_ready:
        ready["mcp_port"] = args.mcp_port
        ready["mcp_host"] = _advertised_mcp_host(mcp_host)
    print(json.dumps(ready), flush=True)

    try:
        while not api_server.should_exit:
            if parent_pid is not None and os.getppid() != parent_pid:
                print(
                    f"[Desktop Core] parent shell (pid {parent_pid}) is gone — shutting down",
                    file=sys.stderr,
                )
                break
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    api_server.should_exit = True
    if mcp_server is not None:
        mcp_server.should_exit = True
    api_thread.join(timeout=5)
    if mcp_thread is not None:
        mcp_thread.join(timeout=5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

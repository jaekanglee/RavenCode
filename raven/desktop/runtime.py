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
  but only when ``RAVEN_ALLOW_REMOTE=1`` is set. This API has no authentication
  (``raven/api/`` ships zero auth middleware), so the wide bind is wrapped in
  ``raven.mcp.auth.LanTokenAuth`` — loopback/tailnet clients pass, every other
  source needs a Bearer token from ``raven mcp token add``. Anything else —
  unset, blank, malformed, wildcard, or a named address — falls back to
  loopback. The readiness JSON always reports 127.0.0.1 so the local webview
  keeps working.

  MCP binds separately (--mcp-host). v0.7.182 §31: when the API binds 0.0.0.0,
  MCP binds 0.0.0.0 too, behind ``raven.mcp.auth.LanTokenAuth`` — loopback and
  tailnet clients pass as before, every other source (LAN) needs a Bearer token
  issued with ``raven mcp token add``. With no token issued the LAN gets 401 on
  every request, so the wider bind changes nothing until the owner opts in.
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
import ipaddress
import json
import os
import signal
import socket
import sys
import threading
import time


LOOPBACK_HOST = "127.0.0.1"

# Issue #14: remote access is an explicit opt-in. This API has no auth, so a
# wide bind is only ever the operator's own decision — never a default.
_ALLOW_REMOTE_ENV = "RAVEN_ALLOW_REMOTE"

def allow_remote_from_env(raw: str | None = None) -> bool:
    """True only for an explicit truthy ``RAVEN_ALLOW_REMOTE``."""
    if raw is None:
        raw = os.environ.get(_ALLOW_REMOTE_ENV, "")
    return raw.strip().lower() in ("1", "true", "yes", "on")

def safe_bind_host(host: str | None, allow_remote: bool = False) -> str:
    """Resolve a requested bind host to something safe to bind.

    Fail-closed: anything that is not a loopback address resolves to loopback
    unless remote access was explicitly opted into. This is deliberately *not*
    an error — the shell always passes a host, so rejecting the launch would
    leave the user with no window at all.

    Loopback spellings (``127.0.0.1``, ``localhost``, ``::1``, ``[::1]``) all
    normalise to ``127.0.0.1`` so callers get one canonical value to bind and
    report. Wildcards (``0.0.0.0``, ``::``, ``0:0:0:0:0:0:0:0``) and named
    addresses are honoured only under ``allow_remote``.
    """
    if host is None:
        return LOOPBACK_HOST
    candidate = host.strip()
    if not candidate:
        return LOOPBACK_HOST

    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]

    try:
        addr = ipaddress.ip_address(candidate)
    except ValueError:
        # "localhost" is loopback; every other hostname is treated as remote
        # (it would resolve to an interface we cannot vouch for).
        if candidate.lower() == "localhost":
            return LOOPBACK_HOST
        return candidate if allow_remote else LOOPBACK_HOST

    # IPv4-mapped IPv6 (::ffff:0.0.0.0) reaches the whole IPv4 space.
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped

    if addr.is_loopback:
        return LOOPBACK_HOST
    if allow_remote:
        return str(addr)
    return LOOPBACK_HOST

# v0.7.184+: 8765였다 — API 기본 포트와 같은 값이어서, --mcp를 켜는 순간
# API가 8765를 선점한 뒤 MCP가 같은 포트에 bind를 시도해 반드시 실패했다.
# raven.sh의 포트 매트릭스(API 8765 / MCP 8766 / team 8767)와 맞춘다.
DEFAULT_MCP_PORT = int(os.environ.get("PORT_MCP", "8766"))


DEFAULT_API_PORT = int(os.environ.get("PORT_API", "8765"))


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


def _free_port(host: str = LOOPBACK_HOST) -> int:
    """Try preferred 8765 port first, fallback to OS assigned free port if occupied."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, DEFAULT_API_PORT))
            return DEFAULT_API_PORT
    except Exception:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind((host, 0))
            return s.getsockname()[1]


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
    (LAN clients need a token; loopback/tailnet pass). Before v0.7.182 §31 this
    fell back to the Tailscale IP since MCP had no auth at all.
    """
    if explicit:
        return explicit
    return api_host


def _advertised_mcp_host(bind_host: str) -> str:
    """Address to report in the readiness line — 0.0.0.0 is not dialable.

    The shell shows it as the MCP endpoint; prefer the tailnet (no token
    needed there), else loopback.
    """
    if bind_host != "0.0.0.0":
        return bind_host
    try:
        from raven.api.main import get_tailscale_ip

        ts_ip = get_tailscale_ip()
    except Exception:  # noqa: BLE001 — no tailnet is a normal state, not an error
        ts_ip = None
    return ts_ip or LOOPBACK_HOST


def _is_loopback_host(host: str) -> bool:
    """True when ``host`` only ever receives local traffic."""
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return host.strip().lower() == "localhost"
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return addr.is_loopback

def _build_mcp_app(mode: str, host: str):
    """Create the MCPServer streamable-http Starlette app (same as raven.mcp.cli)."""
    from mcp.server.mcpserver import MCPServer
    from mcp.server.transport_security import TransportSecuritySettings
    from raven.mcp.auth import LanTokenAuth
    from raven.mcp.cli import register_tools, server_instructions
    from raven.mcp.resources import register_resources
    from raven.core.registry import registry

    reg = registry()
    vault_names = sorted(v.name for v in reg.list())

    mcp = MCPServer(
        "wiki",
        instructions=server_instructions(vault_names),
    )
    register_tools(mcp, mode)
    register_resources(mcp)
    # transport_security: SDK가 host 미지정 시 Host 헤더를 loopback으로 잠가
    # Tailscale/LAN 클라이언트에 421을 준다. raven.mcp.cli와 동일 정책.
    return LanTokenAuth(mcp.streamable_http_app(
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        host=host,
    ))


def main() -> int:
    parser = argparse.ArgumentParser(prog="raven-desktop-core")
    parser.add_argument(
        "--host",
        default=LOOPBACK_HOST,
        help="Bind address (127.0.0.1 default; 0.0.0.0 for Tailscale/external access)",
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

    import uvicorn

    bind_host = os.environ.get("RAVEN_HOST", args.host)
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
    if bind_host == "0.0.0.0":
        print(
            "⚠️  [Desktop Core] API bound to 0.0.0.0 (RAVEN_ALLOW_REMOTE=1). "
            "Loopback/tailnet clients pass; every other source needs a Bearer "
            "token from `raven mcp token add <name>`.",
            file=sys.stderr,
        )

    api_port = _free_port(bind_host)

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

    # Issue #14: import the app object *before* uvicorn so a non-loopback bind
    # can be wrapped in the same Bearer-token gate MCP already uses. Loopback
    # binds keep the plain string form — no behaviour change for the normal case.
    from raven.api import app as api_app

    if not _is_loopback_host(bind_host):
        # Remote access is opt-in, but the API has no auth of its own, so the
        # opt-in alone would still expose every vault read and
        # `DELETE /api/vaults/{name}?force=true` to the LAN. Reuse the existing
        # token owner: loopback/tailnet pass, every other source needs a token
        # issued with `raven mcp token add <name>` — no tokens, no access.
        from raven.mcp.auth import LanTokenAuth

        print(
            "🔐 [Desktop Core] API bound to "
            f"{bind_host} — loopback/tailnet open, LAN needs a Bearer token "
            "(raven mcp token add <name>)",
            file=sys.stderr,
        )
        api_target = LanTokenAuth(api_app)
    else:
        api_target = "raven.api:app"

    api_config = uvicorn.Config(
        api_target,
        host=bind_host,
        port=api_port,
        log_level="warning",
    )
    api_server = uvicorn.Server(api_config)

    # Optional MCP server — best-effort, never fatal (see module docstring).
    mcp_server: uvicorn.Server | None = None
    if args.mcp:
        mcp_host = _resolve_mcp_host(args.mcp_host, bind_host)
        if mcp_host == "0.0.0.0":
            print(
                "🔐 [Desktop Core] MCP bound to 0.0.0.0 — loopback/tailnet open, "
                "LAN needs a token (raven mcp token add <name>)",
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

    api_thread = threading.Thread(target=api_server.run, daemon=True)
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

    ready = {"host": LOOPBACK_HOST, "port": api_port}
    if mcp_ready:
        ready["mcp_port"] = args.mcp_port
        ready["mcp_host"] = _advertised_mcp_host(mcp_host)
    print(json.dumps(ready), flush=True)

    try:
        while not api_server.should_exit:
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

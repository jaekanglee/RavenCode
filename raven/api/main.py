"""api.main — uvicorn entry point.

Usage:
    python -m raven.api                                        # 127.0.0.1:8765
    RAVEN_ALLOW_REMOTE=1 python -m raven.api --host 0.0.0.0    # remote, token-gated
    python -m raven.api --host tailscale                       # tailnet IP only

Remote binds are opt-in (Issue #14). The access gate lives in the app itself
(raven/core/access.py), so loopback/tailnet sources pass and every other source
needs a Bearer token from `raven mcp token add <name>` — however the app is served.
"""
from __future__ import annotations

import argparse
import sys

import uvicorn


import os
import socket

def get_tailscale_ip() -> str | None:
    """Detect Tailscale IP (100.64.0.0/10) on local network interfaces."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("100.100.100.100", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip.startswith("100."):
            return ip
    except Exception:
        pass
    try:
        _, _, ips = socket.gethostbyname_ex(socket.gethostname())
        for ip in ips:
            if ip.startswith("100."):
                parts = [int(p) for p in ip.split(".")]
                if len(parts) == 4 and parts[0] == 100 and (64 <= parts[1] <= 127):
                    return ip
    except Exception:
        pass
    return None

def get_lan_ip() -> str | None:
    """Detect this machine's LAN IP (192.168/10/172.16-31), distinct from Tailscale (100.64.0.0/10)."""
    def _is_lan(ip: str) -> bool:
        parts = ip.split(".")
        if len(parts) != 4:
            return False
        try:
            octets = [int(p) for p in parts]
        except ValueError:
            return False
        if octets[0] == 192 and octets[1] == 168:
            return True
        if octets[0] == 10:
            return True
        if octets[0] == 172 and 16 <= octets[1] <= 31:
            return True
        return False

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if _is_lan(ip):
            return ip
    except Exception:
        pass
    try:
        _, _, ips = socket.gethostbyname_ex(socket.gethostname())
        for ip in ips:
            if _is_lan(ip):
                return ip
    except Exception:
        pass
    return None

TAILSCALE_ALIASES = ("tailscale", "auto-tailscale", "ts")


def main(argv=None) -> int:
    from raven.core.access import (
        ALLOW_REMOTE_ENV,
        LOOPBACK_HOST,
        allow_remote_from_env,
        is_loopback_host,
        safe_bind_host,
    )

    parser = argparse.ArgumentParser(prog="raven-api")
    default_port = int(os.environ.get("RAVEN_PORT", os.environ.get("PORT_API", "8765")))
    parser.add_argument(
        "--host",
        default=None,
        help="Host to bind (default: RAVEN_HOST or 127.0.0.1; 'tailscale' binds the tailnet IP). "
        f"Non-loopback / wildcard binds need {ALLOW_REMOTE_ENV}=1.",
    )
    parser.add_argument("--port", type=int, default=default_port, help="Port to bind (default: RAVEN_PORT or 8765)")
    parser.add_argument("--reload", action="store_true", help="dev: auto-reload")
    args = parser.parse_args(argv)

    # 우선순위: --host > RAVEN_HOST > loopback (desktop runtime과 동일).
    requested = args.host if args.host is not None else os.environ.get("RAVEN_HOST", "")

    if requested.strip().lower() in TAILSCALE_ALIASES:
        # `--host tailscale` is itself the opt-in: it binds only the tailnet
        # interface, which the access gate trusts (raven/core/access.py).
        ts_ip = get_tailscale_ip()
        if ts_ip:
            bind_host = ts_ip
            print(f"🔒 [Tailscale Auto-Detect] Found Tailscale IP: {ts_ip}")
        else:
            # Issue #14: no tailnet is not a reason to open every interface.
            print(
                "⚠️  [Tailscale Auto-Detect] Tailscale IP not found — "
                "binding loopback instead of 0.0.0.0"
            )
            bind_host = LOOPBACK_HOST
    else:
        allow_remote = allow_remote_from_env()
        if requested.strip() and not is_loopback_host(requested) and not allow_remote:
            # Issue #14: an explicit remote bind without the opt-in is refused
            # loudly rather than silently narrowed — the operator asked for
            # something specific and should learn why they did not get it.
            print(
                f"❌ [raven-api] refusing to bind {requested.strip()!r}: non-loopback binds need "
                f"{ALLOW_REMOTE_ENV}=1. Even then, sources other than loopback/tailnet need a "
                "Bearer token from `raven mcp token add <name>`.",
                file=sys.stderr,
            )
            return 2
        bind_host = safe_bind_host(requested, allow_remote)

    if not is_loopback_host(bind_host):
        print(
            f"🔐 [raven-api] bound to {bind_host} — loopback/tailnet open, every other source "
            "needs a Bearer token (raven mcp token add <name>).",
            file=sys.stderr,
        )

    # v0.7.178: 실제 바인드된 호스트를 app에 전달 — /api/system/info가 추정값이 아닌 실제값을 보고하게 한다.
    os.environ["RAVEN_BOUND_HOST"] = bind_host
    os.environ["RAVEN_BOUND_PORT"] = str(args.port)

    uvicorn.run(
        "raven.api:app",
        host=bind_host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

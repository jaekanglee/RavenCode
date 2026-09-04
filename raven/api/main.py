"""api.main — uvicorn entry point.

Usage:
    python -m raven.api                            # 127.0.0.1:8765
    python -m raven.api --host 0.0.0.0 --port 9000
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

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="raven-api")
    env_host = os.environ.get("RAVEN_HOST", "")
    default_host = env_host if env_host else ("0.0.0.0" if os.environ.get("RAVEN_ALLOW_ALL_CORS") else "127.0.0.1")
    default_port = int(os.environ.get("RAVEN_PORT", os.environ.get("PORT_API", "8765")))
    parser.add_argument("--host", default=default_host, help="Host to bind (e.g. 127.0.0.1, 0.0.0.0, or 'tailscale')")
    parser.add_argument("--port", type=int, default=default_port, help="Port to bind (default: RAVEN_PORT or 8765)")
    parser.add_argument("--reload", action="store_true", help="dev: auto-reload")
    args = parser.parse_args(argv)

    bind_host = args.host
    if bind_host.lower() in ("tailscale", "auto-tailscale", "ts"):
        ts_ip = get_tailscale_ip()
        if ts_ip:
            bind_host = ts_ip
            print(f"🔒 [Tailscale Auto-Detect] Found Tailscale IP: {ts_ip}")
        else:
            print("⚠️  [Tailscale Auto-Detect] Tailscale IP not found, falling back to 0.0.0.0")
            bind_host = "0.0.0.0"

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

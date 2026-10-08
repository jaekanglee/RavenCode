"""Core API · MCP 공용 접근 정책 (Issue #14).

Raven API에는 계정이 없다. 대신 **요청이 어디서 왔는지**(소켓 주소)와 vault owner가
발급한 토큰으로 판정한다. 데스크톱 런타임, ``python -m raven.api``,
``uvicorn raven.api:app`` 어느 경로로 띄워도 같은 판정이 나오도록, 게이트는 실행기가
아니라 앱 자체(``raven/api/server.py``)에 붙는다. MCP(``raven.mcp.auth``)도 같은 판정을 쓴다.

판정 (출처 = ASGI ``scope["client"]``):

- loopback ``127.0.0.0/8``, ``::1`` (IPv4-mapped 포함) → 통과
- tailnet ``100.64.0.0/10``, ``fd7a:115c:a1e0::/48`` → 통과. Tailscale이 기기를 인증하고,
  제품 전제가 "신뢰된 단일 사용자 네트워크(localhost 또는 본인 tailnet)"다 (README 보안 전제,
  deployment D5, MCP ADR 2026-09-30).
- 그 외 → ``Authorization: Bearer <token>``이 ``raven mcp token add``로 발급한 토큰과 맞아야
  통과. 발급된 토큰이 없으면 전부 401 (fail-closed). 경로 예외는 없다 — health 포함.

Host / Origin / X-Forwarded-For 헤더는 판정에 쓰지 않는다. X-Forwarded-For는 uvicorn이
``forwarded_allow_ips``(기본 127.0.0.1)에 든 프록시가 보낸 경우에만 ``scope["client"]``로
옮긴다 — ``FORWARDED_ALLOW_IPS=*`` / ``--forwarded-allow-ips '*'``로 띄우면 LAN 기기가
헤더 한 줄로 loopback을 사칭할 수 있으므로 그렇게 띄우지 말 것.

bind 정책도 여기 둔다 (``safe_bind_host``): 기본 loopback, 비루프백·와일드카드는
``RAVEN_ALLOW_REMOTE``가 참일 때만. 게이트가 1차 방어, bind 제한이 2차 방어다.
"""
from __future__ import annotations

import ipaddress
import json
import os

from raven.core.mcp_tokens import verify_token

LOOPBACK_HOST = "127.0.0.1"
ALLOW_REMOTE_ENV = "RAVEN_ALLOW_REMOTE"

# loopback + Tailscale이 노드에 주는 주소 대역 (CGNAT IPv4 + Tailscale ULA IPv6).
TRUSTED_NETWORKS = (
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("fd7a:115c:a1e0::/48"),
)


def _parse_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    candidate = host.strip()
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    try:
        addr = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    # IPv4-mapped IPv6 (::ffff:a.b.c.d)는 IPv4 규칙으로 판정한다.
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        return addr.ipv4_mapped
    return addr


def is_trusted_client(host: str | None) -> bool:
    """loopback 또는 tailnet 출처인가. IP가 아닌 값(None, "", "testclient")은 신뢰하지 않는다."""
    if not host:
        return False
    addr = _parse_ip(host)
    if addr is None:
        return False
    return any(addr in net for net in TRUSTED_NETWORKS)


def has_valid_bearer(scope) -> bool:
    for key, value in scope.get("headers", []):
        if key == b"authorization":
            scheme, _, token = value.decode("latin-1").partition(" ")
            return scheme.lower() == "bearer" and bool(token.strip()) and verify_token(token.strip())
    return False


class TokenGate:
    """ASGI 게이트 — loopback/tailnet 외 출처에 Bearer 토큰을 요구한다.

    http와 websocket 둘 다 막는다. 거부된 요청은 감싼 앱에 전달되지 않는다.
    lifespan 등 다른 scope는 그대로 통과한다.
    """

    realm = "raven"
    detail = (
        "원격 접근에는 Authorization: Bearer <token>이 필요합니다 "
        "(raven mcp token add <name>)."
    )

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        client = scope.get("client")
        if is_trusted_client(client[0] if client else None) or has_valid_bearer(scope):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = json.dumps(
            {"ok": False, "error": "unauthorized", "detail": self.detail},
            ensure_ascii=False,
        ).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"content-type", b"application/json; charset=utf-8"),
                (b"www-authenticate", f'Bearer realm="{self.realm}"'.encode()),
                (b"content-length", str(len(body)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": body})


# ─── bind 정책 ────────────────────────────────────────────────


def allow_remote_from_env(raw: str | None = None) -> bool:
    """True only for an explicit truthy ``RAVEN_ALLOW_REMOTE`` (1/true/yes/on)."""
    if raw is None:
        raw = os.environ.get(ALLOW_REMOTE_ENV, "")
    return raw.strip().lower() in ("1", "true", "yes", "on")


def is_loopback_host(host: str) -> bool:
    """True when binding ``host`` only ever receives local traffic."""
    if host.strip().lower() == "localhost":
        return True
    addr = _parse_ip(host)
    return addr is not None and addr.is_loopback


def safe_bind_host(host: str | None, allow_remote: bool = False) -> str:
    """Resolve a requested bind host to something safe to bind.

    Fail-closed: anything that is not loopback resolves to loopback unless
    remote access was explicitly opted into. Loopback spellings (``127.0.0.1``,
    ``localhost``, ``::1``, ``[::1]``) normalise to ``127.0.0.1``. Wildcards
    (``0.0.0.0``, ``::``) and named addresses survive only under ``allow_remote``;
    IPv4-mapped forms (``::ffff:0.0.0.0``) are unwrapped to their IPv4 meaning.

    Narrowing (not raising) is what the desktop shell needs — it always passes a
    host, and refusing would leave no window. The standalone CLI refuses an
    explicit remote host before calling this (``raven/api/main.py``).
    """
    if host is None or not host.strip():
        return LOOPBACK_HOST
    if is_loopback_host(host):
        return LOOPBACK_HOST
    if not allow_remote:
        return LOOPBACK_HOST
    addr = _parse_ip(host)
    return str(addr) if addr is not None else host.strip()

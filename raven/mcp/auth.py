"""MCP 내부망 토큰 인증 (ADR 2026-09-30 mcp-lan-token-auth).

MCP는 인증이 없어서 tailnet에만 열었다. 내부망 기기에도 열되, vault owner가
허락한 사람만 들어오게 한다:

- loopback / tailnet 출처 → 그대로 통과 (tailnet은 Tailscale이 기기를 인증한다)
- 그 외 출처(내부망 등) → ``Authorization: Bearer <token>``이 발급된 토큰과 맞아야 통과.
  발급된 토큰이 없으면 전부 401 — 바인딩을 넓혀도 발급 전에는 지금과 같다.

토큰은 ``raven mcp token add <name>``으로 발급한다. 파일에는 SHA-256 해시만 두고,
요청마다 다시 읽어 revoke가 재시작 없이 반영된다.

적용 범위: 데스크톱 런타임(``raven.desktop.runtime``)의 MCP만. standalone
``raven.mcp.cli``(team 인스턴스, Docker)는 기존대로 — 이미 내부망에 열어 둔
배포가 401로 깨지지 않게 한다.

한계: 평문 HTTP라 같은 망에서 트래픽을 엿보면 토큰이 보인다 (사용자 수용).
출처 판단은 소켓 주소(ASGI ``scope["client"]``)만 쓴다 — 감싸는 uvicorn의 proxy
header 신뢰는 기본값(127.0.0.1 프록시만)으로 두어야 한다. ``forwarded_allow_ips="*"``
면 내부망 기기가 ``X-Forwarded-For: 127.0.0.1`` 한 줄로 검사를 건너뛴다.
"""
from __future__ import annotations

import ipaddress
import json

from raven.core.mcp_tokens import verify_token

# Tailscale이 노드에 주는 주소 대역 (CGNAT IPv4 + Tailscale ULA IPv6).
_TRUSTED_NETWORKS = (
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("fd7a:115c:a1e0::/48"),
)


def is_trusted_client(host: str | None) -> bool:
    if not host:
        return False
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return any(addr in net for net in _TRUSTED_NETWORKS)


class LanTokenAuth:
    """MCP ASGI 앱 앞단 — loopback/tailnet 외 출처에 Bearer 토큰을 요구한다."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        client = scope.get("client")
        if is_trusted_client(client[0] if client else None) or self._has_valid_bearer(scope):
            await self.app(scope, receive, send)
            return
        body = json.dumps({
            "error": "unauthorized",
            "detail": "내부망 접근에는 Authorization: Bearer <token>이 필요합니다 "
            "(raven mcp token add <name>).",
        }, ensure_ascii=False).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"content-type", b"application/json; charset=utf-8"),
                (b"www-authenticate", b'Bearer realm="raven-mcp"'),
                (b"content-length", str(len(body)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": body})

    @staticmethod
    def _has_valid_bearer(scope) -> bool:
        for key, value in scope.get("headers", []):
            if key == b"authorization":
                scheme, _, token = value.decode("latin-1").partition(" ")
                return scheme.lower() == "bearer" and bool(token.strip()) and verify_token(token.strip())
        return False

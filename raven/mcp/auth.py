"""MCP HTTP 접근 게이트 (ADR 2026-10-09 mcp-remote-token, Issue #26 · #67).

모든 MCP HTTP 리스너(데스크톱 런타임, ``./raven.sh start``, team launchd 인스턴스,
Docker ``mcp-http``)가 ``raven.mcp.cli.build_http_app``을 통해 이 게이트 뒤에서 뜬다:

- **모든 출처** — loopback(#67), tailnet(IPv4·IPv6, #26), 내부망, Docker/CGNAT — →
  ``Authorization: Bearer <token>``이 발급된 토큰과 맞아야 통과. 발급된 토큰이 없으면
  전부 401 (fail-closed). opt-out 플래그는 없다.
- 예외는 ``GET /healthz``(고정 본문 ``{"ok":true}``, MCP 앱에 닿지 않음)뿐이다.

loopback도 예외가 아닌 이유(#67): macOS Docker Desktop은 컨테이너의 ``host.docker.internal``
연결을 호스트 loopback으로 넘기고, 컨테이너는 Host·Origin을 마음대로 쓴다. tailnet 무인증
통과(ADR 2026-09-30)는 #26에서 없앴다. 판정 로직은 Core API와 같은 ``raven.core.access``를 쓴다.
데스크톱 셸의 세션 자격 증명(``access.set_session_token``)은 Core API 전용이라 여기서는 받지 않는다.

토큰은 ``raven mcp token add <name>``으로 발급한다. 파일에는 SHA-256 해시만 두고,
요청마다 다시 읽어 revoke가 재시작 없이 반영된다.

stdio 전송은 네트워크 리스너가 아니라 범위 밖이다.

한계: 평문 HTTP라 같은 망에서 트래픽을 엿보면 토큰이 보인다 (tailnet 구간은 WireGuard).
"""
from __future__ import annotations

from raven.core.access import TokenGate, is_trusted_client

__all__ = ["LanTokenAuth", "is_trusted_client"]


class LanTokenAuth(TokenGate):
    """MCP ASGI 앱 앞단 — 모든 출처에 발급된 Bearer 토큰을 요구한다 (loopback 포함, #67)."""

    realm = "raven-mcp"
    # MCP clients are agents with issued tokens; the desktop webview never calls MCP.
    accept_session_token = False
    detail = (
        "원격 MCP 접근(tailnet·내부망 포함)에는 Authorization: Bearer <token>이 필요합니다 "
        "(raven mcp token add <name>)."
    )

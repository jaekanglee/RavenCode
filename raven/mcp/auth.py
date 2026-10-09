"""MCP HTTP 접근 게이트 (ADR 2026-10-09 mcp-remote-token, Issue #26).

모든 MCP HTTP 리스너(데스크톱 런타임, ``./raven.sh start``, team launchd 인스턴스,
Docker ``mcp-http``)가 ``raven.mcp.cli.build_http_app``을 통해 이 게이트 뒤에서 뜬다:

- 직접 loopback 출처 → 토큰 없이 통과
- 그 외 모든 출처 — tailnet(IPv4·IPv6) 포함, 내부망, Docker/CGNAT — →
  ``Authorization: Bearer <token>``이 발급된 토큰과 맞아야 통과. 발급된 토큰이 없으면
  전부 401 (fail-closed). opt-out 플래그나 인증 없는 경로는 없다.

tailnet 무인증 통과(ADR 2026-09-30)는 #26에서 없앴다. 라우트 판정(``is_tailnet_peer``)은
추론일 뿐 수락된 연결의 WireGuard 인증 증명이 아니고, Core API는 이미 #24에서 같은
결정을 했다. 판정 로직은 Core API와 같은 ``raven.core.access``를 쓴다.

토큰은 ``raven mcp token add <name>``으로 발급한다. 파일에는 SHA-256 해시만 두고,
요청마다 다시 읽어 revoke가 재시작 없이 반영된다.

출처 판단은 소켓 주소(ASGI ``scope["client"]``)와, Raven 실행기(``serve_kwargs``)로 뜰 때
loopback 프록시가 붙인 X-Forwarded-For만 쓴다. Host·Origin은 보지 않는다.
stdio 전송은 네트워크 리스너가 아니라 범위 밖이다.

한계: 평문 HTTP라 같은 망에서 트래픽을 엿보면 토큰이 보인다 (tailnet 구간은 WireGuard).
"""
from __future__ import annotations

from raven.core.access import TokenGate, has_valid_bearer, is_trusted_client

__all__ = ["LanTokenAuth", "is_trusted_client"]


class LanTokenAuth(TokenGate):
    """MCP ASGI 앱 앞단 — loopback 외 모든 출처(tailnet 포함)에 Bearer 토큰을 요구한다."""

    realm = "raven-mcp"
    # Issue #26: like the Core API (#24), tailnet is not trusted without a token.
    trust_tailnet = False
    detail = (
        "원격 MCP 접근(tailnet·내부망 포함)에는 Authorization: Bearer <token>이 필요합니다 "
        "(raven mcp token add <name>)."
    )

    @staticmethod
    def _has_valid_bearer(scope) -> bool:
        return has_valid_bearer(scope)

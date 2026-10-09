---
title: MCP Remote Token
created: 2026-10-09
type: rule
tags: [rule, security, mcp, desktop, docker]
confidence: medium
status: accepted
---

# MCP Remote Token

> **결정:** 모든 MCP HTTP 리스너는 직접 loopback만 토큰 없이 받는다. tailnet을 포함한 그 밖의 모든 출처는 `raven mcp token add`로 발급한 Bearer 토큰이 필요하다. 대상은 데스크톱 런타임, `./raven.sh start`, team launchd 인스턴스, Docker `mcp-http`다. 인증 opt-out은 없다. 이 결정은 [[adr-2026-09-30-mcp-lan-token-auth]]의 tailnet 무인증 통과와 "standalone은 범위 밖"을 대체한다 (Issue #26). Core API의 같은 결정은 [[adr-2026-10-08-core-api-tailnet-token]]이다.

## 맥락

- #24는 Core API에서만 tailnet 무인증 신뢰를 걷어냈다. PR #25 리뷰에서 실제 소켓으로 재현한 결과, 데스크톱 원격 모드(`RAVEN_ALLOW_REMOTE=1`, MCP admin)에서 이 기기의 tailnet IP로 보낸 요청은 다음과 같았다.
  - Core API DELETE → 401
  - MCP `wiki_delete` → 토큰 없이 성공
- MCP가 Core API 토큰을 우회하는 경로였다.
- standalone `raven.mcp.cli`에는 게이트가 아예 없었다. uvicorn을 `forwarded_allow_ips="*"`와 `proxy_headers=True`로 띄워, 어떤 클라이언트든 X-Forwarded-For로 주소를 바꿀 수 있었다.
  - team 인스턴스: `0.0.0.0:8767`, write 모드
  - Docker `mcp-http`: 포트 공개, read 모드
  - #26 수정 전 이미지·코드로 LAN, tailnet, Docker CGNAT IPv4·IPv6에서 무토큰 `initialize`가 200이었다.
- 라우트 판정(`is_tailnet_peer`)은 추론일 뿐 수락된 연결의 WireGuard 인증 증명이 아니다 (#24와 같은 이유).

## 결정

| 출처 (게이트가 판정한 실효 출처) | 모든 MCP HTTP 리스너 |
|---|---|
| loopback `127.0.0.0/8`, `::1` | 통과 |
| tailnet, LAN, Docker 게이트웨이·CGNAT, IP 아님 | Bearer 필수 (`WWW-Authenticate: Bearer realm="raven-mcp"`), 발급 0개면 전부 401 |

- **게이트**: `raven/mcp/auth.py::LanTokenAuth.trust_tailnet = False`. Core API의 `TokenGate`와 같은 판정이다.
- **단일 앱 빌더**: `raven.mcp.cli.build_http_app(mode, host)`가 MCP Starlette 앱 전체를 게이트로 감싼다. 데스크톱 런타임(`_build_mcp_app`)과 standalone `main()`이 모두 이 함수를 쓴다. 그래서 `initialize`, `tools/list`, `tools/call`, GET 스트림, 세션 DELETE가 모두 게이트를 먼저 지난다. 경로 예외(health 등)는 없다.
- **프록시 정책**: standalone도 Core API처럼 `serve_kwargs()`(`proxy_headers=False`)로 뜬다. `scope["client"]`는 실제 소켓 peer다. X-Forwarded-For는 loopback peer가 보낸 것만 게이트가 해석한다. Host·Origin은 보지 않는다.
- **opt-out 없음**: 이전 동작으로 돌아가는 플래그를 두지 않는다. 인증 예외를 새로 만들지 않는다는 원칙 때문이다.
- **범위 밖**: stdio 전송. 네트워크 리스너가 아니다.

## 결과

- **Breaking change**: 다음은 모두 토큰을 넣을 때까지 401을 받는다.
  - tailnet에서 붙던 에이전트
  - team 인스턴스의 팀원
  - Docker `mcp-http` 클라이언트
  - 비-loopback 주소로 연 `./raven.sh start` MCP
  - 같은 PC(`127.0.0.1`)의 에이전트는 바꿀 것이 없다.
- **설정**: MCP 클라이언트 설정의 `headers`에 넣거나 `claude mcp add ... --header "Authorization: Bearer <token>"`로 넣는다. 토큰은 URL에 넣지 않는다.
- **SDK 동작**: MCP Python SDK 2.x는 401을 상태 코드 없이 `initialize` 실패(`MCPError -32603`)로 보고한다. 헤더를 넣고 다시 연결하면 서버 재시작 없이 붙는다(실제 소켓으로 확인).
- **team 인스턴스**: 설치된 Raven.app 번들 코드를 실행한다. #26 이전에 설치한 앱은 재설치해야 게이트가 적용된다.
- **남는 위험 (해결 주장 ❌)**:
  - 실제 원격 tailnet 기기(IPv4·IPv6) E2E는 UNKNOWN이다. 자기 Tailscale IPv4와 Docker CGNAT 망으로만 확인했다. macOS에서는 자기 utun IPv6로 자기 자신에게 접속할 수 없다.
  - loopback 무인증 신뢰는 그대로다. 같은 기기의 모든 프로세스, XFF 없는 비공식 로컬 프록시가 해당한다. MCP는 SDK의 DNS-rebinding 보호(Host 검사)도 꺼 두었으므로, DNS rebinding으로 loopback에 닿는 브라우저 페이지도 이 신뢰에 포함될 수 있다(코드상 추론, 실증 안 함).
  - 평문 HTTP에서는 같은 망에서 토큰이 보인다. tailnet 구간은 WireGuard로 암호화된다.

## 후속 후보

- loopback 요청의 Host 검사(DNS rebinding 방어)를 원격 Host 허용과 함께 다시 켜는 방안

---
title: Core API Tailnet Token
created: 2026-10-08
type: rule
tags: [rule, security, api, desktop, dashboard]
confidence: medium
status: accepted
---

# Core API Tailnet Token

> **결정:** Core API는 loopback 직접 연결만 토큰 없이 받는다. tailnet을 포함한 그 밖의 모든 출처는 `raven mcp token add`로 발급한 Bearer 토큰이 있어야 한다. 이 결정은 [[adr-2026-10-08-core-api-access-gate]]의 tailnet 무인증 신뢰를 Core API에 한해 대체한다 (Issue #24). MCP는 [[adr-2026-09-30-mcp-lan-token-auth]]를 그대로 따른다.

## 맥락

- PR #21은 tailnet 출처를 라우트 검사(`is_tailnet_peer`)로 판정해 토큰 없이 받았다. 이 검사는 요청 시점의 송신 라우트를 보는 추론이다. 수락된 연결의 WireGuard 인증을 직접 증명하지 않고, 다른 tailnet 기기에서의 실제 검증도 UNKNOWN이었다. 이 위험은 승인된 잔여 위험이었다.
- tailnet에서 Core API를 쓰는 클라이언트별 상황:
  - 모바일 앱: 이미 `apiKey`를 Bearer로 보낸다.
  - 대시보드 멀티호스트: 토큰을 보낼 방법이 없었다.
  - vite 개발 대시보드(`./raven.sh start`): 대시보드에서 401을 처리할 방법이 없었다.

## 결정

| 출처 (게이트가 판정한 실효 출처) | Core API | MCP (변경 없음) |
|---|---|---|
| loopback `127.0.0.0/8`, `::1` | 통과 | 통과 |
| tailnet (라우트 판정 통과) | **Bearer 필수** | 통과 (ADR 2026-09-30) |
| 그 외 (LAN, Docker, CGNAT, IP 아님) | Bearer 필수 | Bearer 필수 |

- **서버**: `TokenGate.trust_tailnet = False`. MCP의 `LanTokenAuth`만 `True`로 명시해 켠다. 경로 예외는 새로 만들지 않는다. 모든 HTTP 메서드와 WebSocket handshake에 같은 판정을 적용한다.
- **프록시 헤더**: launcher 모드에서 loopback peer가 보낸 XFF를 해석하는 규칙은 그대로다. 결과가 loopback일 때만 무인증이다. tailnet 브라우저가 vite를 거쳐 와도 토큰이 필요하다.
- **대시보드** (`dashboard/src/lib/host-auth.ts`, `api-base.ts`, `AuthTokenDialog`, `HostPicker`):
  - 호스트별 토큰은 **sessionStorage에만** 둔다. 창을 닫으면 지워진다. localStorage·URL·로그에는 남기지 않는다.
  - fetch 래퍼는 `/api/*` 요청에만 `Authorization`을 붙인다. 붙이는 토큰은 요청이 실제로 가는 호스트의 것이다. 상대 경로면 활성 호스트, 절대 URL이면 origin이 정확히 같은 호스트만 해당한다. 명시된 헤더는 덮지 않는다. `sendBeacon`은 헤더를 못 싣으므로, 토큰이 있으면 `fetch(keepalive)`로 보낸다.
  - 게이트 401(`WWW-Authenticate: Bearer realm="raven"`)이 오면 활성 호스트에 대해 토큰 입력창을 띄운다. 원격 호스트의 401은 cross-origin이므로, API CORS가 `WWW-Authenticate`를 노출(`expose_headers`)해야 브라우저가 이 헤더를 읽을 수 있다. 입력창이 마운트되기 전에 도착한 401도 보관했다가 연다. 토큰은 저장 전에 `/api/vaults`로 검증한다. Docker 프록시의 401(`Session realm="raven-dashboard"`)이 오면 그 프록시의 로그인 화면으로 보낸다.
  - 호스트 추가 화면에 토큰 칸을 두고, 연결 테스트도 헤더로 보낸다.
- **Docker**: `spa_server`의 서버 측 세션 모델은 그대로다. 401에 자기 realm만 표시한다.

## 결과

- **Breaking change**: tailnet에서 토큰 없이 Core API에 붙던 클라이언트는 모두 401을 받는다. 대상은 대시보드 멀티호스트, 다른 기기 브라우저, 스크립트다.
- API가 직접 서빙하는 대시보드(`http://<tailnet-IP>:8765/`)는 HTML까지 게이트를 거친다(경로 예외 없음). 그래서 원격 브라우저로는 열리지 않는다. 원격 접근은 데스크톱 앱 멀티호스트, vite 개발 대시보드, Docker 로그인 화면으로 한다.
- 토큰은 창을 닫으면 지워진다. 다시 열면 다시 입력해야 한다 (영구 저장 회피를 우선함).
- 남는 위험 (해결로 주장하지 않음):
  - loopback 프로세스 신뢰와 XFF 없는 비공식 로컬 프록시는 그대로다.
  - MCP의 tailnet 라우트 판정도 그대로다.
  - 평문 HTTP에서는 같은 망에서 토큰이 보인다. tailnet은 WireGuard로 암호화된다.
  - sessionStorage의 토큰은 같은 origin에서 스크립트가 실행되면(XSS) 읽힐 수 있다.

## 후속 후보

- MCP tailnet 토큰 필수화 (별도 결정)
- 원격 브라우저용 로그인 경로(API가 서빙하는 대시보드)

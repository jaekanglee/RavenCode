---
title: MCP LAN Token Auth
created: 2026-09-30
type: rule
tags: [rule, mcp, security, desktop]
confidence: medium
status: accepted
---

# MCP LAN Token Auth

> ⚠️ **2026-10-09 대체:** tailnet 무인증 통과와 "standalone `raven.mcp.cli`는 범위 밖"은 [[adr-2026-10-09-mcp-remote-token]]으로 대체됐다 (Issue #26). 이제 모든 MCP HTTP 리스너가 loopback만 토큰 없이 받는다. 아래 본문은 역사 보존용이다.

> **결정:** 데스크톱 앱의 MCP를 내부망(LAN)까지 연다. loopback과 tailnet 출처는 지금처럼 그대로 통과시키고, 그 밖의 출처는 vault owner가 `raven mcp token add`로 발급한 Bearer 토큰이 있어야 통과시킨다. 발급된 토큰이 없으면 내부망 요청은 전부 401이다.

## 맥락

- MCP에는 인증이 없어서, 데스크톱 앱은 MCP를 **tailnet 주소에만** 바인딩했다(`_resolve_mcp_host`). API는 0.0.0.0에 열려 있다. 앱은 admin 모드로 떠 있어서, 내부망에 그대로 열면 같은 망의 누구든 `wiki_delete`나 `wiki_rename`을 호출할 수 있다.
- 사용자는 Tailscale을 쓰지 않는 같은 내부망 기기에서도 에이전트를 붙이고 싶어 한다. 다만 **허락한 사람만** 붙어야 한다.
- 검토한 대안:
  - Tailscale share node: 코드를 바꿀 필요가 없지만 상대 기기에 Tailscale을 설치해야 한다.
  - IP 허용 목록: DHCP로 IP가 바뀌면 끊기고, 같은 망에서 IP를 흉내 내면 뚫린다.
  - 토큰 + TLS: 가장 안전하지만 인증서 배포가 무겁다.
- 사용자는 "내부망에서 탈취될 정도면 감내한다"며 평문 HTTP 위의 토큰을 택했다.

## 결정

| 출처 (소켓 주소) | 처리 |
|---|---|
| `127.0.0.0/8`, `::1` | 통과 |
| tailnet `100.64.0.0/10`, `fd7a:115c:a1e0::/48` | 통과. Tailscale이 기기를 인증한다 |
| 그 외 | `Authorization: Bearer <token>`이 맞으면 통과, 아니면 401 (`WWW-Authenticate: Bearer`) |

- **저장소** `raven/core/mcp_tokens.py`: `<VAULTS_ROOT>/.mcp-tokens.json`에 권한 0600으로 이름, SHA-256, 발급일만 저장한다. 평문은 발급할 때 한 번만 보여준다. 매 요청마다 파일을 다시 읽으므로 revoke가 재시작 없이 바로 반영된다.
- **미들웨어** `raven/mcp/auth.py::LanTokenAuth`: MCP ASGI 앱을 감싼다. 출처는 `scope["client"]`로만 판단한다.
- **CLI** `raven mcp token add|list|revoke`. 발급은 vault owner가 이 기기에서 한다.
- **바인딩**: 데스크톱 MCP는 API 주소를 따른다. 기본은 0.0.0.0이다. readiness line에는 실제로 접속할 수 있는 주소(tailnet IP, 없으면 loopback)를 싣는다. 다시 좁히려면 `RAVEN_MCP_HOST`를 쓴다.
- **적용 범위**: 데스크톱 런타임만 해당한다. standalone `raven.mcp.cli`는 기존대로 인증 없이 동작한다. team 인스턴스(`deploy/launchd/com.raven.mcp-team.plist`, 0.0.0.0:8767)와 Docker `mcp-http`(클라이언트가 게이트웨이 IP로 보인다)가 이미 내부망에 열려 있어서, 인증을 걸면 바로 401로 깨진다.

## 결과

- 토큰을 발급하기 전에는 지금과 똑같이 동작한다. 내부망 요청은 모두 401이고 tailnet 설정도 그대로 쓸 수 있다.
- 평문 HTTP라서 같은 망에서 트래픽을 엿보면 토큰이 노출된다. 사람이나 기기마다 따로 발급하고, 유출이 의심되면 revoke한다.
- 사내망처럼 LAN 대역 자체가 `100.64.0.0/10`을 쓰는 환경이면, 그 대역의 LAN 기기도 tailnet으로 간주돼 토큰 없이 통과한다. 이런 환경이면 `RAVEN_MCP_HOST`로 바인딩을 좁혀야 한다.
- MCP 앞에 reverse proxy를 두는 경우, uvicorn의 `forwarded_allow_ips`는 기본값(127.0.0.1)으로 둬야 한다. `"*"`로 두면 `X-Forwarded-For` 헤더 한 줄로 출처를 위조할 수 있다.

## 후속 후보

- Dashboard 관리 탭에 토큰 발급·회수 UI 추가
- team 인스턴스와 Docker에도 적용하는 opt-in 플래그(`--auth lan-token`)

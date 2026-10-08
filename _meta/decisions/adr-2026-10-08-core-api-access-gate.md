---
title: Core API Access Gate
created: 2026-10-08
type: rule
tags: [rule, security, api, desktop, docker]
confidence: medium
status: accepted
---

# Core API Access Gate

> **결정:** Core API 접근 게이트를 실행기가 아니라 앱(`raven.api.app`) 자체에 붙인다. loopback·tailnet 출처는 통과하고, 그 밖의 출처는 `raven mcp token add`로 발급한 Bearer 토큰이 있어야 통과한다. 프록시 헤더로는 신뢰 출처를 만들 수 없고, Docker 대역도 신뢰하지 않는다.

## 맥락

- `raven/api/`에는 인증이 없다. 그런데 vault 읽기·쓰기와 `DELETE /api/vaults/{name}?force=true`(`shutil.rmtree`)를 노출한다. 데스크톱 셸의 기본 bind가 `0.0.0.0`이어서, 같은 망의 누구든 이 API에 닿을 수 있었다 (Issue #14).
- PR #21의 1차 수정은 데스크톱 런타임에서만 앱을 `LanTokenAuth`로 감쌌다. 그래서 `python -m raven.api --host 0.0.0.0`, `RAVEN_HOST=0.0.0.0`, `uvicorn raven.api:app`에서는 원본 앱이 그대로 노출됐다.
- 재리뷰에서 두 문제가 더 나왔다.
  - uvicorn은 `forwarded_allow_ips`가 허용하면 `X-Forwarded-For`를 보고 `scope["client"]`를 *앱보다 먼저* 바꾼다. 값이 `'*'`면 LAN 기기가 `127.0.0.1`을 사칭할 수 있었다.
  - Docker 배포는 대시보드 프록시가 bridge IP로 보여 401을 받았다.
- 제품 전제는 "신뢰된 단일 사용자 네트워크(localhost 또는 본인 tailnet)"다. 근거는 README 보안 전제, deployment D5, [[adr-2026-09-30-mcp-lan-token-auth]]다. 대시보드 멀티호스트 모드는 토큰을 보내지 못한다.

## 결정

| 출처 (게이트가 판정한 실효 출처) | 처리 |
|---|---|
| loopback `127.0.0.0/8`, `::1` (IPv4-mapped 포함) | 통과 |
| tailnet `100.64.0.0/10`, `fd7a:115c:a1e0::/48` | 통과. MCP와 같은 신뢰 모델이고, 파괴적 API에도 같다 |
| 그 외 (LAN, Docker bridge·gateway, IP가 아닌 값) | Bearer 토큰 필수. 발급 0개면 전부 401. 경로 예외 없음 |

- **위치**: `raven/core/access.py::TokenGate`. `raven/api/server.py`가 CORS 안쪽에 한 번 설치한다. MCP의 `LanTokenAuth`는 이 클래스를 상속한다. 거부된 요청은 핸들러에 닿지 않는다. http와 websocket 요청 모두 검사한다.
- **프록시 헤더** (X-Forwarded-For / Forwarded / X-Real-IP):
  - strict 모드(기본): 게이트가 서버 설정을 모르는 경우다. 이런 헤더가 붙은 요청은 출처 신뢰를 받지 못한다. uvicorn은 헤더가 있을 때만 출처를 바꾸고 헤더는 요청에 남으므로, 이 규칙은 `forwarded_allow_ips` 값과 무관하게 성립한다.
  - launcher 모드: Raven 실행기(`python -m raven.api`, 데스크톱 API·MCP)가 `serve_kwargs()`로 uvicorn을 `proxy_headers=False`로 띄운다. 이때 게이트가 XFF를 직접 읽되, loopback peer가 보낸 경우만 본다. 오른쪽부터 loopback hop을 건너뛰고, 처음 나오는 주소를 출처로 삼는다. 해석할 수 없는 항목이 있거나 peer가 loopback이 아니면 신뢰하지 않는다.
  - 하위 핸들러(`_require_loopback`)는 게이트가 판정한 출처를 본다. 출처를 알 수 없으면 `"unknown"`이 된다.
- **bind**: 기본은 loopback이다. 비루프백·와일드카드 bind는 `RAVEN_ALLOW_REMOTE`가 참일 때, 또는 `--host tailscale`일 때만 허용한다.
  - standalone CLI는 opt-in 없이 요청하면 exit 2로 거부한다.
  - 데스크톱은 loopback으로 낮춘다. 셸이 항상 host를 넘기므로, 거부하면 창이 뜨지 않는다.
  - 우선순위는 `--host` > `RAVEN_HOST`다.
- **Docker**: compose가 api 서비스에 `RAVEN_ALLOW_REMOTE=1`을 명시한다. 이는 컨테이너 안 bind만 허용하는 것이고, 게이트는 그대로 적용된다. 대시보드 프록시(`scripts/spa_server.py`)는 사용자 본인의 토큰만 실어 보낸다.
  - 토큰은 Bearer 헤더로 받거나, `/__raven/login`에서 한 번 입력받아 `HttpOnly; SameSite=Strict` 쿠키로 보관한다.
  - 서비스 공용 토큰과 IP 신뢰는 없다.
  - 쿠키로 인증된 쓰기 요청은 같은 Origin일 때만 받는다.
  - 세션 쿠키와 클라이언트가 보낸 프록시 헤더는 업스트림에 전달하지 않는다.

## 결과

- 모든 공식 실행 경로(Tauri, 런타임 직접 실행, `python -m raven.api`, uvicorn 직접 실행, Docker)에서 인증 없는 원격 vault 읽기·쓰기·삭제가 401로 막힌다. 실제 소켓, 실제 vite 프록시, 실제 compose로 확인했다 (PR #21 §11·§12).
- Docker 사용자는 토큰을 한 번 발급해 대시보드에 입력해야 한다. 같은 Docker 망의 다른 컨테이너는 토큰 없이 접근할 수 없다.
- tailnet 안의 기기는 vault를 읽고 쓰고 지울 수 있다. tailnet을 남과 공유하지 말 것. LAN이 `100.64.0.0/10`을 쓰는 환경이면 그 LAN 기기도 tailnet으로 간주된다 (MCP ADR과 같은 한계).
- 이 기기의 앞단 프록시가 XFF를 붙이지 않으면 모든 요청이 loopback으로 보인다. `uvicorn raven.api:app`을 직접 띄우고 같은 기기에 프록시를 두면, 프록시를 거친 요청은 토큰이 필요하다.
- 평문 HTTP라 같은 망에서 트래픽을 엿보면 토큰이 노출된다 (사용자 수용).

## 후속 후보

- 대시보드 멀티호스트 모드에 토큰 입력 추가 (원격 Raven 서버 연결용)
- standalone `raven.mcp.cli`(team·Docker MCP)에 같은 게이트를 opt-in으로 적용
- 별도 이슈: #22 (원격 모드 포트 선택), #23 (SIGTERM 후 Core 잔존)

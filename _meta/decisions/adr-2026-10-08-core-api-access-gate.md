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
| tailnet `100.64.0.0/10`, `fd7a:115c:a1e0::/48` **이면서 응답 라우트가 이 기기의 Tailscale 주소로 나가는** 출처 | 통과. MCP와 같은 신뢰 모델이고, 파괴적 API에도 같다. 대역 소속만으로는 통과 ❌ (아래 "tailnet 판정") |
| 그 외 (LAN, Docker bridge·gateway, IP가 아닌 값) | Bearer 토큰 필수. 발급 0개면 전부 401. 경로 예외 없음 |

- **위치**: `raven/core/access.py::TokenGate`. `raven/api/server.py`가 CORS 안쪽에 한 번 설치한다. MCP의 `LanTokenAuth`는 이 클래스를 상속한다. 거부된 요청은 핸들러에 닿지 않는다. http와 websocket 요청 모두 검사한다.
- **프록시 헤더** (X-Forwarded-For / Forwarded / X-Real-IP):
  - strict 모드(기본): 게이트가 서버 설정을 모르는 경우다. 이런 헤더가 붙은 요청은 출처 신뢰를 받지 못한다. uvicorn은 헤더가 있을 때만 출처를 바꾸고 헤더는 요청에 남으므로, 이 규칙은 `forwarded_allow_ips` 값과 무관하게 성립한다.
  - launcher 모드: Raven 실행기(`python -m raven.api`, 데스크톱 API·MCP)가 `serve_kwargs()`로 uvicorn을 `proxy_headers=False`로 띄운다. 이때 게이트가 XFF를 직접 읽되, loopback peer가 보낸 경우만 본다. 오른쪽부터 loopback hop을 건너뛰고, 처음 나오는 주소를 출처로 삼는다. 해석할 수 없는 항목이 있거나 peer가 loopback이 아니면 신뢰하지 않는다.
  - 하위 핸들러(`_require_loopback`)는 게이트가 판정한 출처를 본다. 출처를 알 수 없으면 `"unknown"`이 된다.
- **tailnet 판정** (2026-10-08 감사 개정): CGNAT 대역은 통신사 LAN·다른 mesh VPN·사용자 Docker 망도 쓴다. 실제로 `100.64.200.0/24` Docker 망의 컨테이너가 토큰 없이 vault를 지울 수 있었다. 그래서 대역이 아니라 라우트로 판정한다.
  - TCP 연결은 클라이언트가 SYN-ACK를 받아야 성립한다. 커널이 그 peer로 가는 응답을 이 기기의 Tailscale 주소(tailscaled가 `tailscale ip`로 알려주는 값, 30초 캐시)에서 내보내면, SYN-ACK는 Tailscale로 들어갔고 Tailscale은 그 주소의 WireGuard 인증 노드에게만 전달한다. LAN에서 100.x를 사칭한 호스트는 연결을 끝낼 수 없다.
  - Tailscale CLI/daemon이 없거나(Docker 컨테이너 포함), 라우트 조회가 실패하거나, 응답이 다른 인터페이스로 나가면 tailnet 신뢰는 없다 (fail-closed).
  - **한계 (승인된 잔여 위험)**: 이 판정은 요청 시점의 송신 라우트를 보는 추론이다. 수락된 TCP 소켓의 수신 경로나 WireGuard 인증을 직접 증명하지 않는다. 비대칭·정책 라우팅, 네트워크 네임스페이스, 중첩 VPN, 연결 이후의 라우트 변경에서는 성립을 보장하지 않는다. 이를 악용하려면 라우팅을 바꿀 권한(사실상 호스트 관리자)이 필요하다. 다른 tailnet 기기에서의 실제 요청은 검증하지 못했다. tailnet에도 Bearer를 요구하는 작업은 #24.
  - 로컬 프록시가 붙인 XFF에서 나온 출처도 같은 검사를 받는다. 같은 기기, 같은 라우팅 표를 쓰기 때문이다.
- **bind**: 기본은 loopback이다. 비루프백·와일드카드 bind는 `RAVEN_ALLOW_REMOTE`가 참일 때, 또는 `--host tailscale`일 때만 허용한다.
  - standalone CLI는 opt-in 없이 요청하면 exit 2로 거부한다.
  - 데스크톱은 loopback으로 낮춘다. 셸이 항상 host를 넘기므로, 거부하면 창이 뜨지 않는다.
  - 우선순위는 `--host` > `RAVEN_HOST`다.
- **Docker**: compose가 api 서비스에 `RAVEN_ALLOW_REMOTE=1`을 명시한다. 이는 컨테이너 안 bind만 허용하는 것이고, 게이트는 그대로 적용된다. 대시보드 프록시(`scripts/spa_server.py`)는 사용자 본인의 토큰만 실어 보낸다.
  - 토큰은 Bearer 헤더로 받거나, `/__raven/login`에서 한 번 입력받아 `HttpOnly; SameSite=Strict` 쿠키로 보관한다.
  - 서비스 공용 토큰과 IP 신뢰는 없다.
  - 쿠키에는 API 토큰이 아니라 메모리 세션 id만 담는다. 쿠키는 포트를 구분하지 않아 같은 호스트의 다른 서비스도 받기 때문이다. 세션은 로그아웃·revoke·재시작 시 즉시 무효다.
  - 쿠키로 인증된 쓰기 요청은 같은 Origin일 때만 받는다. TLS 뒤에서는 `RAVEN_DASHBOARD_SECURE_COOKIE=1`로 Secure를 붙인다.
  - 로그인 본문은 4KB, 토큰 형식도 제한한다. 잘못된 Content-Length는 400/413으로 거부하고, API의 CORS 응답 헤더는 프록시에서 버린다.
  - 세션 쿠키와 클라이언트가 보낸 프록시 헤더는 업스트림에 전달하지 않는다.

## 결과

- 모든 공식 실행 경로(Tauri, 런타임 직접 실행, `python -m raven.api`, uvicorn 직접 실행, Docker)에서 인증 없는 원격 vault 읽기·쓰기·삭제가 401로 막힌다. 실제 소켓, 실제 vite 프록시, 실제 compose로 확인했다 (PR #21 §11·§12).
- Docker 사용자는 토큰을 한 번 발급해 대시보드에 입력해야 한다. 같은 Docker 망의 다른 컨테이너는 토큰 없이 접근할 수 없다.
- tailnet 안의 기기는 vault를 읽고 쓰고 지울 수 있다. tailnet을 남과 공유하지 말 것. LAN이 `100.64.0.0/10`을 쓰는 환경이어도, 응답이 Tailscale로 나가지 않는 한 그 LAN 기기는 tailnet으로 간주되지 않는다 (MCP ADR의 한계를 이 개정으로 해소).
- **구조적 한계 — XFF 없는 로컬 프록시**: 이 기기에서 도는 프록시가 XFF 없이 API를 LAN에 중계하면, 그 요청은 소켓·헤더 어느 수준에서도 Tauri webview나 로컬 대시보드의 직접 loopback 접속과 구분할 수 없다. 그래서 인증 없이 통과한다(파괴적 API 포함, 2026-10-08 실제 재현). loopback을 토큰 없이 신뢰하는 한 기술적으로 막을 수 없다.
  - 지원하는 프록시는 vite `xfwd: true`, Docker `spa_server`(자체 로그인 + XFF), 문서의 Caddy → dashboard다. 이 밖의 프록시로 API를 노출하는 구성은 지원하지 않는다.
  - 막으려면 loopback에도 토큰을 요구하는 정책 변경이 필요하다. 이 경우 Tauri는 기동 시 발급한 토큰을, vite·raven.sh는 별도 경로를 써야 한다.
  - **2026-10-08 사용자 승인**: loopback 프로세스 신뢰와 XFF 없는 비공식 로컬 프록시는 승인된 잔여 위험이다. 공식 지원 프록시는 위 3종으로 한정한다.
- `uvicorn raven.api:app`을 직접 띄우고 같은 기기에 프록시를 두면, 프록시를 거친 요청은 토큰이 필요하다 (strict 모드).
- Linux Docker + Tailscale VPS에서 tailnet 클라이언트가 API 컨테이너에 바로 붙던 경로는 이제 토큰이 필요하다. 컨테이너 안에서는 tailnet을 입증할 수 없다.
- 평문 HTTP라 같은 망에서 트래픽을 엿보면 토큰이 노출된다 (사용자 수용).

## 후속 후보

- 대시보드 멀티호스트 모드에 토큰 입력 추가 (원격 Raven 서버 연결용)
- standalone `raven.mcp.cli`(team·Docker MCP)에 같은 게이트를 opt-in으로 적용
- #24: tailnet Core API 접근에도 Bearer 토큰 필수화 + 대시보드 멀티호스트 토큰 지원
- 별도 이슈: #22 (원격 모드 포트 선택), #23 (SIGTERM 후 Core 잔존)

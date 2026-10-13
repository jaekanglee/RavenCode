---
title: Core API·MCP는 같은 PC(loopback)에도 토큰을 요구한다
type: decision
tags: [security, access, mcp, api, desktop, docker]
---

# Core API·MCP는 같은 PC(loopback)에도 토큰을 요구한다

**결정**: Core API(`TokenGate`)와 MCP(`LanTokenAuth`)는 출처와 무관하게 모든 요청에 Bearer 토큰을 요구한다. 같은 PC(loopback)도 예외가 아니다. 토큰 없이 열리는 것은 `GET /healthz`(고정 본문)와 Core API가 서빙하는 대시보드 정적 파일뿐이다. 데스크톱 앱 webview는 셸이 실행마다 만드는 세션 자격 증명으로 인증한다 (Issue #67). 이 결정은 [[adr-2026-10-12-loopback-browser-context]]를 대체하고, [[adr-2026-10-08-core-api-access-gate]]·[[adr-2026-10-08-core-api-tailnet-token]]·[[adr-2026-10-09-mcp-remote-token]]의 "loopback은 토큰 없이 통과"를 대체한다.

## 맥락

- macOS Docker Desktop은 컨테이너의 `host.docker.internal` 연결을 호스트 loopback으로 넘긴다. Raven에는 peer `127.0.0.1`로 보이고, Host·Origin은 컨테이너가 정한다.
- 실측(2026-10-12~13, 격리 포트, 실제 `curlimages/curl` 컨테이너): `Host: 127.0.0.1:<port>`만 붙이면 Core `/api/vaults`와 MCP `initialize`가 토큰 없이 200이었다. 잘못된 토큰을 보내도 200이었다(loopback 통과가 토큰 검사보다 먼저).
- 소켓 주소와 헤더로는 같은 PC의 프로세스와 컨테이너를 구분할 수 없다. 반대편 소켓의 소유 프로세스(`com.docker.backend`)를 찾는 방법은 있지만, OrbStack·Colima·Podman 등 다른 forwarder를 다 알 수 없고 운영체제별 구현과 TOCTOU가 남는다 — 보조 방어일 뿐 판정 근거가 될 수 없다.
- PR #69(`RAVEN_REQUIRE_LOOPBACK_TOKEN`, opt-in)는 경로를 막았지만 기본 설치는 열려 있었다. 데스크톱 앱은 매번 토큰을 붙여 넣어야 했고, Finder로 연 앱에는 환경 변수가 닿지 않았고, compose healthcheck가 깨졌다.

## 결정 내용

### 게이트 (`raven/core/access.py`)

- 모든 출처: 유효한 `Authorization: Bearer <token>` — `raven mcp token add`로 발급한 토큰, 또는(Core API에서만) 데스크톱 세션 자격 증명. 그 밖에는 401. WebSocket은 close 1008. URL query의 토큰은 읽지 않는다. 잘못되거나 회수된 토큰은 401.
- 예외 1 — `GET /healthz`: 게이트가 직접 `200 {"ok":true}`로 답한다. 앱 코드에 닿지 않고 vault·토큰·네트워크 정보를 주지 않는다. 정확히 그 경로·메서드만(`/healthz/`, `POST`, `/api/healthz`는 401).
- 예외 2 — 대시보드 정적 파일(Core API만, `raven/api/server.py::_is_public_static`): 대시보드 빌드를 서빙하는 프로세스에서 `GET`/`HEAD`이고 경로가 `/api`·`/api/...`·API 문서(`/docs`, `/redoc`, `/openapi.json`, OAuth redirect)가 아닐 때. 판정은 라우터가 쓰는 디코딩된 경로로 해서 `%61pi`·`api%2F` 같은 표기도 같은 쪽에 떨어진다. 경로 예외(`/healthz`, 정적 파일)는 라우터가 매칭하는 경로(`root_path`를 뗀 경로 — `access.route_path`)로 판정한다(그렇지 않으면 `--root-path`로 띄웠을 때 `/api`가 정적 경로로 오판된다 — 리뷰 BLOCKER). SPA fallback은 빌드 폴더 밖 파일을 서빙하지 않는다(`..`, `//etc/passwd` 같은 절대 경로 — 정적 경로가 무인증이 되면서 막아야 했던 경로 탈출).
- 출처(`effective_client`)는 판정에 쓰지 않는다. 통과한 요청의 `scope["client"]` 재작성(#15 이 PC 전용 API)과 401 안내 문구(같은 PC / 원격 / 출처 미상)에만 쓴다.
- `RAVEN_REQUIRE_LOOPBACK_TOKEN`(PR #69)은 기본 동작이 되어 없앴다. 인증을 약하게 하는 설정은 남기지 않는다.

### 데스크톱 webview — 세 후보 비교

| 후보 | 내용 | 판단 |
|---|---|---|
| A. Rust 셸 인증 중개 | webview의 모든 API 호출을 Tauri IPC로 셸에 보내고 셸이 토큰을 붙인다 | webview가 토큰을 몰라도 되지만, 대시보드의 fetch 계층 전체(스트리밍·다운로드·Request 객체)를 IPC로 옮겨야 한다. 악성 콘텐츠가 IPC를 부르면 결국 같은 권한을 얻는다 — 비용 대비 이득이 작다 |
| B. 셸이 관리하는 로컬 인증 프록시 | 셸이 loopback 프록시를 열고 거기서 토큰을 붙인다 | 프록시 자신이 인증 없는 loopback 리스너가 되어 #67을 그대로 다시 만든다. 기각 |
| **C. 실행별 세션 자격 증명** | 셸이 앱 실행마다 비밀을 하나 만들어 Core에는 stdin으로, webview에는 IPC(`core_session_token`)로 준다 | **채택.** 기존 대시보드 fetch 경로를 그대로 쓴다. Core·MCP에 인증 예외가 필요 없다 |

C의 경계:

- 생성: Unix는 `/dev/urandom` 32바이트, 없으면(Windows) OS RNG로 시드된 `RandomState` SipHash로 대신한다(신규 의존성 없음). `rvs_` + 64 hex.
- 전달: Core에는 stdin 한 줄 뒤 EOF(`RAVEN_DESKTOP_SESSION_STDIN=1`일 때만 읽는다). argv·환경 변수·파일·로그·readiness 줄·URL에는 넣지 않는다. Core는 SHA-256만 메모리에 둔다.
- 범위: Core API만(MCP는 받지 않는다), 같은 PC(loopback 실효 출처)에서만 — vite가 LAN 브라우저를 중계하면 받지 않는다.
- 수명: 앱 실행 동안. Core 재시작·포트 이동 때 셸이 같은 값을 다시 넘기고, webview는 리로드 때 IPC로 다시 받는다. 앱을 끄면 사라진다. `raven mcp token revoke`는 발급 토큰만 회수한다 — 세션 자격 증명은 앱을 끄면 끝난다.
- webview 보관: 메모리에만(sessionStorage·localStorage 아님). `dashboard/src/lib/host-auth.ts`가 데스크톱 Core의 정확한 origin에만 붙인다. 거절되면 지우고 토큰 입력창으로 넘어간다.
- 한계: webview에서 스크립트가 실행되면(XSS) IPC로 값을 얻어 앱이 켜져 있는 동안 같은 PC에서 Core API를 쓸 수 있다. webview에서 스크립트가 돌면 어차피 같은 Core를 호출할 수 있으므로 새 권한은 아니다. #17의 HTML 정화·CSP(`script-src 'self'`)가 1차 방어다. IPC는 앱 자기 창(`capabilities/default.json`의 `main`)에만 열려 있다.

### vite 개발 대시보드

vite 프록시는 토큰을 대신 붙이지 않는다. 붙이면 vite에 닿는 모든 클라이언트 — tailnet 기기, `host.docker.internal`로 오는 컨테이너 — 가 인증된 셈이 된다. vite에서는 같은 PC에서도 첫 401에서 토큰 입력창이 뜨고, 사용자가 발급 토큰을 넣는다(탭의 sessionStorage, 기존 #24 흐름). 자동 인증을 안전하게 할 수 없는 실행 방식이므로 명시적 입력을 요구한다.

### Docker compose healthcheck

API·MCP 모두 `curl -fsS http://127.0.0.1:<port>/healthz`. `-f`로 401/403/500을 실패로 친다(예전 MCP 검사는 `-f`가 없어 401도 정상이었다). healthcheck 성공은 "서버가 요청을 받는다"이고 인증된 API 접근과는 별개다.

## 결과·잔여 위험

- **호환성 변경**: 토큰 없이 같은 PC에서 `/api`·MCP를 부르던 클라이언트(로컬 MCP 클라이언트, curl·스크립트, vite 대시보드)는 토큰이 필요하다. 데스크톱 앱 webview, Docker 대시보드(`spa_server` 로그인), 토큰을 이미 쓰던 원격 클라이언트는 그대로다.
- 토큰을 가진 macOS Docker Desktop 컨테이너는 같은 PC로 보이므로 #15의 이 PC 전용 API도 쓸 수 있다. 토큰이 없으면 아무것도 못 한다.
- 같은 PC에서 같은 사용자로 도는 프로세스는 webview 메모리나 Core 프로세스를 들여다볼 수 있다 — 운영체제 사용자 경계 안의 일이라 범위 밖이다.
- Windows·Linux webview에서의 실측과 OrbStack·Colima·Podman forwarding 실측은 UNKNOWN.

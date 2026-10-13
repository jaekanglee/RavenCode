---
title: Docker Desktop loopback 토큰 우회 — 강화 모드와 남은 작업
type: issue
status: open
created: 2026-10-13
tags: [security, access, docker, mcp, api]
source: 2026-10-12 운영 배포 전 감사에서 발견 (GitHub #67), PR #69
aliases: [issue-67-loopback-token-mode]
---

# Docker Desktop loopback 토큰 우회

macOS Docker Desktop은 컨테이너의 `host.docker.internal` 연결을 호스트 loopback으로 넘긴다. Core API와 MCP에는 그 연결이 `127.0.0.1`에서 온 것으로 보인다. 컨테이너가 `Host: 127.0.0.1:<port>`를 보내면 #28의 토큰 없는 loopback 통과를 받는다 — Host/Origin은 컨테이너가 정하는 값이고, 소켓 주소로는 같은 PC의 프로세스와 구분할 수 없다. 실측(master `ffe72d2`): Core·MCP 모두 토큰 없이 200, 잘못된 토큰을 보내도 200.

## 강화 모드 (PR #69, opt-in)

`RAVEN_REQUIRE_LOOPBACK_TOKEN`을 Core API와 MCP HTTP **프로세스 환경**에 넣고 재시작한다. 참값은 `1`·`true`·`yes`·`on`(대소문자·앞뒤 공백 무시). 그 밖의 값이나 미설정이면 기존 기본값 그대로다.

켜지면 공용 `TokenGate`가 loopback을 포함한 모든 HTTP·WebSocket 요청에 유효한 `Authorization: Bearer <token>`을 요구한다(WebSocket은 close 1008). 토큰은 `raven mcp token add|revoke`로 다룬다. 잘못되거나 회수된 토큰, URL query의 토큰은 거부된다.

실행 경로별로 변수가 닿는지:

- `./raven.sh start` — `.env`를 읽으므로 한 줄로 API·MCP 둘 다 적용
- 셸에서 직접 실행한 `python -m raven.api`, `raven.mcp.cli`, 데스크톱 바이너리 — 물려받음
- **Finder·Dock으로 연 Raven.app — 적용 안 됨.** macOS GUI 앱은 셸이 아니라 launchd 환경을 받는다. `launchctl setenv RAVEN_REQUIRE_LOOPBACK_TOKEN 1`(전역, 재부팅 시 사라짐)이나 터미널 실행이 필요하다. 다른 설정 경로는 없다.
- Docker compose — 서비스 `environment`에 추가해야 전달된다

## 강화 모드에서 클라이언트 (PR #69 검증 실측)

- 대시보드(vite·데스크톱 webview): 첫 `/api` 요청이 401 + `WWW-Authenticate: Bearer`를 받고 토큰 입력 창이 열린다. 입력 후에는 모든 요청에 토큰이 붙는다. 토큰은 탭의 sessionStorage에만 있어 **창·앱을 열 때마다 다시 입력**해야 한다.
- 데스크톱 readiness는 그대로 동작한다(식별 probe가 게이트 바깥에서 응답).
- Docker compose healthcheck는 토큰을 보내지 않는다 — API 검사(`curl -f /api/vaults`)는 실패하고, MCP 검사(`curl /mcp`, `-f` 없음)는 401도 정상으로 친다.
- 토큰 없이 API를 부르는 로컬 스크립트 `scripts/restart-all.sh`(헬스체크 `/api/vaults`), `scripts/smoke-desktop.sh`는 실패로 보고한다.
- Core가 서빙하는 정적 페이지도 토큰이 필요해진다(브라우저 탐색은 헤더를 못 붙인다).

## 이것만으로 #67이 닫히지 않는 이유

기본값이 그대로라 기본 설치는 여전히 Docker Desktop 경로에 열려 있다. 닫으려면 first-party 클라이언트(데스크톱 셸, healthcheck, 스크립트)가 수동 입력 없이 인증하고, 정적 페이지를 API와 분리한 다음, loopback에도 토큰을 요구하는 쪽으로 기본값을 바꿔야 한다.

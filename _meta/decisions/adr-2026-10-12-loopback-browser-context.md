---
title: 토큰 없는 loopback 통과에 loopback Host·Origin 요구
type: decision
tags: [security, access, mcp, api]
---

# 토큰 없는 loopback 통과에 loopback Host·Origin 요구

**결정**: Core API(`TokenGate`)와 MCP(`LanTokenAuth`)는 토큰 없이 loopback 출처를 통과시킬 때, Host가 loopback 이름이고 Origin이 없거나 이 PC의 페이지일 것을 추가로 요구한다. Bearer 토큰 요청과 원격 출처 판정은 바뀌지 않는다 (Issue #28).

## 맥락

- loopback 무인증은 "이 PC의 프로그램과 이 PC가 서빙하는 대시보드"를 위한 신뢰다([[adr-2026-10-08-core-api-access-gate]], [[adr-2026-10-09-mcp-remote-token]]).
- 브라우저는 다른 사이트의 페이지를 위해서도 loopback 소켓으로 요청을 보낸다. 소켓 주소만 보는 게이트는 이 둘을 구분하지 못했다.
  - 다른 origin의 페이지: CORS가 응답 읽기를 막아도 단순 요청(`text/plain` POST 등)은 실행된다. Core API의 CORS 정규식은 사설망·tailnet origin을 허용하므로 그런 origin의 페이지는 응답도 읽는다.
  - DNS rebinding: 사이트 이름이 127.0.0.1로 해석되면 브라우저는 같은 origin으로 보고 CORS를 적용하지 않는다. 요청의 Host에는 그 사이트 이름이 남는다.
- MCP SDK의 DNS rebinding 보호는 tailnet·LAN 원격 클라이언트의 Host 때문에 꺼져 있다(v0.7.148).
- 실측 (2026-10-12, 격리 포트·임시 vault):
  - 수정 전 Core API·standalone MCP는 Host `evil.example`, Origin `https://evil.example` 요청을 토큰 없이 200으로 받았다.
  - 실제 Chrome 155(headless, 임시 프로필)에서, LAN IP origin의 페이지가 `http://127.0.0.1:<port>/api/vaults` 응답을 읽었고 `text/plain` POST로 서버에 기록했다. 이 실행에서 Chrome의 Local Network Access는 막지 않았다.
  - 실제 DNS rebinding 공격(제어하는 DNS 필요)은 재현하지 않았다 — 서버가 받는 조건(낯선 Host)만 재현했다.

## 결정 내용

- `raven/core/access.py::is_local_browser_context` — 토큰 없는 loopback 요청이 통과하려면:
  - Host가 없거나 loopback 이름이다: `localhost`(끝 점 허용), `127.0.0.0/8`, `[::1]`, 포트 무관. 형식이 틀리거나 Host가 여러 개면 거부.
  - Origin이 없거나 loopback 페이지(`http(s)://localhost|127.x|[::1][:port]`)이거나 데스크톱 webview(`tauri://localhost`, `http(s)://tauri.localhost`)다. `null`, 경로·userinfo가 붙은 값, Origin 여러 개는 거부.
- 조건을 못 맞추면 토큰을 요구한다(401, 사유를 적은 detail). 유효한 Bearer가 있으면 Host·Origin을 보지 않는다 — Docker `spa_server`(Host를 `api:8765`로 바꿈), tailnet·LAN 원격 클라이언트가 그대로 동작한다.
- websocket도 같다(1008로 닫음).
- MCP SDK 보호는 계속 끈다. 같은 판정을 게이트가 원격 Bearer와 분리해서 한다.
- Core API CORS 정규식은 그대로 둔다. 토큰을 가진 원격 대시보드에 필요하고, 토큰 없는 요청은 이제 게이트가 막는다.

## 호환성

| 사용처 | Host / Origin | 결과 |
|---|---|---|
| CLI·스크립트·`curl` | `127.0.0.1`·`localhost` / 없음 | 통과 |
| 로컬 MCP 클라이언트 | `127.0.0.1:8766`·`localhost:8766` / 없음 | 통과 |
| vite 대시보드(`changeOrigin`, `xfwd`) | `127.0.0.1:8765` / `http://127.0.0.1:5173`·`http://localhost:5173` | 통과 (실측) |
| 데스크톱 webview | `127.0.0.1:<port>` / `tauri://localhost`·`http(s)://tauri.localhost` | 통과 |
| Docker `spa_server`, 원격 Bearer 클라이언트 | 임의 / 임의 | Bearer로 통과 |
| 다른 사이트의 페이지, 낯선 Host | | 토큰 필요 |

## 결과·잔여 위험

- 토큰 없이 이 PC의 API·MCP를 쓰는 브라우저 페이지는 loopback 페이지와 데스크톱 webview뿐이다.
- 브라우저가 Origin을 보내지 않는 요청(일부 GET 탐색 등)은 Host 검사에만 기댄다. DNS rebinding은 Host에 사이트 이름이 남아 막히고, 다른 origin의 일반 탐색(링크 클릭 등)은 응답을 읽을 수 없다.
- loopback 이름으로 서빙되는 다른 로컬 웹 앱(같은 PC의 `http://localhost:3000` 등)의 페이지는 여전히 토큰 없이 호출할 수 있다 — loopback 프로세스 신뢰와 같은 부류의 승인된 잔여 위험이다.
- 실제 브라우저에서의 DNS rebinding 재현과, 수정 후 브라우저 실측은 UNKNOWN(headless Chrome이 두 번째 실행부터 페이지를 열지 못함). 수정 후 동작은 브라우저가 보내는 것과 같은 Host/Origin 헤더로 HTTP 수준에서 검증했다.

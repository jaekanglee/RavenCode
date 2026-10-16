---
title: 내부망 손님은 입장 요청과 운영자 승인으로 들어오고, 기기·IP에 묶인 vault별 권한만 받는다
type: decision
tags: [security, access, api, dashboard, desktop]
---

# 내부망 손님은 입장 요청과 운영자 승인으로 들어오고, 기기·IP에 묶인 vault별 권한만 받는다

**결정**: Core API에 세 번째 자격 증명인 손님 토큰(`rvg_`)을 둔다. 손님은 대시보드에서 토큰 없이 입장을 요청하고, 운영자가 데스크톱 앱에서 승인하면 그 브라우저가 상태 조회로 토큰을 한 번 받아 간다. 토큰은 승인 때 기록한 기기 ID(`X-Raven-Device`)와 출처 IP가 모두 맞을 때만 통하고, vault별 `read`/`create`/`update` 권한과 기간(7일·30일·무기한)이 붙는다. 삭제와 관리 작업은 운영자만 한다. MCP는 손님 토큰을 받지 않는다. [[adr-2026-10-13-loopback-token-required]]의 "모든 출처에 토큰"은 그대로이고, 토큰 종류 하나와 공개 API 두 개를 더한다.

## 맥락

- 데스크톱 앱을 내부망에 열면(`RAVEN_DESKTOP_HOST=0.0.0.0` + `RAVEN_ALLOW_REMOTE=1`) 모든 요청에 `raven mcp token add` 토큰이 필요하다. 이 토큰은 전체 권한이고 평문을 손으로 전달해야 한다. 동료에게 페이지 링크 하나를 공유하기엔 무겁고 넓다.
- IP 화이트리스트만으로는 부족하다. 사내 DHCP 주소는 바뀌고, 바뀐 주소를 다른 사람이 이어받는다. Raven은 출처 주소를 판정 근거로 쓰지 않기로 이미 정했다([[adr-2026-10-13-loopback-token-required]]).
- 사용자 결정(2026-10-16): 기기 + IP 바인딩, 승인 시 토큰 자동 전달, vault별 권한 분리, 삭제는 운영자만, 승인 시 기간 선택, 대시보드에 배지 + macOS 알림.

## 결정 내용

### 자격 증명 세 종류

| 토큰 | 발급 | 권한 | 통하는 곳 |
|---|---|---|---|
| 세션 (`rvs_`) | 데스크톱 셸, 실행마다 | 전체 | Core API, loopback 출처만 |
| 발급 (`rvn_`) | `raven mcp token add` | 전체 | Core API, MCP |
| 손님 (`rvg_`) | 입장 요청 승인 | vault별 read/create/update | Core API만 |

### 흐름

1. `POST /api/guest/requests {name, device_id}` (공개) → `request_id`, `claim_secret`, 확인 코드. Core가 셸에 `guest_request` 이벤트를 보낸다.
2. 운영자: 관리 탭 → 손님 입장에서 확인 코드를 동료 화면과 대조하고 vault별 권한·기간을 골라 승인.
3. `GET /api/guest/requests/{id}` (공개, `X-Raven-Claim` + `X-Raven-Device`, 요청 때와 같은 IP) → 승인 후 첫 조회에서만 토큰. 나머지는 404로 요청의 존재도 드러내지 않는다.
4. 손님 브라우저는 토큰을 localStorage에 두고(창을 닫아도 다시 들어오도록) 모든 요청에 `X-Raven-Device`를 붙인다.

입장 요청은 메모리에만 있다(10분 만료, IP당 1분 3건, 대기 20건). 승인됐는데 10분 안에 받아 가지 않으면 grant도 지운다. grant는 `<VAULTS_ROOT>/.guest-grants.json`(0600)에 해시만 둔다. 같은 기기를 다시 승인하면 이전 grant를 교체한다. 파일이 깨지면 모든 손님을 거부한다.

### 판정 (`raven/core/access.py::TokenGate` 손님 훅 → `raven/api/guest_routes.py`)

- grant 없음 → 401 `revoked`, 만료 → `expired`, 기기 불일치 → `device_mismatch`, IP 불일치·판정 불가 → `ip_changed`. 401 본문의 `reason`으로 대시보드가 이유를 보여 주고 다시 요청하게 한다.
- `ROUTES` 표가 Core API의 **모든** 라우트를 `(method, 경로 템플릿)`으로 분류한다. 표에 없으면 운영자 전용. 등록된 라우트가 전부 분류됐는지 테스트가 확인한다(`test_every_route_is_classified`). 모든 `DELETE`는 운영자 전용이다.
- 판정은 Starlette 라우터의 `route.matches`로 한다. FastAPI 0.139의 `include_router`는 라우트를 묶음 하나로 넣어 경로 템플릿을 감추므로, 손님 API는 `add_api_route`로 앱에 직접 등록한다(`guest_api.install`).
- `GET /api/vaults`는 손님에게 허용된 vault만 돌려준다. 응답을 거르는 곳은 여기 하나다.

### 작성자 기록

페이지 생성·수정·피드백 API는 `actor`를 넘기지 않는다. `actor`를 넘기면 allowlist·strict schema·frontmatter `agents:`가 손님에게만 걸리므로, `contracts.write_page`에 로그 전용 `log_actor`를 더해 `log.md`에 `actor=guest:<이름>`만 남긴다. 피드백 줄 작성자와 관계 추가의 `actor`는 서버가 `guest:<이름>`으로 덮어쓴다.

### 알림

셸에 `tauri-plugin-notification`을 더해 macOS 알림을 띄운다. 이 플러그인은 데스크톱에서 클릭 액션을 지원하지 않아, 알림 문구가 "관리 탭의 손님 입장에서 승인하세요"라고 안내한다. 화면을 알림이 강제로 옮기지 않는다.

## 결과

- 동료는 링크를 열고 이름만 적으면 들어올 수 있다. 운영자는 토큰 평문을 보지 않는다.
- 권한이 vault와 동작 단위로 좁아지고, 기기·IP·기간 중 하나라도 바뀌면 다시 승인해야 한다.
- 새 진입점이 아니다. 기존 HTTP API·Dashboard 안의 접근 제어다.
- 손님 토큰을 가로채도 같은 기기 ID와 IP 없이는 쓸 수 없다. 기기 ID는 비밀이 아니므로(브라우저 저장소) 이 결합은 방어를 겹치는 것이지 증명이 아니다 — 같은 IP를 쓰는 기기에서 저장소째 복사되면 막지 못한다. 이 범위는 운영자가 승인할 때 확인 코드 대조와 짧은 기간 선택으로 줄인다.

## 범위 밖

권한 수정 API(내보내고 다시 승인), 손님의 MCP 접근, 손님 삭제 권한, 대기 요청 영속화, 내부망 바인딩 자동 설정.

## 관련

- [[adr-2026-10-13-loopback-token-required]]
- 설계: `docs/superpowers/specs/2026-10-16-guest-access-design.md`

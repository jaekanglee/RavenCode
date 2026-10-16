# Raven Changelog — v0.7.183

## 1. 개요

내부망 동료에게 대시보드 링크를 주면 "커넥션 리퓨즈"였다. 데스크톱 Core는 기본이 loopback이고, 내부망에 열어도 모든 요청이 전체 권한 토큰(`raven mcp token add`)을 요구해 평문을 손으로 넘겨야 했다. 이번 버전은 그 사이에 **손님 입장**을 둔다 — 동료가 입장을 요청하고, 운영자가 승인하면 그 기기·IP에 묶인 vault별 권한 토큰이 자동으로 전달된다.

결정: `_meta/decisions/adr-2026-10-16-guest-access-pairing.md`. 설계: `docs/superpowers/specs/2026-10-16-guest-access-design.md`.

진입점 변경 없음(기존 HTTP API·Dashboard 안의 접근 제어). vault 데이터 write 없음. 의존성 추가: 데스크톱 셸 `tauri-plugin-notification` (사용자 승인, 2026-10-16).

## 2. 흐름

1. 동료가 링크를 연다 → 토큰이 없어 401 → 대시보드가 "입장 요청" 화면(같은 호스트일 때. 원격 호스트는 기존 토큰 입력부터).
2. 이름을 적어 요청 → 확인 코드(예: `K7-3F`). 데스크톱 앱에 macOS 알림, 관리 탭·더보기에 대기 건수 배지.
3. 운영자가 관리 → 손님 입장에서 코드를 대조하고 vault별 읽기/작성/수정 + 기간(7일·30일·무기한)을 골라 승인.
4. 동료 화면이 2초 폴링으로 토큰을 한 번 받아 저장하고 원래 URL로 들어간다.

## 3. 권한 판정

| 손님 토큰 `rvg_` | |
|---|---|
| 묶이는 것 | 기기 ID(`X-Raven-Device`, 브라우저가 만든 값) + 출처 IP + 만료 |
| 거부 이유 (401 `reason`) | `revoked` / `expired` / `device_mismatch` / `ip_changed` → 대시보드가 이유를 보여 주고 다시 요청 |
| 권한 | vault별 `read` / `create` / `update`. 작성·수정은 읽기를 포함 |
| 운영자 전용 | 모든 `DELETE`, vault·백업·빌드·git·policy/raw/log 쓰기·초안 생성·발행 등 관리 작업, 운영자용 `/api/guest/*` |
| MCP | 받지 않는다 (MCP 게이트에 손님 훅 없음) |

- `raven/api/guest_routes.py::ROUTES`가 Core API의 모든 라우트를 분류한다. 표에 없으면 운영자 전용이고, 분류가 빠진 라우트는 테스트가 잡는다. **새 API를 추가하면 여기에 분류할 것** (AGENTS.md §2).
- FastAPI 0.139의 `include_router`는 라우트를 묶음 하나로 넣어 경로 템플릿을 감춘다 → 손님 API는 `add_api_route`로 직접 등록(`guest_api.install`).
- `GET /api/vaults`는 손님에게 허용된 vault만 돌려준다.
- 손님 쓰기는 `log.md`에 `actor=guest:<이름>` (`contracts.write_page`의 로그 전용 `log_actor`). 피드백 줄·관계 추가의 작성자도 서버가 `guest:<이름>`으로 덮어쓴다.

## 4. 저장

- 승인된 기기: `<VAULTS_ROOT>/.guest-grants.json` (0600, 토큰 해시만, 매 요청 재로드 — 내보내기가 재시작 없이 반영). 깨지면 모든 손님 거부.
- 입장 요청: 메모리만 (10분 만료, IP당 1분 3건, 대기 20건). 승인 후 10분 안에 안 가져가면 grant 삭제.
- 브라우저: 손님 토큰은 localStorage(창을 닫아도 다시 입장), 운영자 토큰은 지금처럼 sessionStorage.

## 5. 알림의 한계

`tauri-plugin-notification`은 데스크톱에서 클릭 액션을 지원하지 않는다. 알림 문구가 "관리 탭의 손님 입장에서 승인하세요"라고 안내하고, 보던 화면을 강제로 옮기지 않는다.

## 6. 검증

- pytest: 신규 `test_guest_access_store.py` 37 · `test_guest_gate.py` 16. 전체 3248 passed / 3 failed — 실패 3건(`test_only_get_healthz_exactly_is_public`)은 이번 변경 이전 master에서도 동일(로컬 `dashboard/dist`가 있으면 비-API GET이 정적 공개 경로로 열린다).
- vitest: 신규 `GuestAccess.test.tsx` 13, 전체 646 passed. 같은 호스트의 인증 요구가 입장 요청 화면부터 뜨도록 바뀌어 기존 3개 테스트를 그 흐름에 맞췄다.
- cargo test: 105 passed (`guest_request` 이벤트 파싱·알림 문구).
- 실서버 E2E (`10.10.80.38:18799`, 임시 vault): 요청 → 승인 → 1회 수령, 손님 vault 목록 필터, 권한 밖 403, 다른 기기·IP 401.

## 7. 데스크톱 앱의 내부망 공개 스위치

손님 입장을 쓰려면 API가 내부망에 열려 있어야 하는데, 그 방법이 `launchctl setenv RAVEN_DESKTOP_HOST=0.0.0.0` + `RAVEN_ALLOW_REMOTE=1`뿐이었다(Finder로 연 앱은 셸 환경변수를 못 받고, 재부팅하면 사라진다). 관리 화면에 **내부망 공개** 스위치를 둔다. 설계: `docs/superpowers/specs/2026-10-16-desktop-lan-toggle-design.md`.

- 셸이 `<app_config_dir>/desktop-settings.json`의 `lan_access`를 기억한다. 없거나 깨지면 꺼짐(이 PC 전용).
- 켜면 Core를 `0.0.0.0` + `RAVEN_ALLOW_REMOTE=1`로 재시작한다. **MCP는 loopback 유지**(`RAVEN_MCP_HOST=127.0.0.1`) — 스위치는 대시보드 공유용이다. 사용자가 정한 `RAVEN_MCP_HOST`는 그대로 따른다.
- `RAVEN_DESKTOP_HOST`·`RAVEN_HOST`가 있으면 그 값이 이기고 스위치는 "환경변수로 고정됨"으로 비활성.
- 켜져 있으면 동료에게 줄 주소(`lan_api`)를 복사 버튼과 함께 보여 준다.
- 셸 명령 `lan_access_status` / `set_lan_access` (권한 2종 추가). 저장에 실패하면 재시작하지 않는다.
- 검증: cargo test 110 (바인딩 결정·설정 파일 왕복·명령 등록), vitest `LanAccessPanel.test.tsx` 5, 전체 664 통과.

## 8. 다음

- 데스크톱 앱 릴리스(알림·스위치 포함). 관리 → 내부망 공개를 켜면 동료가 링크로 입장을 요청할 수 있다.
- 권한 수정 API, 손님별 마지막 활동 상세는 필요해지면.

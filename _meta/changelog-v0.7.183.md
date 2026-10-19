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

## 8. 핫픽스 — 내부망 공개 패널의 무한 루프 (데스크톱 메모리 36GB)

데스크톱 v0.3.9에서 관리 화면을 열면 내부망 공개 패널이 셸 IPC(`lan_access_status`)와 `/api/system/info` 요청을 끝없이 반복했다. 실측(2026-10-19, 앱 가동 23분): WebKit Networking 28GB + WebContent 8GB. 두 프로세스의 heap에 대기 중인 fetch와 CORS 프리플라이트가 약 65만 5천 건씩 남아 있었다. 통합 로그로 보면 관리 화면에 들어간 직후 "IPC 1번 + HTTP 1번" 짝이 초당 약 1,000회씩 나갔다. WebKit의 요청 타임아웃이 7일이라 멈춘 요청이 해제되지 않았고, 창을 닫아도(숨기기) 계속 돌았다.

- 원인: `tauriInvoke()`가 부를 때마다 새 함수를 만든다. 그래서 `call` → `refresh`(useCallback) → `useEffect([refresh])`가 렌더마다 다시 실행됐다. IPC 결과는 매번 새 객체라 `setStatus`가 렌더를 일으키고, 이것이 끝없이 반복됐다. 기존 테스트는 모두 `invoke`를 prop(고정된 함수)으로 주입해서 실제 경로를 타지 않았다.
- 수정: `call`을 `useMemo(() => invoke ?? tauriInvoke(), [invoke])`로 고정 (`dashboard/src/components/LanAccessPanel.tsx`).
- 회귀 가드: invoke prop 없이 `__TAURI_INTERNALS__`로 렌더해 IPC와 fetch가 각 1회인지 확인한다. 수정 전에는 100ms 동안 IPC 322회로 실패했다.
- 검증: vitest 전체 664 passed / 1 skipped, `make typecheck` 통과.
- 이미 v0.3.9를 쓰는 사용자: 앱을 완전히 종료(트레이 → 종료)하면 메모리가 회수된다. 수정본은 데스크톱 v0.3.10으로 배포한다.

## 9. 데스크톱 Core 헬스체크·자동 복구·원인 로그

"며칠 지나면 Claude가 Raven MCP가 꺼져 있다는데 관리 화면은 정상"의 바탕에는 세 가지가 있었다. 관리 화면은 Python 프로세스가 살아 있는지만 봤다. MCP는 포트 충돌이나 시작 실패 때 stderr 한 줄만 남기고 조용히 빠졌다(Finder로 연 앱의 stderr는 어디에도 남지 않음). 셸은 Core가 죽어도 다시 띄우지 않았다. 여기에 Claude Code는 원격 MCP가 끊기면 5번만 재시도하고(약 30초) 그 세션에서 포기한다. 설계: `docs/superpowers/specs/2026-10-19-desktop-core-health-design.md`, 계획: `docs/superpowers/plans/2026-10-19-desktop-core-health.md`.

- **헬스체크**: 셸 스레드 `raven-core-health`가 10초마다 Core 프로세스와 API·MCP `/healthz`를 확인한다(타임아웃 3초, 루프백 `TcpStream`, 의존성 추가 없음). 프로세스 종료와 MCP 미기동은 즉시, 응답 없음은 2번 연속일 때 장애로 본다. 새 Core는 15초 동안 실패를 세지 않는다. `RAVEN_DESKTOP_MCP=0`이면 MCP는 감시하지 않는다.
- **자동 복구**: Core 전체를 재시작한다(#44 경로, 엔드포인트가 바뀌면 웹뷰 새로고침). 간격은 즉시·30초·60초로 최대 3회다. 그래도 안 되면 경고 다이얼로그([로그 열기] [닫기])를 장애 한 건당 한 번 띄우고 자동 재시작을 멈춘다. 다이얼로그에는 증상, Core의 마지막 `⚠️` 경고, 로그 경로가 들어간다. 10분 연속 정상이거나 사람이 재시작하면(트레이·관리 화면·내부망 스위치) 횟수가 초기화된다.
- **원인 로그**: `~/Library/Logs/com.raven.local/core.log` (5MB × 3, UTC 시각). Core stderr 전부, Core 시작·준비·종료(종료 코드나 시그널), 이벤트 요약, 헬스 상태 변화, 재시작, 다이얼로그를 남긴다. 토큰과 손님 이벤트 본문(이름·IP·코드)은 남기지 않는다. 기록 실패는 무시한다.
- **관리 화면**: `CoreHealthPanel`이 API와 MCP를 따로 보여 준다(정상 / 복구 중 n/3 / 복구 실패 / 미기동 / 꺼짐(설정) / 확인 중). 마지막 확인 시각, 최근 오류, [로그 폴더 열기]도 있다. `core_status`에 `health`·`log_path`가 추가됐다. 셸 명령 `reveal_core_log`(인자 없음, 셸 자신의 경로만 보여 줌)와 권한 `allow-reveal-core-log`가 추가됐다. 상태 점은 `ui/StatusDot`(CSS 변수)으로 뽑았다.
- 검증:
  - cargo test 138 passed (신규 28: 로그 6, 탐침 5, 판정 10, Core 수명 주기 2, 셸 연결 5).
  - vitest 668 passed / 1 skipped (신규 `CoreHealthPanel.test.tsx` 4). `make typecheck` 통과.
  - 실제 앱(`tauri dev`), Core `kill -9`: 6초 뒤 감지, 7초 만에 재시작 완료(MCP 그대로).
  - 실제 앱, 설치본이 8766을 쥔 상태로 기동: MCP 미기동을 판정해 재시작 #1(즉시)·#2(+31초)·#3(+61초) 후 다이얼로그를 띄웠다. 다이얼로그에 포트 충돌 경고와 로그 경로가 표시되는 것을 확인했다.
- 테스트 중 발견: 탐침 테스트 서버가 요청을 다 읽기 전에 응답하고 닫으면 RST로 클라이언트가 응답을 못 읽는다(병렬 실행 때 간헐 실패). 서버가 헤더 끝까지 읽도록 고쳤다. 실제 uvicorn은 요청을 다 읽으므로 탐침 쪽 문제는 아니다.

## 10. 공유 창에서 바로 내부망 공개 켜고 끄기

내부망·Tailscale 공유 링크가 "무한 로딩 → 서버에 연결할 수 없음"으로 끝났다. 원인은 내부망 공개가 꺼져 있던 것이다(기본값, Core가 `127.0.0.1`에만 열림. 두 주소 모두 연결 거부를 확인했다). 그런데 공유 팝오버는 이 상태에서도 링크를 복사할 수 있게 보여 줬고, 경고는 "서버를 0.0.0.0으로 바인딩해야"뿐이었다. 스위치는 관리 화면 안쪽에만 있었다.

- **공유 팝오버(데스크톱)**:
  - 이 PC 전용이면 쓸 수 없는 링크를 숨기고 "🔒 지금은 이 PC에서만 열립니다" + [내부망에 공개하기]를 보여 준다. 누르면 확인 후 셸이 저장하고 Core를 재시작하며, 링크가 바로 나타난다.
  - 공개 중이면 링크마다 누가 열 수 있는지 알려 준다(내부망: 입장 요청 → 관리 화면에서 승인, Tailscale: 같은 tailnet 기기만). [공개 끄기]도 있다.
  - 환경변수(`RAVEN_DESKTOP_HOST`·`RAVEN_HOST`)로 고정돼 있으면 버튼 없이 이유만 보여 준다.
  - 셸 상태는 팝오버를 열 때 한 번만 묻는다(페이지마다 붙는 버튼).
  - 브라우저 모드는 예전 그대로다.
- **`lib/useLanAccess`**: 관리 화면 `LanAccessPanel`과 공유 팝오버가 같은 훅을 쓴다(셸 상태 조회, 확인창, `set_lan_access`, 엔드포인트 이동 시 새로고침). §8의 `invoke` 고정(`useMemo`)도 이 훅으로 옮겼다.
- 검증:
  - vitest 674 passed / 1 skipped. 신규 `ShareButton.lan-switch.test.tsx` 6개이고, 기존 `LanAccessPanel`·`ShareButton`·`PageExport` 테스트도 그대로 통과한다. `make typecheck` 통과.
  - 실제 앱(`tauri dev`): 공유 창에서 [내부망에 공개하기]를 누르자 Core가 `0.0.0.0`으로 재시작했다. `10.10.80.38`과 `100.116.203.33`에서 `/healthz` 200, `/page/…` 200(HTML), `/api/vaults`는 토큰 없이 401 `Bearer`(입장 요청 화면으로 이어짐)를 확인했다.

## 11. 상단 "🌐 내부망 공개 중" 표시

내부망 공개는 문서 단위가 아니라 Raven 전체 단위다. 문은 스위치로 열고, 열쇠는 손님 승인으로 준다(vault 단위의 읽기·작성·수정, 기기·IP에 묶임). 켜 둔 채 다른 문서를 보다 보면 열려 있다는 걸 잊는데, 다시 확인하고 끄려면 공유 창이나 관리 화면을 찾아 들어가야 했다.

- **`LanAccessIndicator`**: 데스크톱 앱에서 실제 바인딩이 loopback이 아닐 때만(환경변수로 연 경우 포함) 헤더 오른쪽 테마 버튼 옆에 보인다.
  - 누르면 "문서 하나가 아니라 Raven 전체가 열려 있다"는 설명, 내부망·Tailscale 주소, 승인된 손님(이름 — vault(권한)), [손님 관리 →], [공개 끄기]를 보여 준다.
  - 손님 목록은 열 때마다 새로 받는다.
  - 환경변수로 고정된 공개는 끌 수 없다고 말한다.
  - 색은 경고 토큰(`--color-warning-*`, 라이트·다크)을 쓴다.
- **화면 간 동기화**: `useLanAccess`가 바꾼 뒤 `raven:lan-access-changed`를 쏘고, 모든 훅 인스턴스가 다시 묻는다. 관리 스위치, 공유 창, 상단 표시 중 어디서 바꿔도 나머지가 따라 바뀐다.
- 검증:
  - vitest 680 passed / 1 skipped. 신규 `LanAccessIndicator.test.tsx` 6개: 브라우저·이 PC 전용이면 숨김, 주소·손님·권한 표시 후 끄기, 환경변수 고정, 관리 스위치로 켜면 즉시 표시, 셸 IPC 1회. `make typecheck` 통과.
  - 실제 앱(`tauri dev`, 내부망 공개 켠 상태): 헤더에 표시가 뜨는 것을 창 캡처로 확인했다.

## 12. 다음

- 데스크톱 앱 릴리스(알림·스위치 포함). 관리 → 내부망 공개를 켜면 동료가 링크로 입장을 요청할 수 있다.
- 권한 수정 API, 손님별 마지막 활동 상세는 필요해지면.

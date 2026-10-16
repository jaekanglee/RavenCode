# 데스크톱 앱에서 내부망 공개 켜고 끄기 — 설계

- **작성일**: 2026-10-16
- **범위**: 관리 화면의 스위치로 데스크톱 Core API를 내부망에 열고 닫는다. 설정은 앱이 기억하고, 켜면 동료에게 줄 주소를 보여 준다. 손님 입장([[2026-10-16-guest-access-design]])을 쓰려면 먼저 API가 내부망에 열려 있어야 한다.

## 배경

셸은 Core를 띄울 때 환경변수만 본다(`desktop/src-tauri/src/core.rs` `ManagedCore::start`: `RAVEN_DESKTOP_HOST` → `RAVEN_HOST` → `127.0.0.1`). `0.0.0.0`은 `RAVEN_ALLOW_REMOTE=1`이 함께 있어야 받아들여진다(`raven/desktop/runtime.py`, Issue #14). Finder로 연 앱에는 셸 환경변수가 닿지 않으니 `launchctl setenv`를 써야 하고, 재부팅하면 사라진다.

## 결정 사항

1. **저장**: 셸이 `<app_config_dir>/desktop-settings.json`에 `{"lan_access": true|false}`를 둔다. 없거나 깨졌으면 `false` — 이 PC 전용으로 닫힌 쪽이 기본이다.
2. **우선순위**: `RAVEN_DESKTOP_HOST`·`RAVEN_HOST`가 있으면 설정을 무시한다. 서버·헤드리스 배포가 지금처럼 동작해야 한다. 화면은 "환경변수로 고정됨"을 보여 주고 스위치를 끈다.
3. **켜면**: Core를 `--host 0.0.0.0` + `RAVEN_ALLOW_REMOTE=1`로 재시작한다. **MCP는 loopback에 둔다**(`RAVEN_MCP_HOST=127.0.0.1`) — 스위치의 용도는 동료에게 대시보드를 공유하는 것이고, admin 모드 MCP까지 내부망에 열 이유가 없다. 사용자가 `RAVEN_MCP_HOST`를 직접 정했으면 그 값을 따른다.
4. **끄면**: `127.0.0.1`로 재시작한다. 승인된 손님 기록은 남지만 접속할 수 없다.
5. **적용**: 스위치를 바꾸면 저장 → Core 재시작. 엔드포인트가 바뀌면 대시보드가 다시 읽는다(기존 백엔드 재시작 버튼과 같은 흐름).
6. **공유 주소**: `GET /api/system/info`의 `lan_api`를 복사 버튼과 함께 보여 준다. 포트가 8765가 아닐 수 있다(점유 시 OS 할당)는 점은 기존과 같다.

## 구성

| 위치 | 내용 |
|---|---|
| `core.rs` | `resolve_bind(env_host, lan) -> BindChoice { host, allow_remote, mcp_loopback }` 순수 함수. `ManagedCore::start`가 `lan` 인자를 받아 그 결과로 인자·환경을 정한다 |
| `lib.rs` | `desktop-settings.json` 읽기·쓰기, `do_restart_core`가 설정을 넘김, 명령 `lan_access_status` / `set_lan_access` |
| `permissions/default.toml`, `capabilities/default.json` | 두 명령 권한 |
| `dashboard/src/components/LanAccessPanel.tsx` | 관리 화면 스위치·상태·공유 주소. 데스크톱 + 로컬 호스트에서만 |

`lan_access_status` → `{ enabled, env_override }`. `set_lan_access(enabled)` → 저장 후 재시작, `Ok(())` 또는 오류 문자열. 저장에 실패하면 재시작하지 않는다.

## 테스트

- Rust: `resolve_bind` (환경변수 우선, 켬/끔, 사용자 `RAVEN_MCP_HOST`), 설정 파일 읽기(없음·깨짐 → false)·쓰기 왕복, 명령 등록·권한 노출.
- vitest: 패널 — 상태 표시, 환경변수 고정 시 비활성, 토글 시 `set_lan_access` 호출 후 엔드포인트가 바뀌면 새로고침, 공유 주소 복사.

## 범위 밖

트레이 메뉴 토글, 특정 인터페이스만 열기, 방화벽 설정 안내 자동화.

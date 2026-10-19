# 데스크톱 Core 헬스체크·자동 복구·원인 로그 — 설계

- **작성일**: 2026-10-19
- **범위**: 셸이 Core의 API·MCP를 주기적으로 확인한다. 응답이 없으면 Core를 재시작하고, 정해진 횟수 안에 돌아오지 않으면 경고 다이얼로그를 띄운다. 관리 화면은 실제 상태를 보여 준다. Core의 stderr와 셸의 수명 주기 기록은 회전 로그 파일에 남긴다.

## 배경

"며칠 지나면 Claude가 Raven MCP가 꺼져 있다고 하는데, 관리 화면은 정상이라고 한다."

- 관리 화면의 "실행 중"은 Python 프로세스가 살아 있는지만 본다(`ManagedCore::is_alive`). MCP 줄은 시작할 때 받은 주소를 계속 보여 준다.
- MCP는 best-effort다. 포트 충돌, 10초 시작 타임아웃, 리스너가 죽는 경우에 Core는 stderr에 `⚠️` 한 줄만 남기고 API만으로 뜬다(`raven/desktop/runtime.py`). Finder로 연 앱에서는 그 stderr가 어디에도 남지 않는다.
- Core의 메인 루프는 API 서버와 부모 PID만 감시한다. 셸은 Core가 혼자 죽어도 다시 띄우지 않는다.
- Claude Code는 원격 MCP가 끊기면 최대 5번 다시 시도하고(약 30초), 그 뒤에는 그 세션에서 failed로 굳는다(`code.claude.com/docs/en/mcp.md`). 짧은 장애는 30초 안에 고쳐야 열려 있는 세션들이 살아남는다.

## 결정 사항

1. **감시 위치는 셸이다.** Core가 죽거나 멈춰도 감시가 계속돼야 하고, 창을 숨긴 동안에도 돌아야 한다. Python 쪽은 바꾸지 않는다.
2. **탐침**: 10초마다 `GET /healthz`를 API와 MCP에 각각 보낸다. 항목마다 타임아웃 3초이고, 루프백 `TcpStream`으로 직접 보낸다(의존성 추가 없음). 두 `/healthz` 모두 토큰 없이 열려 있다. MCP 쪽은 인증 게이트가 직접 응답하므로, 리스너와 이벤트 루프가 살아 있다는 것까지만 증명한다.
3. **장애 판정**
   | 항목 | 조건 | 시점 |
   |---|---|---|
   | Core 프로세스 | 종료됨 | 즉시 |
   | API | 연결 실패·3초 초과·200이 아님 | 2번 연속 |
   | MCP | 위와 같음 | 2번 연속 |
   | MCP 미기동 | MCP가 켜져 있는데(`RAVEN_DESKTOP_MCP`) Core가 MCP 없이 준비됨 | 즉시 |

   MCP를 설정으로 끈 경우(`RAVEN_DESKTOP_MCP=0`)에는 MCP를 "꺼짐(설정)"으로 표시하고 판정에서 뺀다.
4. **복구**: 어떤 장애든 Core 전체를 재시작한다. 재시작에는 기존 `do_restart_core` 경로를 쓰고, 엔드포인트가 바뀌었으면 웹뷰를 새로고침한다(네트워크 재시작과 같다).
5. **재시작 간격과 한도**: 장애 한 건 안에서 재시작 #1은 장애를 판정한 즉시 한다. #2는 #1로부터 30초 이상, #3은 #2로부터 60초 이상 지난 뒤에 한다. 각 재시작 뒤에는 연속 실패 횟수를 0으로 되돌리고 3번의 규칙으로 다시 판정하며, 그때도 장애이고 간격이 지났을 때만 다음 재시작을 한다. 3회째 재시작 뒤에도 장애로 판정되면 경고 다이얼로그를 한 번 띄우고 자동 재시작을 멈춘다. 탐침은 계속하며, 돌아오면 "복구됨"을 기록한다. 포트를 다른 프로세스가 잡고 있는 경우처럼 재시작으로 고쳐지지 않는 원인 때문에 대시보드가 끝없이 새로고침되지 않게 하려는 것이다.
6. **장애 한 건의 범위**: 10분 연속으로 정상이어야 끝난다. 그 전에 다시 장애가 나면 횟수를 이어서 센다.
7. **초기화**: 수동 재시작(트레이, 관리 화면, 내부망 스위치)이나 네트워크 재시작으로 새 Core가 생기면 횟수를 0으로 되돌린다.
8. **감시를 쉬는 때**: 시작이나 재시작이 진행 중일 때(기존 pending 슬롯), 새 Core가 준비된 뒤 15초 동안, Core가 없을 때(최초 기동 전, 종료 중).
9. **경고 다이얼로그**: 기존 경고와 같은 macOS 경고창을 쓴다. 버튼은 [로그 열기] [닫기]이고, 장애 한 건당 한 번만 띄운다. 본문에는 증상, 시도 횟수, Core 마지막 경고(가장 최근의 `⚠️` stderr 줄), 로그 경로를 넣는다.
10. **원인 로그**: `<app_log_dir>/core.log`에 남긴다. macOS에서는 `~/Library/Logs/com.raven.local/core.log`다. 5MB가 차면 `.1`, `.2`로 넘기고 최대 3개만 둔다.
    - **남기는 것**: Core stderr 전부, Core 시작(pid, 엔드포인트, MCP 유무)과 종료(종료 코드나 시그널), 헬스 상태가 바뀔 때, 재시작과 그 결과, 다이얼로그. 정상 탐침은 남기지 않는다.
    - **남기지 않는 것**: 토큰과 Core stdout 이벤트 본문(손님 이름·IP). stdout은 이벤트 종류만 남긴다.
    - 시각은 UTC ISO-8601(`2026-10-19T06:21:43Z`)로 쓴다. 기록에 실패하면(디스크, 권한) 조용히 넘어간다. 로그 때문에 앱이 멈추면 안 된다.
11. **관리 화면**: API와 MCP를 따로 보여 준다. 상태는 정상 / 응답 없음 / 복구 중(재시작 n/3) / 복구 실패 / 꺼짐(설정) / 미기동이다. 마지막 확인 시각, 최근 오류, [로그 폴더 열기]도 함께 둔다. 데이터는 `core_status`에 필드를 더해 지금 하는 5초 폴링으로 받는다.

## 구성

| 파일 | 역할 |
|---|---|
| `desktop/src-tauri/src/health.rs` (신규) | 판정 상태 기계. 입력은 관측(프로세스 종료 여부, API·MCP 탐침 결과, MCP 미기동 여부)과 시각이고, 출력은 행동(없음 / 재시작 / 포기 / 복구됨)과 관리 화면용 스냅샷이다. I/O가 없는 순수 로직이다. `/healthz` 탐침 함수도 이 파일에 둔다. |
| `desktop/src-tauri/src/core_log.rs` (신규) | 회전 로그. `RotatingLog`(경로, 크기 한도, 보관 개수) 인스턴스와, setup에서 한 번 초기화하는 전역 기록 함수. Core 마지막 경고 줄도 보관한다. |
| `desktop/src-tauri/src/core.rs` | stderr 중계가 `core_log`에도 쓴다. stdout 이벤트는 종류만 남긴다. `ManagedCore`에 pid와 종료 상태 조회를 더한다. |
| `desktop/src-tauri/src/lib.rs` | 감시 스레드 `raven-core-health`, `HealthState`(스냅샷) 관리 상태, `core_status` 확장, `reveal_core_log` 명령, setup에서 로그 초기화. |
| `desktop/src-tauri/permissions/default.toml`, `capabilities/default.json` | `allow-reveal-core-log` |
| `dashboard/src/components/ui/StatusDot.tsx` (신규) | 상태 점 (정상·경고·오류·꺼짐 색은 CSS 변수) |
| `dashboard/src/components/CoreHealthPanel.tsx` (신규) | 관리 화면의 백엔드 상태 블록 (표시 전용, props로 상태를 받음) |
| `dashboard/src/routes/VaultManage.tsx` | 인라인 상태 블록을 `CoreHealthPanel`로 교체 |

## `core_status` 응답 (추가 필드)

```jsonc
{
  "running": true,                    // 기존: 프로세스 생존 (실시간)
  "endpoint": "http://127.0.0.1:8765",
  "mcp_endpoint": "http://127.0.0.1:8766/mcp",
  "health": {
    "api": "ok",                      // ok | down | unknown
    "mcp": "ok",                      // ok | down | missing | off | unknown
    "phase": "healthy",               // healthy | recovering | gave_up
    "restarts": 0,                    // 이번 장애에서 시도한 자동 재시작 수
    "max_restarts": 3,
    "checked_at_ms": 1760854903000,   // 마지막 탐침 (epoch ms), 없으면 null
    "last_error": null,               // 최근 장애 사유 (사람이 읽는 문장)
    "last_error_at_ms": null
  },
  "log_path": "/Users/…/Library/Logs/com.raven.local/core.log"
}
```

## 테스트

- **cargo (`health.rs`)**: 2번 연속 규칙, 프로세스 종료와 MCP 미기동은 즉시 판정, 재시작 간격 0·30·60초, 3회 뒤 포기와 다이얼로그 1번, 포기 뒤 복구, 10분 정상 시 초기화, 새 Core(수동 재시작)일 때 초기화, 쉬는 구간, MCP를 설정으로 끈 경우.
- **cargo (탐침)**: 테스트용 `TcpListener`로 200, 500, 무응답(타임아웃), 연결 거부.
- **cargo (`core_log.rs`)**: 한도를 넘으면 회전, 3개 보관, 시각 형식, 쓸 수 없는 경로에서도 패닉 없음, 마지막 경고 보관.
- **vitest (`CoreHealthPanel`)**: 상태별 표시(정상, 복구 중, 복구 실패, 미기동, 꺼짐), 마지막 확인 시각, 로그 버튼.
- **실제 앱 (`tauri dev`)**: Python Core를 `kill -9`하면 약 10초 안에 자동 재시작되는지. 8766을 미리 점유한 채 띄우면 재시작 3회 뒤 다이얼로그가 뜨고 로그에 원인이 남는지.

## 범위 밖

- Python Core 안에서 MCP만 다시 띄우는 것 (Core 전체 재시작으로 대신한다).
- Claude Code의 재연결 정책 (5회 뒤 포기)은 바꿀 수 없다. 30초 안에 고쳐서 살아남는 세션을 늘리는 것이 최선이다.
- 로그인할 때 Raven 자동 실행.
- MCP 앱 내부(세션 매니저)까지 확인하는 깊은 탐침. 토큰이 필요하다.

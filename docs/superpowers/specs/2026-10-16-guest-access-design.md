# 내부망 손님 입장 — 요청·승인·vault별 권한 — 설계

- **작성일**: 2026-10-16
- **범위**: 같은 내부망 동료가 대시보드 링크를 열면 입장을 요청하고, 운영자가 데스크톱 앱에서 승인하면 그 기기·IP 전용 토큰이 자동으로 전달된다. 승인 시 vault별로 읽기·작성·수정 권한과 기간을 정한다. 삭제와 관리 작업은 운영자만 한다.

## 배경

데스크톱 앱 Core는 기본적으로 `127.0.0.1`에 바인딩한다(`desktop/src-tauri/src/core.rs` `RAVEN_DESKTOP_HOST` → `RAVEN_HOST` → loopback). `RAVEN_DESKTOP_HOST=0.0.0.0` + `RAVEN_ALLOW_REMOTE=1`로 내부망에 열 수 있지만, 그 뒤 들어오는 모든 요청은 `raven mcp token add`로 발급한 Bearer 토큰이 필요하다(`raven/core/access.py::TokenGate`, ADR `adr-2026-10-13-loopback-token-required.md`).

이 토큰은 전체 권한이고, 운영자가 CLI로 발급해 평문을 손으로 전달해야 한다. 동료에게 페이지 링크 하나를 공유하기엔 무겁고, 권한을 좁힐 방법도 없다.

이미 있는 것:

| 항목 | 위치 | 재사용 |
|---|---|---|
| 토큰 저장소 (해시·0600·원자적 쓰기·매 요청 재로드) | `raven/core/mcp_tokens.py` | 같은 패턴으로 손님 저장소를 만든다. 파일은 따로 둔다 |
| 접근 게이트, 출처 판정 | `raven/core/access.py` `TokenGate`, `effective_client` | 손님 판정을 이 게이트에 넣는다 |
| 대시보드 토큰 입력·저장 | `dashboard/src/components/AuthTokenDialog.tsx`, `dashboard/src/lib/host-auth.ts` | 토큰 저장 위치를 그대로 쓴다 |
| 쓰기 provenance | `raven/core/contracts.py` `actor` 인자 → frontmatter `agents:` + `log.md` `actor=` | 손님 이름을 actor로 넘긴다 |
| Core → 셸 이벤트 통로 | `raven/desktop/runtime.py` stdout `{"event": ...}`, `core.rs` `parse_event` | `guest_request` 이벤트를 추가한다 |

## 결정 사항

1. **기기 + IP 바인딩**: 손님 토큰은 승인 때 기록한 기기 ID와 IP가 모두 맞을 때만 통과한다. 하나라도 바뀌면 다시 요청한다.
2. **자동 전달**: 승인하면 요청한 브라우저가 폴링으로 토큰을 받아 저장한다. 운영자가 평문을 볼 일은 없다. 같은 기기가 새로 승인받으면 그 기기의 이전 토큰은 폐기된다.
3. **권한**: vault별로 `read` / `create` / `update`. `create`·`update`는 `read`를 포함한다. **삭제는 운영자만.** 관리성 작업(빌드·리페어·git·백업·vault 관리 등)도 운영자만.
4. **기간**: 승인할 때 7일 / 30일 / 무기한 중 고른다. 만료되면 다시 요청한다.
5. **대시보드 전용**: 손님 토큰은 Core API에서만 통한다. MCP 게이트는 손님 저장소를 읽지 않으므로 손님 토큰으로 MCP에 들어갈 수 없다. 에이전트는 지금처럼 `rvn_` 토큰을 쓴다.
6. **알림**: 대시보드 관리 탭 배지 + macOS 알림. 셸에 `tauri-plugin-notification`을 추가한다(사용자 승인 완료, 2026-10-16).
7. **작성자 기록**: 손님 쓰기는 서버가 `guest:<이름>`으로 기록한다(`log.md`, 피드백 줄, 관계 actor). 클라이언트가 보낸 `actor` 값은 무시한다.
8. **기본 차단**: 라우트 표에 없는 API는 운영자 전용이다.

이 기능은 새 진입점이 아니다. 기존 HTTP API와 Dashboard 안의 접근 제어다.

## 데이터

### 대기 중인 요청 — 메모리 전용

`raven/core/guest_access.py`의 프로세스 내 저장소. 앱을 재시작하면 사라진다.

| 필드 | 설명 |
|---|---|
| `request_id` | `secrets.token_urlsafe(16)` |
| `claim_sha256` | 요청한 브라우저만 가진 `claim_secret`의 해시 |
| `name` | 요청자 이름. 공백 제거 후 1~40자 |
| `device_id` | 브라우저 기기 ID (`d_` + 22~64자 URL-safe) |
| `ip` | 요청 출처 IP (`effective_client`) |
| `code` | 확인 코드 `XX-XX` (혼동 문자 0/O/1/I 제외) |
| `created` | 생성 시각 |
| `status` | `pending` → `approved` / `denied` / `expired` / `claimed` |
| `token` | 승인 후 수령 전까지만 메모리에 있는 평문. 수령하면 지운다 |

- 대기 10분이 지나면 `expired`. 승인 후 10분 안에 수령하지 않아도 `expired`로 바꾸고 발급된 grant를 지운다.
- 동시에 `pending`은 최대 20건, 같은 IP에서 1분에 생성 3건까지.

### 승인된 손님 — `<VAULTS_ROOT>/.guest-grants.json` (0600)

```json
{
  "grants": [{
    "id": "g_8f2c…",
    "name": "김동료",
    "sha256": "<토큰 해시>",
    "device_id": "d_…",
    "ip": "10.10.81.12",
    "vaults": { "rider-app": ["read", "create", "update"], "slmmury": ["read"] },
    "created": "2026-10-16T09:00:00+00:00",
    "expires": "2026-11-15T09:00:00+00:00",
    "last_seen": "2026-10-16T10:12:00+00:00"
  }]
}
```

- 토큰은 `rvg_` + `secrets.token_urlsafe(32)`. 평문은 저장하지 않는다.
- `expires: null`은 무기한.
- 같은 `device_id`로 새로 승인하면 기존 항목을 교체한다.
- `last_seen`은 1시간에 한 번만 갱신한다.
- 파일이 깨졌거나 읽을 수 없으면 **모든 손님을 차단**하고 stderr에 경고한다. `mcp_tokens.py`처럼 빈 목록으로 취급하면 결과가 같으므로(전부 거부) 같은 처리를 쓴다.

### 브라우저 — localStorage

- `raven.deviceId`: 처음 접속할 때 만든다. 모든 API 요청에 `X-Raven-Device` 헤더로 보낸다.
- 손님 토큰: localStorage `raven:guest-token:<base>`. 운영자 토큰(sessionStorage)과 달리 창을 닫아도 남아야 "앞으로 들어올 수 있다". 기기 ID·IP 바인딩이 이 차이를 받친다.

## API

### 공개 (토큰 불필요, `TokenGate` 공개 예외)

| API | 동작 |
|---|---|
| `POST /api/guest/requests` `{name, device_id}` | 요청 생성 → `{request_id, claim_secret, code, expires_in}`. Core가 `{"event": "guest_request", "name", "ip", "code"}`를 stdout으로 낸다 |
| `GET /api/guest/requests/{id}` + `X-Raven-Claim`, `X-Raven-Device` | `{status}`. `approved` 상태의 첫 조회에서만 `{status: "approved", token}`을 주고 `claimed`로 바꾼다 |

상태 조회는 claim 해시·기기 ID·출처 IP가 모두 맞아야 응답한다. 하나라도 다르면 404.

### 손님 본인

| API | 동작 |
|---|---|
| `GET /api/guest/me` | `{name, vaults, expires}`. 손님 토큰일 때만. 운영자는 404 |

### 운영자 전용 (데스크톱 세션 또는 `rvn_` 토큰)

| API | 동작 |
|---|---|
| `GET /api/guest/requests` | `pending` 목록 (`claim`·`token` 제외) |
| `POST /api/guest/requests/{id}/approve` `{vaults, ttl_days}` | grant 생성. `ttl_days ∈ {7, 30, null}`. `vaults`의 이름은 등록된 vault, 권한은 `read`/`create`/`update`만. `create`·`update`가 있으면 `read`를 자동 추가 |
| `POST /api/guest/requests/{id}/deny` | 거절 |
| `GET /api/guest/grants` | grant 목록 (`sha256` 제외) |
| `DELETE /api/guest/grants/{id}` | 내보내기. 다음 요청부터 반영 |

권한 수정 API는 만들지 않는다. 내보낸 뒤 다시 승인한다.

## 권한 판정

`TokenGate`에서 Bearer가 `rvg_`로 시작할 때만 아래를 탄다. 기존 `rvn_`·세션 토큰 경로는 바뀌지 않는다.

1. 해시로 grant 조회 → 없으면 401 `revoked`
2. `expires` 지남 → 401 `expired`
3. `X-Raven-Device` 불일치 → 401 `device_mismatch`
4. `effective_client` 불일치 또는 판정 불가 → 401 `ip_changed`
5. 라우트 표에서 `(method, 경로 템플릿)` → 필요 권한과 vault 이름(`{name}`)을 찾는다
6. 권한 없음 → 403 `{"error": "forbidden", "need": "<권한>", "vault": "<이름>"}`
7. 통과 → `scope["state"]["raven_guest"] = {id, name, vaults}`를 실어 앱으로 넘긴다

401 본문은 `{"ok": false, "error": "unauthorized", "reason": "<이유>", "detail": ...}`. websocket은 지금처럼 close 1008.

### 라우트 표 — `raven/api/guest_routes.py`

경로 템플릿 문자열을 키로 하는 명시적 dict. 분류는 `read` / `create` / `update` / `owner` / `guest_self` / `public`.

| 분류 | 라우트 |
|---|---|
| `read` | `/api/vaults/{name}`의 GET 전부 중 아래 `owner`에 없는 것: 페이지·목록·트리·검색·하이브리드·RAG·그래프·린트·링크체크·통계·로그 보기·추천·`export.md`·아카이브 목록·drafts 목록·policy·raw 보기·advice·garden. `POST suggest-tags` |
| `create` | `POST pages`, `POST folders` |
| `update` | `PUT pages/{slug}`(핸들러가 기존 페이지만 허용, 없으면 404), `POST relations`, `POST pages/{slug}/feedback`, `POST lint/contradictions/resolve` |
| `owner` | 모든 `DELETE`. `POST/PUT /api/vaults`, `register`, `clone`, `PUT /api/vaults/{name}`, 백업, `build`, `repair`, `archive/clean`, `archive/restore`, `git/*`, `PUT raw`, `PUT policy`, `POST log`, `log/rotate`, `drafts/generate`, `drafts/commit`(운영자 LLM 초안 발행), `PUT feedback/{index}`(남의 피드백을 원작성자 이름으로 바꿈), `graph/positions`, `select`, `locks`, `/api/system/*`, `debug-log`, `crosslink`, `workspace*`, `export`, `index.json`, 운영자용 `/api/guest/*` |
| `guest_self` | `GET /api/guest/me` |
| `public` | `GET /healthz`, 대시보드 정적 파일, 공개 `/api/guest/*` 2종 |
| 표에 없음 | `owner` |

구현 때 실제 등록 라우트를 하나씩 확인해 표를 확정한다. `GET git/*`, `GET locks`처럼 GET이지만 운영자 전용으로 둘 것은 표에서 명시한다.

### vault 이름이 경로에 없는 API

- `GET /api/vaults`: 핸들러가 `scope["state"]["raven_guest"]`를 보고 허용된 vault만 남긴다. 이렇게 응답을 거르는 API는 이것 하나다.
- `/api/system/info`, `POST select`: 손님은 403. 대시보드는 두 호출의 실패를 이미 무시한다.

### 작성자 강제

페이지 생성·수정·피드백 API는 원래 `actor`를 넘기지 않는다. `actor`를 넘기면 allowlist·strict schema·frontmatter `agents:`가 손님에게만 걸리므로, `write_page`에 로그 전용 `log_actor`를 추가해 `log.md`에 `actor=guest:<이름>`만 남긴다. 피드백 줄 작성자와 관계 추가(`relations`, `contradictions/resolve`)의 `actor`는 `guest:<이름>`으로 덮어쓴다(클라이언트 값 무시).

## 대시보드

**손님 화면**
- 토큰 없이 401을 받으면 `AuthTokenDialog`가 같은 호스트(base `""`)일 때 입장 요청 화면부터 띄운다. "토큰 직접 입력"으로 기존 토큰 입력으로 바꾼다. 원격 호스트(HostPicker)는 토큰 입력부터.
- 요청 후 확인 코드와 "승인 대기 중"을 보여주고 2초마다 상태를 조회한다. 승인되면 토큰을 저장하고 원래 URL로 돌아간다. 거절·만료면 안내와 "다시 요청".
- `reason`이 있는 401을 받으면 저장된 토큰을 지우고 이유별 안내(`ip_changed`: "IP가 바뀌었어요" 등)와 함께 입장 요청 화면으로 간다.
- 상단에 "손님으로 접속 중 · rider-app(읽기·수정)" 한 줄. `GET /api/guest/me` 기준으로 권한 없는 버튼(새 페이지·편집·삭제·관리 탭)을 숨긴다. 서버 403이 원칙이고 숨김은 편의다.
- `/api/system/info`·`POST select`의 403은 대시보드가 이미 조용히 무시하므로 따로 건너뛰지 않는다.

**운영자 화면 (관리 탭 "손님 입장" 섹션)**
- 대기 요청: 이름·IP·확인 코드·남은 시간. vault별 `읽기/작성/수정` 체크, 기간 `7일/30일/무기한`, [승인] [거절].
- 승인된 기기: 이름·IP·vault별 권한·만료일·마지막 접속, [내보내기].
- 관리 탭 라벨에 대기 건수 배지. 데스크톱 세션일 때 5초 폴링.
- AGENTS.md §13: 기존 `ui/` 컴포넌트·CSS 토큰 사용, 빈 상태는 EmptyState.

## 데스크톱 셸

- `core.rs` `parse_event`에 `guest_request {name, ip, code}` 추가. 이름은 40자로 자르고 제어 문자를 지운다.
- `tauri-plugin-notification`으로 "김동료님이 입장을 요청했어요 (10.10.81.12 · K7-3F). 관리 탭의 손님 입장에서 승인하세요." 이 플러그인은 데스크톱에서 클릭 액션을 지원하지 않아 클릭 이동은 없다. 보던 화면을 알림이 강제로 옮기지도 않는다.
- 데스크톱 버전선(`tauri.conf.json`)을 올려 릴리스해야 배포된다.

## 에러 처리

| 상황 | 응답 |
|---|---|
| 요청 과다 (IP당 1분 3건, 대기 20건) | 429 |
| 이름·기기 ID 형식 오류 | 422 |
| 처리된·만료된 요청 승인/거절 | 409 |
| 승인 payload의 vault·권한·기간 오류 | 422 |
| grant 파일 손상 | 손님 전부 401 `revoked`, stderr 경고. 운영자·에이전트 영향 없음 |
| 출처 IP 판정 불가 (#29) | 손님 401 `ip_changed` |
| 앱 재시작 | 대기 요청 소멸, grant 유지 |

## 테스트

- `tests/test_guest_access_store.py`: 발급·검증·해시만 저장·0600·같은 기기 재승인 시 교체·만료·손상 파일 시 전부 거부·`last_seen` 갱신 주기
- `tests/test_guest_requests.py`: 생성→승인→1회 수령, claim·기기·IP 불일치 404, 10분 만료, 수령 안 된 승인 만료 시 grant 삭제, 429, 409, 422
- `tests/test_guest_gate.py`: 401 이유 4종, vault·권한 불일치 403, `DELETE`·운영자 API 403, `GET /api/vaults` 필터, actor 강제(클라이언트 값 무시), `rvn_`·세션 경로 무변화
- **라우트 커버리지**: 앱에 등록된 모든 라우트가 `guest_routes` 표에 있는지 검사. 빠지면 실패
- MCP: 손님 토큰으로 접속 시 401
- 대시보드 vitest: 입장 요청 화면 흐름, `reason`별 안내, 승인 폼(작성·수정 시 읽기 자동), 권한별 버튼 숨김
- 셸: `parse_event` `guest_request` 정상·비정상 케이스

## 단계

1. **백엔드**: 저장소·요청 API·게이트 판정·라우트 표·actor 강제·이벤트 출력 + ADR `_meta/decisions/adr-2026-10-16-guest-access-pairing.md` → `pytest tests/ -q`
2. **대시보드**: 입장 요청 화면·관리 탭 손님 섹션·손님 모드 UI → vitest + 실제 앱에서 다른 기기로 확인
3. **데스크톱 셸**: 알림 플러그인·`guest_request` 이벤트 → `cargo test`, 앱 빌드 후 알림 확인

각 단계 끝에 커밋 여부를 확인한다. 1~2단계만으로 기능이 완성되고 3단계는 알림만 더한다.

## 범위 밖

- 권한 수정 API (내보내고 다시 승인)
- 손님의 MCP 접근
- 손님별 삭제 권한
- 대기 요청의 영속화
- 내부망 바인딩 자동 설정 (`RAVEN_DESKTOP_HOST=0.0.0.0` + `RAVEN_ALLOW_REMOTE=1`은 운영자가 직접 켠다)

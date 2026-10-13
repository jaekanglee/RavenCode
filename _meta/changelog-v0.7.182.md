# Raven Changelog — v0.7.182

## 1. 개요

모바일 저장이 PC 편집을 조용히 덮어쓰던 경로를 닫았다. v0.7.181 백로그 P1 소진.

서버는 v0.7.178부터 lost update를 막을 준비가 다 돼 있었다 — `GET /pages/{slug}`가 `precondition` 토큰을 주고 `PUT`이 그 토큰을 받아 `stale_precondition` → 409를 낸다. 앱만 토큰을 싣지 않았고, 서버는 토큰이 없으면 검사를 건너뛰므로 **모바일 저장은 항상 무조건 승리**했다. `PendingWrite.failureKind`의 `CONFLICT` 분기는 도달 불가능한 코드였다.

의존성 추가 없음. 진입점 변경 없음. vault 데이터 write 없음.

## 2. 로컬 스키마 — 상태 토큰 보관 (schema 4)

토큰을 실어 보내려면 "내가 읽은 시점의 서버 상태"를 기기에 들고 있어야 한다. `4.sqm`으로 두 칸을 추가했다 (ADD COLUMN이라 기존 행은 NULL = 토큰 미상 = 검사 생략, 하위 호환).

| 칸 | 뜻 |
|---|---|
| `Document.precondition` | 이 본문을 읽은 시점의 서버 상태 |
| `PendingWrite.basePrecondition` | 큐에 넣을 때의 base — 전송 시점 값이 아니라 **편집이 출발한 지점** |

두 칸을 나눈 이유: 오프라인에서 쓴 글은 며칠 뒤에 전송될 수 있다. 전송 시점의 최신 토큰을 쓰면 "내가 본 것과 서버가 같다"는 단언이 거짓이 되어 검사가 무력화된다.

## 3. 쓰기 경로

- `fetchDocument`가 본문과 토큰을 **한 문장에서 함께** 저장한다 (`updateDocumentContent`). 본문과 그 본문의 출처 상태는 갈라지면 안 된다.
- `saveDocument`는 `INSERT OR REPLACE`로 행을 덮기 **전에** base를 읽는다. 순서를 뒤집으면 토큰이 자기 자신에 의해 지워진다.
- `PUT` body에 `precondition`을 싣는다. `ravenJson`에 `explicitNulls = false`를 켜서 **토큰을 모를 때는 필드 자체가 빠진다** — 서버 계약에서 `""`는 "파일 부재 단언"이고 필드 없음은 "검사 생략"이라, null을 실어 보내면 의미가 흐려진다.
- PUT 성공 응답의 새 토큰으로 로컬을 갱신한다. 이걸 빼먹으면 연속 수정 두 번째가 **방금 자기가 쓴 글과** 충돌한다.
- `deleteDocument`도 같은 base를 큐에 넣는다.

## 4. 충돌을 화면까지 올린다

DB에 `failureKind=CONFLICT`만 적고 끝내면, 사용자 입장에서는 "저장했는데 조용히 안 올라감"으로 바뀔 뿐 이전보다 나아지지 않는다. `WriteOutcome`(`Synced` / `Queued` / `Conflict`)를 `saveDocument` 반환값으로 올려 스낵바를 구분한다.

| 결과 | 사용자에게 보이는 것 |
|---|---|
| `Synced` | (조용히 성공) |
| `Queued` | "지금 PC에 닿지 않아 기기에만 저장했습니다. 재연결 후 당겨 내리면 올라가요." |
| `Conflict` | "PC에서 이 문서가 먼지 바뀌어 서버에 반영하지 않았습니다. 문서를 다시 받아 합치세요." |

충돌 시 큐 항목과 payload는 지우지 않는다 — 사용자가 합칠 원본이 사라지면 안 된다.

## 5. 회귀 가드 6건 (RED 먼저)

`searchDocuments`가 없던 v0.7.181과 같은 방식으로, `basePrecondition` 부재로 컴파일이 깨지는 상태에서 시작했다.

| 테스트 | 잠근 것 |
|---|---|
| `fetchDocumentStoresServerPrecondition` | GET 응답의 토큰이 로컬에 남는다 |
| `putSendsPreconditionReadFromServer` | PUT body에 그 토큰이 실리고, 응답의 새 토큰으로 갱신된다 |
| `queuedWriteKeepsBasePreconditionUntilFlush` | 오프라인에서 굳은 base가 나중 전송까지 그대로 간다 |
| `stalePreconditionIsReportedAsConflictAndKeepsQueueEntry` | 409 → `CONFLICT` + 큐·payload 보존 |
| `documentWithoutKnownPreconditionOmitsTheField` | 토큰 미상이면 필드 자체가 빠진다 |
| `saveOutcomeTellsSyncedQueuedAndConflictApart` | 세 결과가 서로 구분된다 |

## 6. 검증

| 항목 | 결과 |
|---|---|
| `:shared:testDebugUnitTest` | 23 passed, 0 failed (v0.7.181의 17 + 신규 6) |
| `:shared:verifySqlDelightMigration` | BUILD SUCCESSFUL (schema 4 마이그레이션 + CREATE 정합) |
| `:androidApp:assembleDevDebug` | BUILD SUCCESSFUL |
| `pytest tests/ -q` | 769 passed, 1 skipped |

에뮬레이터·실기 실행은 하지 않았다 (운영 규약).

## 7. 이번 사이클에서 발견한 별건

**모바일 신규 문서 작성은 서버에 안 올라갈 가능성이 크다.** 앱은 생성도 `PUT /pages/{slug}`로 보내는데 서버 `update_page`는 파일이 없으면 404다 (생성은 `POST /pages`). 즉 새 문서는 `REMOTE_FAILURE`로 큐에 남아 영구 재시도한다. unit test는 mock 서버라 이 차이를 못 잡았다.

이번 패치 범위(precondition)와 별개 결함이므로 손대지 않았다. 실기 절차 §1~§2를 밟으면 바로 드러난다 — `raven log list`에 create 기록이 없고 `content/`에 파일이 안 생기면 이 건이다.

## 8. 남은 백로그

| 항목 | 우선순위 | 비고 |
|---|---|---|
| 모바일 신규 문서 생성 경로 (PUT → POST) | P0 후보 | §7. 확인되면 즉시 |
| 충돌 문서 병합 UX | P2 | 지금은 "다시 받아 합치세요" 안내까지. 양쪽 본문을 나란히 보여주는 화면은 별도 |
| 모바일 검색 오프라인 fallback | P2 | v0.7.181에서 이월 |
| 대시보드 스크린샷 회귀 | P2 | Playwright 도입 승인 필요 |
| Crashlytics 도입 여부 | 사용자 결정 | 미통합 상태 유지 |

## 9. 그래프 성능·탐색 UX 개선

그래프 렌더링에서 프레임마다 반복되던 라벨 측정, 링크 스타일 조립, 커뮤니티·타임라인 계산을 데이터 변경 시 1회 계산으로 이동했다. 라벨 충돌 회피와 뷰포트 컬링을 추가하고, 그래프 타입 색을 CSS 토큰으로 통합했다. 선택 하이라이트는 그래프 데이터를 재설정하지 않고 ref 기반 repaint만 수행하며, 이웃 깊이 조절과 선택 노드 줌을 제공한다.

구형 `wiki.db`의 `collection` 컬럼 누락 시 조용한 Markdown fallback으로 열화되던 그래프 경로도 canonical DB 연결·리빌드 경로를 사용하도록 수정했다. WebGL/3D 렌더러 전환은 별도 이슈로 보류했다.

검증: `scripts/.venv/bin/python -m pytest tests/` — 771 passed, 1 skipped; Dashboard Vitest — 224 passed, 1 skipped; `npx tsc -b`; `npm run build`; Chrome `/graph` 실기 QA — `/tmp/ulw-graph-qa-final6/`.

## 10. Tauri 데스크톱 앱 "하얀 화면" (PWA Service Worker 캐시) 이슈 수정

이전 빌드 중 `dashboard/src/lib/api.ts` 구문 오류(P1, P2)로 인해 생성된 "깨진 React 번들" 혹은 빈 껍데기가 **Tauri 앱의 macOS WebKit Service Worker 캐시**에 남는 현상이 발생했다. 

- 데스크톱 앱 재설치(`make desktop-install`) 시 바이너리 내부 리소스는 갱신되지만, macOS 시스템 깊은 곳(`~/Library/WebKit/com.raven.local`)에 위치한 PWA 캐시가 신규 리소스 로딩을 방해하여 영구적인 "하얀 공백 화면"을 유발했다.
- 해결 1 (수동): `rm -rf ~/Library/WebKit/com.raven.local ~/Library/Caches/com.raven.local "~/Library/Application Support/com.raven.local"` 명령으로 낡은 캐시를 강제 파기.
- 해결 2 (영구 방지): 데스크톱 앱(Tauri) 환경에서는 로컬 파일을 직접 읽으므로 PWA 캐시가 불필요하다. `dashboard/src/main.tsx`에서 `__TAURI_INTERNALS__` 존재 시 `registerSW`를 건너뛰도록 구조를 개선했다.

## 11. 모바일 dev 배포 컴파일 회귀 hotfix

`make deploy-dev`가 `DocumentListScreen.kt`의 `Modifier.size()` 확장 import 누락으로 `:shared:compileDebugKotlinAndroid` 단계에서 실패했다. `androidx.compose.foundation.layout.size` import를 복구해 최소 수정으로 컴파일 회귀를 해소했다.

실제 배포 재시도로 dev 빌드번호를 29까지 올렸고 Firebase App Distribution 업로드를 완료했다.

검증: `:shared:compileDebugKotlinAndroid`, `:shared:testDebugUnitTest`, `:androidApp:assembleDevDebug`, `make deploy-dev` — 모두 통과. Fastlane `assembledevDebug`와 `firebase_app_distribution` 성공.

## 12. Python 3.14 전환 + mcp<2.0 pin

`scripts/.venv`의 python 심링크가 `/Users/jaekanglee/miniconda3/bin/python3`을 가리켰는데 miniconda 제거로 끊겨 새 프로세스 실행이 불가했다. 실행 중이던 API/MCP/Dashboard는 이미 로드된 상태라 살아있어 증상이 늦게 드러났다.

- **venv 재생성**: `uv venv --python 3.14` + `-r requirements.txt -e scripts` — Python 3.14.2 기준
- **mcp pin**: `mcp>=1.12` → `mcp>=1.12,<2.0`. mcp 2.0.0이 `mcp.server.fastmcp` 모듈을 제거해 `raven/mcp/cli.py`, `raven/desktop/runtime.py`, MCP 테스트 2건이 깨졌다 (ADR v0.6.0에서 예견된 pin 리스크 — 신규 설치가 2.0.0을 받는 순간 파이썬 버전과 무관하게 발생)

검증: pytest 771 passed / 1 skipped (3.14.2), API 8765 → 200, MCP 8766 → initialize + 23개 도구 응답 (streamable HTTP는 세션 기반 — 빈 응답이 아니라 정상), Dashboard 5173 → 200.

## 13. 데스크톱 앱 "하얀 화면" 근본 원인 수정 — `custom-protocol` 피처 누락

`make desktop-install`로 설치한 Raven.app이 열리지만 빈 하얀 화면만 표시되던 문제의 근본 원인을 찾아 수정했다. 기존 §10(SW 캐시)은 빌드 실패 시의 2차 요인이었고, 실제 원인은 **릴리스 바이너리에 프론트엔드 에셋이 0개 임베드**된 것이었다.

- **원인**: tauri 2.6.3+ 코드젠은 `custom-protocol` 피처가 없으면 `dev = cfg!(not(feature = "custom-protocol"))` 판정으로 **dev 모드**로 동작한다. dev 모드 + `devUrl` 존재 시 `EmbeddedAssets::default()`가 선택되어 프론트엔드 에셋이 전혀 임베드되지 않는다. 웹뷰는 index.html조차 받지 못해 빈 화면. tauri 업그레이드(Jul 23 이후)로 이 게이트가 생겨 모든 데스크톱 릴리스 빌드가 조용히 깨져 있었다.
- **증거**: 정상 바이너리 대비 `assets/` 키 0개, `tauri-codegen-assets` 산출물 0개, "Raven Dashboard" 타이틀 문자열 부재. 동일 번들은 일반 브라우저에서 정상 렌더 (셸 문제 배제).
- **수정**: `desktop/src-tauri/Cargo.toml`의 `tauri` features에 `custom-protocol` 추가 (1줄).

검증: 바이너리 에셋 키 25개 + `tauri-codegen-assets` 784파일 임베드 확인 (14.2MB → 15.0MB); `make desktop-install` 재설치 후 앱 실행 — 대시보드 전체 렌더 + 번들 Python Core 연동으로 vault 실데이터 로드 확인 (AX 트리 검증).
## 14. 설치본 CLI ↔ MCP 스키마 불일치 수정 — `~/.local/bin/raven` 재배포 + drift 가드 (톡머리 vault 운영자 보고)

톡머리(talkmmury) vault 운영자가 보고: `~/.local/bin/raven build`로 빌드한 vault를 MCP(`raven.mcp.cli`, 8766)로 조회하면 `no such column: contested` / `no such table: pages_fts`로 실패.

**근본 원인 (실측)**:
- `~/.local/bin/raven`은 2026-07-01자 **레거시 standalone 스크립트** (21KB, 소스 트리와 무관) — 자체 구버전 스키마(`pages`에 `contested` 없음, `tags(name,count)` 집계형, `pages_fts` 없음)로 wiki.db를 생성
- 소스 트리 v0.7.182 (SCHEMA v2.4) MCP는 `pages.contested` + `pages_fts`를 기대 → 구버전 DB를 못 읽음
- `raven.core.db.connect()`는 v0.7.119부터 `db_schema_drift()` 가드로 자동 재빌드하지만, **MCP read 경로(`raven/mcp/db.py get_db()`)는 raw connect라 가드가 없었다** — MCP만 조용히 깨지는 구멍

**수정 (surgical)**:
- **설치본 동기화**: `~/.local/bin/raven`을 소스 트리 CLI(`python -m raven.cli`)로 위임하는 thin wrapper로 교체 (`RAVEN_REPO` env 지원, 레거시는 `~/.local/bin/raven.standalone-legacy.bak`로 보존). 이후 build는 항상 최신 스키마 생성
- **버전 표기**: CLI에 `--version`/`-V` 추가 — SOT(`raven/__init__.py __version__`) 출력. `invoke_without_command=True`로 root 옵션이 서브커맨드 없이 동작 (Typer 0.27.1 동작 확인)
- **build drift 감지**: `raven/core/db.py build_db()`가 구버전 스키마 wiki.db를 감지하면 명시적 경고 후 재구축 (기존 unlink+재생성은 유지)
- **drift 검사 보강**: `db_schema_drift()`에 `contested` 컬럼 체크 추가 (MCP가 읽는 정확한 컬럼 회귀 가드)
- **MCP read 가드**: `raven/mcp/db.py get_db()`가 drift 감지 시 raw SQLite 에러 대신 `raven build --vault <name>` 힌트를 포함한 명확한 에러 (read-only 계층이라 auto-rebuild ❌ — MCP의 rebuild 도구는 명시 호출 유지)

**검증**:
- 신규 테스트 9건 (`test_cli_version.py` 3, `test_mcp_schema_drift.py` 3, `test_db_schema_drift_contested.py` 3) + 관련 그룹 107 passed
- `~/.local/bin/raven --version` → `raven 0.7.182`, help 유지
- talkmmury 재빌드 후 `.schema pages`에 `contested` + `pages_fts` 확인, MCP `wiki_get_page`/`wiki_search` 정상 동작

## 15. 데스크톱 업데이트 진행 상황 시각화 — 무반응 버튼 해소

관리 → 업데이트 확인 → "지금 업데이트 및 재실행"을 눌러도 UI가 수십 초간 아무 반응이 없었다. 근본 원인은 `downloadAndInstall()`을 **진행 콜백 없이** 호출한 것 — 수십 MB 다운로드가 끝날 때까지 버튼만 disabled였고 화면엔 변화가 없어 눌렸는지조차 알 수 없었다. 덤으로 설치 직전 `check()`를 한 번 더 호출해 확인 단계에서 얻은 handle을 버리고 있었다.

- **`useAppUpdater`** (신규): 확인→다운로드→설치→재시작 상태 기계. `Started`/`Progress`/`Finished` 이벤트로 바이트·%·속도·ETA를 계산한다. 진행률 state는 80ms throttle — Progress는 청크마다 오므로 그대로 setState하면 초당 수백 번 리렌더된다. 확인 단계 handle을 붙들어 중복 `check()` 제거
- **`ProgressBar`** (신규, `ui/`): 공통 진행률 바. `value=null`이면 불확정 왕복 모드, `role="progressbar"` + `aria-valuenow`
- **`UpdatePanel`** (신규): 상태 헤더(스피너+문구) / 진행률 바 / `12.4 MB / 19.3 MB · 2.1 MB/s · 약 3초 남음` / 3단계 레일(다운로드→설치→재시작) / 버전 칩 `v0.2.0 → v0.3.0`. 우하단 토스트(`UpdateChecker`)와 관리 화면(`VaultManage`)이 같은 몸통을 공유한다 (§13.1)
- **`globals.css`**: `.progress-bar-*` / `.update-panel-*` + 키프레임, `prefers-reduced-motion` 대응. 색은 전부 토큰, 인라인 style은 구조 배치만 (§13.2)
- **덤**: `@keyframes spin` 추가 — `SearchPage`가 정의도 없이 `animation: spin`을 써서 스피너가 돌지 않던 것을 함께 해결

검증: 신규 테스트 12건 (상태 전이 / handle 재사용 / 총량 미제공 시 불확정 / 실패 메시지 보존 / 패널 렌더), vitest 전체 통과, `tsc -b` 0 에러, 라이트·다크 6개 상태 브라우저 렌더 확인. 커밋 `a9402c1`.

## 16. vault 문서 내보내기 — Markdown 파일 저장 + PDF(인쇄)

공유 팝오버에 "파일로 내보내기" 섹션을 추가했다. 그전까지는 내부망/Tailscale 링크 복사만 가능해서 **링크가 닿지 않는 상대에게 문서를 보낼 방법이 없었다**. PDF는 라이브러리 없이 인쇄 대화상자 방식으로 간다 (사용자 결정, AGENTS.md §10 의존성 승인).

### API

- `GET /api/vaults/{name}/pages/{slug}/export.md` — vault 원본 `.md` 그대로 (frontmatter 포함 → 다른 vault·Obsidian으로 되돌릴 수 있다). `?frontmatter=false`면 본문만
- Content-Disposition은 한글 파일명을 RFC 5987 `filename*`로 전달하고 ascii fallback을 함께 준다. 원격 host(다른 origin) fetch용으로 `Access-Control-Expose-Headers`에 노출
- **`{slug:path}` catch-all보다 먼저 등록**해야 한다 — FastAPI는 등록 순서대로 매칭하므로 뒤에 두면 catch-all이 `a/b/export.md`를 slug로 삼아 404가 난다. 등록 순서 회귀 가드 테스트 포함
- `_page_file_or_404` 추출: `get_page`가 갖고 있던 옛 slug fuzzy fallback을 `export.md`와 공유
- `_strip_frontmatter_block` 신설: `_split_fm`은 파싱용이라 body를 `strip("\n")`해 원본 끝 개행이 사라진다 — 파일로 내보낼 때는 본문 바이트를 보존해야 한다

### Dashboard

- **`pageExport`** (신규): `export.md` fetch → 파일 저장, 그리고 렌더된 본문을 **격리 iframe**에 옮겨 담고 A4 인쇄 스타일시트를 붙여 `window.print()` 호출
- 인쇄 본문은 마크다운을 다시 파싱하지 않고 view mode 렌더 노드의 `innerHTML`을 쓴다 → 화면과 종이가 일치. 편집 모드에는 본문 노드가 없어 PDF 버튼을 감춘다. heading anchor(`.anchor`/`.octicon`)는 종이에서 숨김
- 인쇄 머리글: 제목 + 분류/태그/작성/수정 + `vault / slug` 출처 한 줄
- 팝오버 배치 수정: 섹션이 붙어 길어지면서 뷰포트 아래로 잘려 PDF 버튼이 안 보였다 — 아래 공간이 부족하면 트리거 위로 뒤집고, 그래도 넘치면 `maxHeight` + 내부 스크롤

### 데스크톱에서 Blob 다운로드가 조용히 취소되던 문제

브라우저에서 통하는 `Blob` + `<a download>` 저장이 **데스크톱 앱에서는 아무 일도 하지 않는다**. wry 0.55.1 `src/wkwebview/navigation.rs`의 `navigation_policy`가 다운로드 내비게이션(`shouldPerformDownload`)을 만나면 `has_download_handler`가 false일 때 `WKNavigationActionPolicy::Cancel`을 돌려준다. 그 플래그는 웹뷰 빌더에 `on_download` 훅을 건 경우에만 true가 되는데(`tauri-runtime-wry` 2.11.4 `lib.rs:5010` — `pending.download_handler`가 `Some`일 때만 `with_download_started_handler` 등록), Raven의 창은 `tauri.conf.json`이 만들어 빌더 훅을 걸 수 없다.

→ **`save_download_file` 커맨드** 신설 (신규 의존성 ❌ — `dirs`는 이미 쓰고 있다). `~/Downloads`에 쓰고 저장 경로를 돌려주며, 프론트는 그 경로를 "✅ 저장됨: …"으로 보여준다. 웹뷰가 준 파일명은 신뢰하지 않고 경로 성분을 버리며, 같은 이름이 있으면 덮어쓰지 않고 번호를 붙인다 (wry 기본 다운로드 동작과 동일). `permissions/default.toml` + `capabilities/default.json`에 `allow-save-download-file` 등록.

### 검증

- pytest 8건 (원본 일치 / 한글 헤더 / `frontmatter=false` / fuzzy slug / 404 / 경로 탈출 / 등록 순서 / `get_page` 회귀)
- vitest 12건 (URL 인코딩 / 파일명 / 인쇄문서 구성 / escape / iframe 수명 / 팝오버 두 버튼 / md 저장 / pdf 본문 전달 / PDF 버튼 숨김 / Tauri 커맨드 경로 / 브라우저 Blob 경로 / 저장 경로 전달)
- cargo test 4건 (한글 파일명 보존 / 경로 탈출 차단 / 덮어쓰기 방지 / 잘못된 이름 거부) — 크레이트 전체 11 passed
- pytest 829 passed, vitest 51 files 284 passed, `tsc -b` 0 에러, `cargo check` 0 에러, build 성공
- 로컬 스택에서 `export.md` 실응답(헤더 + 원본 본문) 및 팝오버·인쇄문서 렌더 확인

README endpoint 카운트 65 → 66 (`doc_count_guards`가 먼저 잡아줌).

**남은 것**: 데스크톱 `.md` 저장은 코드 경로로만 검증했다 (Tauri 웹뷰는 Chrome 자동화로 클릭할 수 없다) — 실제 앱에서 한 번 눌러볼 것. PDF는 인쇄 대화상자에서 "PDF로 저장"을 사용자가 골라야 한다.

## 17. mcp 버전 정리 — venv 1.29.0 고착 해소 + 2.x 에러 마스킹 회귀 수정

MCP 테스트 10건(실패 8 + 수집 에러 2)이 깨진 채였다. 표면 원인은 "venv의 mcp가 1.29.0인데 코드는 `mcp.server.mcpserver`(2.x API)를 import"였지만, **왜 갱신이 안 됐는지**가 진짜 문제였다.

### 근본 원인 — 의존성 동기화 명령이 아예 돌지 못했다

venv가 `uv venv`로 만들어져 있었고(`pyvenv.cfg`에 `uv = 0.9.18`), `uv venv`는 pip를 넣지 않는다. 그런데 Makefile은 pip 존재로 venv 유무를 판정했다:

- `venv-check`: `test -x $(PIP)` 실패 → `up`/`test` 등 **모든 타깃이 "run 'make install' first"로 차단**
- `install`: 같은 판정으로 `rm -rf $(VENV)` 후 `python3 -m venv` 재생성을 시도 — 멀쩡한 3.14 venv를 지우려 드는 동작이라 사실상 아무도 실행하지 못했다

그래서 `requirements.txt`가 `mcp>=2.0,<3.0`을 가리키는데도 venv는 1.29.0에 멈춰 있었고, 아무도 모르고 있었다. (PyPI 확인: mcp 2.x는 실재하며 최신 2.2.0 — 코드와 핀이 옳고 venv만 낡았다.)

- **Makefile 수정**: venv 판정을 `$(PY)`(python 실행 파일) 기준으로 바꾸고, `uv`가 있으면 `uv pip`로, 없으면 `pip`로 동기화한다. **멀쩡한 venv는 절대 지우지 않는다**
- **`make deps-check` + `scripts/check-deps.py` 신설**: `requirements.txt` 핀과 실제 설치본을 대조한다. 이번 drift(`mcp: 설치 1.29.0 ≠ 요구 <3.0,>=2.0`)를 재현해 실제로 잡는 것까지 역검증
- venv 동기화: mcp 1.29.0 → 2.2.0 (+ `mcp-types`, `httpx2`, `httpcore2`, `opentelemetry-api`, `truststore`). 충돌 없음

### 함께 드러난 실제 회귀 — mcp 2.x가 에러 메시지를 마스킹한다

버전만 올리자 2건이 남았는데, 테스트 문제가 아니라 **런타임 동작 회귀**였다. mcp 2.x는 도구에서 올라온 예외를 두 갈래로 나눈다 (`mcp/server/mcpserver/tools/base.py`):

- `ToolError` → 메시지가 그대로 클라이언트에 전달
- 그 외 모든 예외 → `UnexpectedToolError`로 감싸이고 **`Error executing tool <name>`만 남는다**

Raven의 MCP 실패 메시지는 전부 *에이전트가 읽고 스스로 고치라고* 쓴 안내다 — "사용 가능한 vault 목록", "허용된 체크 id", "`raven build --vault X`로 재빌드하라"(§14에서 일부러 추가한 것), "`--admin`이 필요하다". 평범한 `ValueError`/`RuntimeError`로 던지고 있어 **그 안내가 통째로 사라지고 있었다**. mcp 1.x에서는 새어나왔기 때문에 2.x로 올리기 전까지 드러나지 않았다.

- **`raven/mcp/errors.py` 신설**: `VaultNotFound` / `InvalidToolArgument` / `ToolPermissionDenied` / `VaultDbMissing` / `VaultDbSchemaDrift`
- **다중상속으로 기존 계약 보존**: 타입을 갈아치우지 않고 `ToolError`를 *더한다* (`VaultDbSchemaDrift(ToolError, RuntimeError)` 식). mcp 1.x 시절 `except ValueError`/`except PermissionError_` 호출부(`tools/stale.py`)와 회귀 테스트(`test_mcp_schema_drift.py`)가 그대로 동작한다
- 적용: `tools/__init__.py`(vault 미발견, 권한), `tools/semantic_lint.py`(허용목록 밖 체크 id), `db.py`(wiki.db 부재, 스키마 drift)

### 재발 방지

`tests/test_mcp_tool_error_surfacing.py` 5건 — 안내 문구가 클라이언트에 실제로 도달하는지(`UnexpectedToolError`가 아닌지), 기존 예외 타입 계약이 유지되는지, 그리고 **AST로 `raven/mcp/` 안의 모든 `raise`를 훑어 `ToolError` 계열인지** 검사한다. 신규 도구가 평범한 예외를 던지면 런타임이 아니라 이 테스트에서 먼저 실패한다.

### 검증

`make test` → **853 passed, 1 skipped, 0 failed** (작업 전: 829 passed / 8 failed / 수집 에러 2). `make venv-check`·`make test`가 다시 동작한다 — 이전에는 둘 다 "run 'make install' first"로 막혀 있었다.

## 18. 그래프 — 살아 있는 물리 + Obsidian식 작은 점 노드

데스크톱 그래프 탭이 "정적인 2D 그림"처럼 보였다. `force-graph`(d3-force + 캔버스, Obsidian 그래프와 같은 계열)를 쓰면서도 시뮬레이션을 사실상 꺼두고 있었기 때문이다.

### 원인

- **전 노드 고정**: force 모드가 서버 ForceAtlas 좌표를 모든 노드의 `fx/fy`로 박았다. 드래그해도 이웃이 따라오지 않았다
- `cooldownTime(600)` — 0.6초 만에 정지
- 노드가 반지름 14~36의 큰 원 + centrality 비례 흰 테두리 → 버튼처럼 보였고, 넓게 흩어진 좌표(×2.8) 사이로 긴 직선 거미줄만 도드라졌다

### 변경

- **API**: `.graph_positions.json`에 저장된 노드에만 `pinned: true` (`GET /api/vaults/{name}/graph` 두 분기 모두). 리셋(`DELETE .../graph/positions`)하면 사라진다
- **드래그 = Obsidian식 (사용자 결정)**: 놓으면 풀어서 전체가 다시 자리를 잡는다. **드래그 좌표 저장은 중단** — `GraphPage.persistPositions`와 `GraphCanvas.onPositionsChange` prop 제거. 이미 저장된 좌표는 pinned로 계속 고정되고, 드래그하면 이번 세션에서만 풀린다. `POST .../graph/positions` endpoint는 남아 있지만 dashboard는 더 이상 호출하지 않는다
- **`seedForceNodes`** (`dashboard/src/lib/graph/render.ts`, 순수 함수): 서버 pinned만 고정, 나머지는 ForceAtlas 좌표를 출발점으로만 쓴다. 서버 좌표가 직전과 같은 노드는 직전 프레임 위치를 이어받아 필터·재조회 때 튀지 않고, 서버 좌표가 바뀐 노드(리셋)는 새 좌표에서 출발한다 — 처음 구현은 직전 위치를 무조건 이어받아 **리셋이 화면에 아무 효과가 없었다** (자체 발견, 테스트로 고정)
- **물리**: 원점 중력 `0.03` + 무게중심 복원(recenter) + charge `-200`(distanceMax 800) + link distance `40` + **link strength `0.5` 균일** + velocity decay `0.3` + cooldown 8초. 좌표 배율 2.8 → 0.8로 평형 크기에 맞춰 첫 로드 때 폭발/수축 없이 자리만 잡는다
  - 링크 장력: d3 기본값 `1/min(양 끝 연결 수)`는 링크 553개 vault에서 링크 하나가 ~1/20 힘이라, 드래그해도 이웃이 안 따라오고 선만 늘어났다 (프레임 캡처로 확인)
  - recenter: d3 link force는 연결 수가 적은 끝을 더 움직여 운동량이 보존되지 않는다. 장력을 균일하게 올리자 그 치우침이 쌓여(순 속도 합 -1657) 그래프 전체가 원점에서 (-299, 98)까지 흘러갔다. `d3.forceCenter`처럼 매 tick 무게중심을 원점으로 되돌린다 → (0, 0) 유지 측정
- **노드 모양**: `nodeSize` = `3 + √w·1.6` (leaf 4.6, w=24 → 10.8), 테두리는 zoom 무관 1px 머리카락 윤곽, 포커스 노드만 같은 색 glow(`shadowBlur`) + 얇은 링. centrality 비례 흰 테두리 제거
- **라벨**: zoom ≥ 2.5면 모든 라벨 표시 (겹침은 기존 라벨 점유 격자가 거름)
- **끝점 없는 edge 제거 (기존 버그)**: API edge 중 노드 목록에 없는 문서를 가리키는 것이 있으면 force-graph가 `node not found`로 **링크 전체를 버렸다** — 전체보기 모달에서 선이 하나도 안 그려지고 있었다. 링크 id(`e<원래 인덱스>`)는 하이라이트 계산과 맞물리므로 부여 후에 거른다

### 검증

- pytest: `test_graph_marks_only_user_positioned_nodes_as_pinned` 신규(RED→GREEN), 849 passed (MCP 1건은 아래 별건)
- vitest: 290 passed — `seedForceNodes` 5건(리셋 후 재출발 포함), 확대 라벨 1건 신규. `nodeSize`/hit 테스트는 새 크기 스펙으로 갱신
- 브라우저(vault 사본 + 현재 코드, 측정용 임시 hook은 제거): 드래그 시 군집이 따라오고 놓으면 전체 재배치, 무게중심 (0, 0) 유지, hover 시 비이웃 흐림 + glow, 다크/라이트, 전체보기 모달(동심원/force) 선 복구·`PAGEERR` 0건

### 별건 (미처리)

- 첫 로드 zoomToFit이 그래프보다 크게 잡혀 위쪽이 잘린다 (변경 전에도 동일, 72%) — "맞춤" 버튼으로는 정상
- 메인 그래프에는 `layoutMode`가 전달되지 않는다 — 레이아웃 모드 선택은 전체보기 모달에만 적용 (`GraphPage.tsx`)
- venv mcp가 2.0.0 — `UnexpectedToolError` 부재로 `test_mcp_tool_error_surfacing.py` 수집 에러. 핀 `mcp>=2.0`이 이를 허용해 `deps-check`도 통과한다

## 19. `make desktop-dev`가 dev 서버 대신 낡은 dist를 띄우던 문제 — §13 회귀

§18 그래프 변경을 `make desktop-dev`에서 확인하려 했으나 화면이 바뀌지 않았다. webview에서 vite(5173)로 들어온 연결이 0이었다.

- **원인**: §13이 하얀 화면을 고치려고 `tauri`의 `custom-protocol` 피처를 `[dependencies]`에 **항상** 켰다. 이 피처가 켜지면 dev 빌드도 `dashboard/dist`를 임베드하고 `devUrl`을 무시한다. 그래서 dev 창은 마지막으로 `npm run build`한 dist(9/16)를 보여주고 있었고, HMR도 없었다. §13 이후 모든 프론트 변경이 dev 창에 보이지 않았다
- **수정**: 크레이트 피처 `custom-protocol = ["tauri/custom-protocol"]`로 옮기고, 릴리스 빌드가 명시적으로 켠다 — `Makefile` `desktop-build`, `.github/workflows/desktop-release.yml`의 `cargo build --release --features custom-protocol`. (`tauri build` CLI를 쓰지 않고 `cargo build`를 직접 부르기 때문에 필요)
- **검증** (`target/*/build/raven-desktop-*/out/tauri-codegen-assets` 개수 — 바이너리 문자열 검사는 에셋이 압축돼 판별 불가였다):
  - 릴리스, 기존 설정: 30 / 릴리스, 새 설정: **30** → §13 하얀 화면 재발 없음
  - dev, 새 설정: **0** → `devUrl`(vite) 사용
  - 수정 전 dev(실행 중이던 앱): 52 → 낡은 dist 임베드 확인

## 20. 그래프 — 별자리 톤 (목차 바큇살 제거 + 옅은 선 + 허브만 빛남)

사용자: "Obsidian은 신경망·별자리처럼 보이는데". 원인은 세 가지였다.

- **목차 페이지가 거미줄을 만들었다**: 연결 수 1·2위가 `index_builder`의 자동 목차(`_index/journal` 81, `_index/concept` 54). 목차 7개가 **링크 595개 중 172개(29%)** — 한 점에서 수십 개 선이 뻗는 바큇살이 화면을 덮었다
- 선이 점보다 도드라졌고, 타입 색 네 가지가 같은 비중이라 "분류 차트"로 읽혔다

### 변경

- **`isIndexPage`** (`render.ts`, 순수 함수): `content/index`·`content/_index/*` — 서버 `advice.py`/`db.py`가 목차를 빼는 규칙과 동일. `__canonical/*`는 목차가 아니다
- **목차 링크**: 선 alpha 0.04·폭 0.5, 물리 장력 `0.2` (일반 `0.5`). 0.03은 목차에만 걸린 저널이 멀리 흩어졌고(맞춤 26%), 0.5는 다시 뭉쳤다 — 4단계 스크린샷 비교로 결정
- **선**: `--graph-edge` 토큰 alpha 절반(테마 6곳), 폭 1.05→0.6(의미 관계 1.5→1.0). 포커스 중 물러나는 선 0.1→0.06 (라이트 테마에서 일반 선 0.11보다 진해지는 역전 방지)
- **노드**: 목차 링크를 뺀 실제 연결 수 상위 4%(최소 6)를 허브로 — 허브만 원색 + 은은한 glow, 나머지는 타입 색을 `--graph-node-neutral`(신규 토큰)과 50% 섞어 차분하게. 목차 노드 자체도 45% 투명
- **`mixHex`** (`render.ts`): 두 #rrggbb 혼합

### 함께 고친 기존 버그 — 첫 로드 맞춤이 dev에서 한 번도 실행되지 않았다

그래프 탭을 열면 항상 72%(force-graph 기본값)로 일부만 보였다. 로그로 추적한 결과 React StrictMode의 dev 재마운트가 원인이었다: 맞춤 timer를 예약한 직후 가짜 unmount가 timer를 취소하고, 재마운트된 effect는 `prevNodeCountRef`가 살아남아 "첫 로드"가 아니라고 보고 다시 예약하지 않았다. 게다가 데이터 effect가 첫 로드 직후 80ms 안에 3회 재실행되며 매번 cleanup에서 timer를 취소했다.

- 새 그래프 인스턴스 생성 시 `prevNodeCountRef = 0` — 새 인스턴스는 카메라를 맞춘 적이 없다
- 초기 맞춤 timer 취소는 데이터 effect cleanup이 아니라 언마운트(인스턴스 effect cleanup)와 사용자 클릭만
- 물리가 첫 1~2초 동안 평형 크기로 펴지므로 1.5초 뒤 한 번 더 맞춤 (그 사이 노드 클릭 시 건너뜀)

### 검증

vitest 292 passed (`isIndexPage`·`mixHex` 신규). 브라우저(vault 사본): 다크/라이트 × 기본/확대 — 첫 로드에 전체가 화면에 맞음(38%), 허브 glow, 목차 바큇살 사라짐.

## 21. 그래프 탭 — 로드 성능 + 기능 정리

사용자: "그래프탭의 로드 성능이 구려. 불필요한거 제거하고, 개선할거 개선하고 최적화하자".

### 로드 성능 (169문서 vault, `GET /graph`)

| | 전 | 후 |
|---|---|---|
| 첫 요청 | 3.6s | **0.46s** |
| 문서 수정 직후 | **7.5s** | **1.38s** |
| 캐시 | 0.02s | 0.015s |

프로파일 결과 두 비용이 절반씩이었다.

- **`db.connect()`의 지연 재빌드가 전체 lint를 돌렸다** — `build_db(vault)`의 기본값 `run_lint=True`. 결과는 버려지고(`run_all`은 부작용 없음), 중복 제목 검사(O(n²), 13,695쌍)가 3.5초. 다른 지연 재빌드 경로(MCP read / index_builder / CLI)는 이미 `run_lint=False`였다 → `connect()`도 `run_lint=False`. 회귀 테스트 `test_connect_rebuilds_stale_db_without_running_lint`
- **서버 ForceAtlas 500회 반복(~2.8s)** — §18 이후 클라이언트가 살아 있는 물리로 자리를 잡으므로 서버 좌표는 출발점일 뿐. 그래프 탭은 `?iterations=60`(~0.3s)을 요청한다. API 기본값(500)은 그대로 — 다른 호출자 계약 보존
- 남은 1.38s는 DB 재빌드 자체(legacy build 스크립트 subprocess + index 재생성)

### 기능 정리 (사용자 결정)

- **레이아웃 모드 5종 → Force만**: 메인 그래프에는 애초에 전달되지 않고 전체보기 모달에만 적용되던 선택지. 동심원/도메인/타임라인/레이어 배치·HUD 코드와 전용 헬퍼(`computeLayeredLayout`, `computeTimelineLayout/Grid`, `computeLayeredAxis`, `computeCommunityLabels`, `TIMELINE_TYPE_LANES`, 커뮤니티 팔레트)와 그 테스트 13건 제거
- **필터를 캔버스 위 한 줄 툴바로**: 검색 + 타입 범례 칩(색 점 + 개수, 클릭 = 필터 — 그동안 색 범례가 없었다) + 관계 칩. 아래 큰 카드와 모바일용 중복 `<details>` 제거 → 그래프가 남은 높이를 모두 쓴다 (캔버스 486→588px, 1400×900)
- **관계 칩은 실제 존재하는 관계만, 의미 관계가 있을 때만**: hub-control-room은 링크 592 / 의미 관계 3 — 여섯 토글이 늘 켜져만 있었다
- **이웃 깊이 → 상세 패널**: 문서를 선택했을 때만 의미가 있다
- **캔버스 "리셋" 버튼**: 드래그 좌표를 더 이상 저장하지 않으므로 예전 저장 좌표(pinned)가 있을 때만 표시
- **폴더 그룹 HUD 라벨**: 폴더가 하나뿐이면 그래프 한가운데 같은 라벨 하나("본문 지식 (content)")만 떠서 숨긴다
- 공통 컴포넌트: `FilterChip` 신규, `TextField`에 `hideLabel`(스크린리더 전용 라벨)

### 함께 고친 것

- 캔버스 기본 높이(창 높이)가 워크스페이스 행을 늘려 페이지 스크롤이 생기던 문제 — 셸을 페이지 높이에 고정하고 행을 `minmax(0, 1fr)`로
- 모바일에서 캔버스 버튼 라벨이 "맞/춤"처럼 줄바꿈되던 문제 (`white-space: nowrap`)
- 쓰지 않게 된 컨트롤 CSS 규칙 28개 제거
- **타입 칩을 눌러도 한두 개만 보이던 문제** (사용자 보고: "80개 있어도 하나만 나온다"): 문서가 선택된 채로 필터를 바꾸면 포커스 모드가 유지돼, 서로 거의 연결되지 않은 일지 80개 중 선택 노드와 이웃만 밝고 나머지가 사라졌다. 포커스 밖 노드 투명도가 0.28 × 깊이 밖 0.72 × freshness(0.32~1)로 **0.065**까지 내려가 별자리 톤(중립색) 위에서 보이지 않았던 것
  - `computeNodeAlpha` (순수 함수로 추출): 물러난 노드도 최소 0.2 — 테스트 3건
  - 타입 칩 클릭 시 문서 선택 해제 — 그 타입 전체를 보려는 의도

### 검증

pytest 850 passed (MCP 1건은 venv mcp 2.0.0 별건). vitest 279 passed (삭제 헬퍼 테스트 13건 제거). 브라우저: 데스크톱/모바일 레이아웃, 타입 칩 필터, 노드 선택 시 이웃 깊이, 페이지 스크롤 없음(측정).

### 별건 (미처리)

- `raven/core/recommend.py:45`도 DB가 없을 때 lint 포함 빌드 후 결과를 버린다 (드문 경로)

## 22. 남은 후보 정리 — 설치본 그래프 500 · mcp 2.0.0 · 재방문 즉시 표시 · 필터 자동 맞춤

### 설치본 그래프 탭 500 — 번들에 `python-frontmatter` 부재 + 설치 스크립트 고장

- **원인**: 설치된 Raven.app(9/22 기동)의 번들 Python에 `python-frontmatter`가 없어 `GET /graph`가 `ModuleNotFoundError: No module named 'frontmatter'`로 500 (번들 코드를 vault 사본에 직접 돌려 재현). `requirements.txt`에는 8/24부터 있었고 로컬 번들(9/16)에도 있었다 — 설치본은 다른 빌드(업데이터 경유로 추정)였다
- **로컬 재설치가 안 되던 이유**: `scripts/install-desktop.sh`가 DMG 이름을 `Raven_0.1.0_aarch64.dmg`로 하드코딩 — 버전을 올린 뒤로 빌드가 끝나도 "DMG not found"로 멈췄다. `make-dmg.sh`와 같은 출처(`tauri.conf.json`)에서 버전을 읽도록 수정
- `make desktop-install`로 현재 소스 재설치 → 그래프 200(0.50s), 번들 frontmatter 1.3.0 / mcp 2.2.0, MCP 8766 기동, 바이너리 임베드 에셋 이름이 현재 dist와 일치(새 UI 반영) 확인. 서명은 ad-hoc(`codesign --sign -`)이라 업데이터 서명 키 불필요

### venv mcp 2.0.0 — `test_mcp_tool_error_surfacing.py` 수집 에러

- `UnexpectedToolError`는 mcp **2.1.0**부터 있다 (2.1.0/2.2.0 wheel 대조). 핀 `mcp>=2.0`이 2.0.0을 허용해 `deps-check`도 통과했다
- 핀 `mcp>=2.1,<3.0`으로 상향 → `deps-check`가 이제 drift를 잡는다(검증). venv 2.2.0 동기화(설치본과 동일). 핀 가드 테스트(`test_v0_7_184_mcp_pin_single_source`) 하한 갱신

### 그래프 재방문 즉시 표시

문서 수정 직후 응답(~1.4s)의 대부분은 DB 전체 재빌드(169문서 FTS 색인 포함, ~0.8s)다. in-process 전환·pragma 조정은 ~0.2s 이득에 반쯤 쓰인 DB 위험이 있어 보류 — 근본 해결은 변경 파일만 다시 색인하는 증분 빌드(아키텍처 변경, 후속).

- 대신 체감 대기를 없앴다: vault별 마지막 그래프를 탭 세션 메모리에 두고, 재방문 시 즉시 그린 뒤 백그라운드에서 새로 받는다. 재방문 → 캔버스 79ms, 스피너 0. 캐시가 있을 때의 재조회 실패는 에러 대신 캐시 유지. 테스트 `GraphPage.cache.test.tsx`

### 타입 필터 변경 시 자동 맞춤

`GraphCanvas`에 `fitKey` prop — 값이 바뀌면 새 배치가 자리 잡은 뒤(1.5s) 화면을 맞춘다. 그래프 탭은 `fitKey={selectedType}`. 서로 연결이 적은 일지 80개가 넓게 퍼져 일부가 화면 밖에 남던 문제 — 전부 화면에 들어옴(34%) 확인. 검색 등 다른 필터 변경은 기존대로 카메라 보존

### `recommend.py` 중복 빌드

DB가 없을 때 `build_db(vault)`(lint 포함)를 부르고 결과를 버린 뒤 `connect()`가 또 확인했다. `connect()`가 이미 lint 없이 재빌드하므로 호출 제거. 테스트 `test_recommendations_build_missing_db_without_lint`

### 검증

pytest 856 passed (MCP 에러 표면화 테스트 포함 — 이번 세션 처음으로 전부 통과). vitest 283 passed.

## 23. vault 운영 지침 슬롯 + MCP 전달 (`wiki_get_policy`)

ADR `adr-2026-09-25-vault-policy-slot-and-mcp-delivery`의 2단계. 별도 정책 repo 방식은 clone·경로 변수·트리거 블록 설치가 필요했고, 설치하지 않으면 명시적 지시로만 운영됐다. 이제 MCP를 연결하는 것만으로 에이전트가 vault 소유자의 지침을 받는다.

- **자리**: `_meta/policy/VAULT-POLICY.md` (`raven.core.vault.VAULT_POLICY_RELPATH`). `_meta/agents/`가 아닌 이유 — 그 디렉터리가 있으면 `is_llm_wiki`가 켜진다. Raven은 이 파일을 만들지 않는다
- **전달**: read 도구 `wiki_get_policy(vault)` → `{path, content, modified}`. 파일이 없으면 `content: null`이며 오류가 아니고, 읽기가 파일을 만들지 않는다. 서버 `instructions`에 "큐레이션 전에 `wiki_get_policy`를 호출하라"는 한 줄을 추가했다 — `server_instructions()`로 모아 CLI와 데스크톱 런타임이 같은 문자열을 쓴다. 정책 본문은 instructions에 넣지 않는다(서버 시작 시 고정되는 문자열이라 편집이 반영되지 않는다)
- **색인 제외**: `_meta/`는 색인·lint 대상이라 정책이 페이지로 잡히면 type lint·그래프에 섞인다. `is_user_owned_instruction()`로 루트 지침 파일과 정책 디렉터리를 한 규칙으로 묶어 정식 빌더(`scripts/build_db.py`)·fallback 빌더(`_inline_build`)·lint 페이지 스캔(`_all_pages`) 세 곳에 적용 — 한 곳이라도 빠지면 lint #11 FS/DB parity가 오탐한다
- **쓰기 차단**: 추가 구현 없음. `contracts.write_page`가 `_meta/` 전체를 에이전트 쓰기 금지로 막는다. 회귀 가드로 고정
- 7/15에 제거한 bootstrap·guide·freshness 구조(`530fdbc`)를 반복하지 않는다 — 생성·동기화·버전 비교 없음, 읽어서 건네기만
- 도구 수 23 → 24 (README 수치 가드 `test_v0_7_178_doc_count_guards` 갱신), vault 주입용 `templates/agent/TOOLS.md`에 도구 설명 추가. 기존 vault의 TOOLS.md는 bootstrap 때 복사된 사본이라 자동으로 바뀌지 않는다

### 검증

`tests/test_vault_policy_slot.py` 8건 (RED 확인 후 GREEN). 전체 pytest는 아래 커밋 스냅샷 기준으로 별도 실행.

### 후속

3단계 REST + Dashboard 편집기, 4단계 policy lint, 5단계 기존 7개 vault 정책 이전 (vault별 승인).

## 24. wiki.db 증분 재빌드 — 기존 문서 내용만 바뀌면 그 페이지만 다시 색인

문서를 고칠 때마다 wiki.db를 통째로 다시 만들었다(169문서: 전체 파싱 + FTS 색인 ~0.8s). 대시보드 저장 직후 그래프·검색이 느리던 남은 원인.

### 전제 — 왜 안전한가

짧은 링크 보정(`resolve_short_slug`)은 **slug 집합에만** 의존한다(제목·별칭 미사용). 기존 문서의 내용만 바뀌면 다른 페이지의 링크 해석은 바뀌지 않는다. 그 전제가 깨지는 경우는 증분을 포기한다.

### 변경

- **스냅샷 표 `build_files(path, slug, mtime_ns, size)`**: 전체 빌드가 파일마다 기록 (stat을 읽기 *전에* — 빌드 중 바뀐 파일은 다음 증분이 다시 색인)
- **`scripts/build_db.py::update_db`**: 스냅샷과 디스크를 대조해 바뀐 페이지만 지웠다 다시 넣는다(태그·링크·관계·FTS) → 대상 보정 → 그래프 분석(0.08s, 전역이라 매번 전체). 한 트랜잭션, 실패 시 롤백. 다음 경우 **DB를 건드리지 않고 None → 전체 빌드**: DB/스냅샷 표 없음(예전 빌드), 문서 추가·삭제, slug 변경, 스캔 중 파일 소실
- 페이지 1장 INSERT(`_insert_page`)·대상 보정(`_resolve_pending_targets`)·분석(`_update_analytics`)을 전체/증분이 공유하도록 추출 — 로직 복제 없음
- `--incremental` CLI 플래그, `db.build_db(..., incremental=True)` → 결과 `mode` ("incremental" / "full")
- 사용처: `connect()`의 stale 재빌드, 목차 재생성 뒤 두 번째 빌드, MCP 쓰기 후 재빌드. `raven build`(CLI)는 그대로 전체
- **분석 입력 정렬**(`analytics.py`): Louvain community 번호가 "처음 등장한 순서"로 매겨져 행(rowid) 순서에 의존했다. 증분이 바뀐 페이지를 다시 넣으면 같은 파일 상태에서도 전체 빌드와 번호가 달라졌다(실 vault 169건 전부 — 군집 구성은 동일, 번호만). `ORDER BY slug` 등으로 결정적으로

### 검증

- `tests/test_db_incremental.py` 9건: 내용 수정 후 **증분 결과 = 새 전체 빌드**(모든 표 + FTS 검색), 변경 없음 no-op, 추가/삭제/slug 변경·스냅샷 없음 → 전체 빌드 폴백 + DB 불변, `mode` 보고, `connect()`가 증분 사용, 분석의 행 순서 독립성
- 실 vault 사본(169문서, 일반 3 + 목차 1 수정): pages/tags/links/relations/FTS/스냅샷 **전부 일치**, 검색 4개 질의 결과 일치. 증분 0.33s vs 전체 1.3~2.2s
- `GET /graph` 문서 수정 직후 (같은 방법 A/B, 5회): 전 1.18~1.64s(중앙 1.24) → 후 0.72~1.16s(중앙 0.86). 남은 시간은 서버 ForceAtlas 60회(~0.3s) + 분석·응답 조립
- pytest 873 passed

## 25. vault 운영 지침 REST — Dashboard 편집기의 백엔드

ADR `adr-2026-09-25-vault-policy-slot-and-mcp-delivery` 3단계의 백엔드. 사람이 지침을 읽고 쓰는 경로다(에이전트는 계속 MCP 읽기만).

- **`raven/core/policy.py`** — 읽기·쓰기 계약을 한곳에 둔다. MCP `wiki_get_policy`도 이제 여기의 `read_policy`를 호출한다(응답에 `precondition` 추가)
  - `write_policy`: 본문을 **그대로** 저장한다. 페이지처럼 frontmatter(title/type/updated)를 끼워 넣지 않는다 — 지침은 페이지가 아니다. 파일 lock + `atomic_write_text`, `log.md`에 create/update 기록
  - lost update 방지: `precondition_for_path` 토큰(페이지 PUT과 같은 sha256). `""`는 "아직 없다"는 단언이라, 이미 있는 지침을 새로 만들려 하면 거부된다
- **`GET /api/vaults/{name}/policy`** — `{vault, path, content, modified, precondition}`. 지침이 없으면 `content: null`과 함께 빈 양식 `template`을 준다. 읽기는 파일을 만들지 않는다
- **`PUT /api/vaults/{name}/policy`** — `{content, precondition?}`. 토큰이 어긋나면 409
- **빈 양식** `raven/core/templates/policy/VAULT-POLICY.md` — 질문만 있고 값이 없다(범위·문서 종류·저장 기준·승인이 필요한 행동). 운영 철학은 제품이 정하지 않는다는 ADR 경계. 데스크톱 번들은 `raven/` 전체를 복사하므로 포함된다
- README 엔드포인트 수 66 → 68

### 검증

`tests/test_vault_policy_api.py` 6건 (RED 확인 후 GREEN) — 빈 vault 읽기가 파일을 만들지 않음, 본문 그대로 저장, 낡은 토큰 409, 중복 생성 409, log create/update, 없는 vault 404. 전체 pytest 879 passed, 1 skipped.

## 26. 운영 지침 편집 화면 — Dashboard

ADR `adr-2026-09-25-vault-policy-slot-and-mcp-delivery` 3단계의 화면. 관리 페이지 vault 행의 **운영 지침** 버튼 → 전용 화면 `/vault/policy/:vault`.

- **보기/편집**: 지침을 Markdown으로 렌더하고, 편집을 누르면 textarea(`TextField multiline`)로 바뀐다. 저장 토스트 2400ms (Dashboard 규약)
- **빈 상태**: `EmptyState` + CTA 두 개 — **템플릿에서 시작**(서버가 준 빈 양식을 편집기에 채움) / **빈 문서로 시작**. 어느 쪽도 저장 전에는 파일을 만들지 않는다
- **충돌**: 읽은 시점의 `precondition`을 PUT에 싣는다. 409면 "다른 곳에서 먼저 저장됐습니다" 안내와 **새로 불러오기** 버튼을 띄우고, 내 초안은 지우지 않는다
- API 클라이언트 `getVaultPolicy` / `putVaultPolicy` + `PolicyConflictError`(409 식별용)
- 공통 컴포넌트(`PageHeader`·`EmptyState`·`TextField`·`Button`·`Toast`)와 CSS 토큰만 사용 — 새 공통 컴포넌트 없음

### 검증

`dashboard/tests/VaultPolicyPage.test.tsx` 4건 (RED 확인 후 GREEN) — 템플릿은 누를 때만 채움(저장 호출 없음), 새 지침은 `precondition: ""`, 기존 지침은 읽은 토큰, 409 시 초안 유지. `tsc -b --noEmit` 통과, vitest 287 passed / 1 skipped, `npm run build` 성공.

## 27. 그래프 레이아웃 캐시 + 행 순서 의존 제거 — 본문만 고친 편집은 레이아웃을 다시 계산하지 않는다

§24 증분 재빌드 뒤 문서 수정 직후 `GET /graph`(~0.72s)의 남은 절반이 서버 ForceAtlas 60회(~0.31s)였다. 본문만 고치면 노드·링크·가중치가 그대로라 같은 레이아웃을 매번 다시 계산하고 있었다.

### 변경

- **`raven/core/graph.py::forceatlas_layout` 메모이제이션**: 레이아웃은 결정적(random 없음)이라 입력 해시로 최근 8개를 기억해도 결과가 바뀌지 않는다. 기존 계산은 `_forceatlas_layout_uncached`로 이름만 바꿨다. 결과는 복사본 — 서버가 사용자 저장 좌표를 덮어써도 캐시 원본은 그대로
- **입력 정렬**: 같은 함수가 입력을 표준 순서(노드 id, 링크 (source, target), 링크 가중치는 짝을 유지한 채)로 정렬한 뒤 계산 — 좌표가 입력 순서에 의존하지 않는다

### 캐시를 붙이다 드러난 버그 — 본문만 고쳐도 그래프가 흔들렸다

캐시를 붙이자 본문만 고친 편집의 일부가 계속 빗나갔다. 입력을 비교해 보니 원인은 두 겹의 **DB 행 순서 의존**이었다 (§24의 analytics와 같은 부류). 증분 재빌드는 고친 페이지를 맨 뒤로 다시 넣어 행 순서를 바꾼다.

1. 노드·링크 **순서**가 바뀌어 레이아웃 좌표와 Louvain 번호가 달라졌다 → 서버가 노드·링크를 id 순으로 정렬 (DB 분기·fallback 분기 모두)
2. **A↔B 상호 링크의 방향이 뒤집혔다**: 서버는 상호 링크를 한 방향만 남기는데 어느 쪽이 남을지가 행 순서를 따랐다. 고친 페이지의 링크가 맨 뒤로 가면 반대 방향이 남는다 → `links`·`relations` 조회에 `ORDER BY`

캐시와 무관하게, 이 두 가지 때문에 **문서를 고칠 때마다 그래프 전체 모양이 조금씩 흔들리고 있었다** (클라이언트 물리의 출발 좌표가 바뀜).

### 검증

- `tests/test_graph_layout_cache.py` 6건: 결정성, 같은 입력 재사용(계산 1회), 호출자 수정이 캐시를 오염시키지 않음, 링크·반복 횟수 변경 시 재계산, 입력 순서 무관, 상호 링크 방향이 본문 편집 후에도 유지 — 마지막 건은 수정 전 코드에서 실패(RED) 확인
- 실 vault 사본(173문서): 본문만 고친 12건 모두 캐시 적중, 링크 추가 시 재계산. 캐시 적중 응답과 캐시를 비우고 새로 계산한 응답이 **모든 노드 필드·엣지 동일**
- `GET /graph` 문서 수정 직후: 중앙 0.72s → **0.39s** (DB 증분 ~0.35s + 나머지 ~0.06s)
- pytest 884 passed

## 28. lint #24 운영 지침 계약 — 정책 값을 제품의 실제 계약과 대조

ADR `adr-2026-09-25-vault-policy-slot-and-mcp-delivery` 4단계. 정책 repo 검증기는 type 9종·stale 90일을 상수로 들고 있어 제품이 바뀌면 조용히 낡았다(정책 repo CHANGELOG v1.13.0의 CI 제거 이유). 이제 제품이 자기 상수로 직접 검사한다.

- **`check_policy_contract` (#24)** — `_meta/policy/VAULT-POLICY.md`의 ```yaml 블록만 본다. 정책 본문(저장 기준 등 판단 내용)은 사용자 소유라 검사하지 않는다. 파일이나 yaml 블록이 없으면 보고 없음
  - `types`가 제품 9종 밖 → warning (그 type의 페이지는 Dashboard 파생 view에서 분류되지 않는다). 단 `validator_exceptions`의 `core-types` 예외 중 `approved_by`·`approved_at`이 있는 값은 인정 — 정책 repo의 기존 소유자 승인 계약을 그대로 따른다
  - `stale_threshold_days`가 `STALE_DAYS`(90)와 다름 → warning
  - `required_fields`에 #10 필수 필드(title/type/created/updated) 중 빠진 것 → info
  - yaml 블록 파싱 실패 → info
- **`contracts.PAGE_TYPES`** — type 9종이 `validate_gardening_schema` 안의 지역 변수에만 있었다. 모듈 상수로 올려 쓰기 검증과 #24가 같은 원본을 쓴다(세 번째 사본을 만들지 않음)
- README lint 수 22 → 23

### 검증

`tests/test_lint_policy_contract.py` 10건 (RED 확인 후 GREEN). 전체 pytest 895 passed(README 수치 갱신 전 가드 1건 실패 → 갱신 후 통과), 대시보드 `LintPage.dynamic-checks` 계약 4건 통과.

실제 정책 7개(정책 repo `vaults/*.md`)를 임시 vault에 복사해 돌린 결과: 6개 0건, homelab 1건 — `required_fields`에 `created`가 없다(info, 실제 불일치). harumoa의 소유자 승인 type 예외 5종은 경고 없이 통과했다.

## 29. 여러 줄 입력칸이 한 줄 높이로 나오던 문제 — `TextField multiline`

공통 `.input-base`가 `height: 56px`로 고정돼 있어 `TextField multiline`의 textarea가 `rows`를 무시하고 한 줄 높이로 나왔다. 운영 지침 화면(§26) 실제 앱 확인에서 발견해 그 화면만 우회했던 것(`6a83c57`)을 공통 CSS로 옮긴다.

- `globals.css`에 `textarea.input-base { height: auto; }` — 한 줄 input은 그대로 56px
- 영향 범위: `input-base`를 쓰는 textarea는 `TextField multiline`뿐이다 — 새 이슈 발행 모달의 문제 상황·원인 분석·해결 방안, 운영 지침 편집칸. 다른 textarea(`EditButton`, `NewPageButton`, `InlineMarkdownEditor`, `RawPanel`, `PageView`)는 이 클래스를 쓰지 않아 영향 없음
- `VaultPolicyPage`의 화면 한정 우회(`style={{ height: "auto" }}`) 제거

### 검증

헤드리스 Chromium 실측(임시 vault registry, 실제 vault 무관): 새 이슈 모달 textarea 113/113/92px(rows 4/4/3), 제목·BLUF 한 줄 input 유지, 운영 지침 편집칸 529px(rows 24). `tsc -b --noEmit` 통과, vitest 287 passed / 1 skipped, `npm run build` 성공.

## 30. PDF 내보내기 제거 — 앱에서 눌러도 아무 반응이 없었다

§16의 PDF(인쇄) 버튼은 데스크톱 앱에서 **조용히 아무 일도 하지 않았다**(§9 silent failure). 원인은 웹뷰다.

- macOS WKWebView에는 JS `print()`가 없다. Tauri는 최상위 `window.print`만 `plugin:webview|print`로 바꿔 두는데(`tauri-2.11.5/src/webview/scripts/print.js`), 우리는 격리 iframe의 `contentWindow.print()`를 불렀으므로 그 대체가 적용되지 않았다
- 최상위 경로로 우회해도 `core:webview:allow-print` 권한이 `core:default`에 없고, 네이티브 인쇄는 iframe이 아니라 웹뷰 전체(앱 UI)를 찍는다. 살리려면 권한 추가 + 같은 문서 안 인쇄 오버레이 + 인쇄 CSS 범위 재작성 + 비동기 인쇄 시트 수명 관리가 필요 → ROI가 낮아 제거하기로 결정(사용자 결정)

Markdown(.md) 저장만 남긴다. vault 원본 그대로라 이식성이 더 높고, 브라우저 사용자는 ⌘P로 인쇄할 수 있다.

- `ShareButton`: PDF 버튼·안내 문구·`handleExportPdf`, `title`/`getPrintHtml`/`printMeta` prop, 프린터 아이콘 제거. `exporting`을 boolean으로
- `pageExport.ts`: `printPageAsPdf`, `buildPrintDocument`, `PRINT_CSS`, `PrintMeta` 제거
- `InlineMarkdownEditor` / `PageView`: 인쇄용 본문 ref(`viewBodyRef`) 래퍼와 `printMeta` 전달 제거
- `globals.css`: `.share-export-hint` 제거(PDF 안내 전용)

### 검증

`PageExport.test.tsx`: 인쇄 관련 4건 삭제(인쇄문서 구성·escape·iframe 수명·pdf 본문 전달), "PDF 버튼 숨김" 테스트는 "PDF 버튼은 없다" 회귀 가드로 전환. `tsc -b --noEmit` 통과, vitest 283 passed / 1 skipped(287 → 삭제 4건), `npm run build` 성공.

## 31. MCP 내부망 개방 + 토큰 인증 — 허락한 사람만 LAN에서 붙는다

MCP는 인증이 없어서 데스크톱 앱이 tailnet 주소에만 바인딩했다. Tailscale 없는 같은 내부망 기기에서도 에이전트를 붙이되, vault owner가 허락한 사람만 들어오게 한다. ADR `adr-2026-09-30-mcp-lan-token-auth`.

- **`raven/mcp/auth.py::LanTokenAuth`** — MCP ASGI 앱 앞단. loopback·tailnet(`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) 출처는 통과, 그 외는 `Authorization: Bearer <token>` 필수(401 + `WWW-Authenticate`). 발급 0개면 내부망 전부 401. 출처는 소켓 주소로만 판단
- **`raven/core/mcp_tokens.py`** — `<VAULTS_ROOT>/.mcp-tokens.json`(0600)에 이름·SHA-256·발급일만. 요청마다 다시 읽어 revoke가 재시작 없이 반영. `raven/mcp/` 아래는 ToolError 외 예외 금지 가드가 있어 저장소는 core에 둔다(CLI와 공유 계약이기도 함)
- **CLI `raven mcp token add|list|revoke`** — 평문은 add 때 한 번만 출력. 서브커맨드 그룹 11 → 12 (README 가드 갱신)
- **데스크톱 바인딩** — `_resolve_mcp_host`가 API 주소를 따른다(기본 0.0.0.0). readiness의 `mcp_host`는 접속 가능한 주소(`_advertised_mcp_host`: tailnet IP → loopback)라 Rust 쪽 변경 없음. `RAVEN_MCP_HOST`로 다시 좁힐 수 있음
- **범위 밖** — standalone `raven.mcp.cli`. team 인스턴스(launchd `0.0.0.0:8767`, write)와 Docker `mcp-http`(클라이언트가 게이트웨이 IP로 보임)가 이미 내부망에 열려 있어 적용 시 즉시 401로 깨진다
- README MCP 절에 "내부망 접근 — 토큰", AGENTS.md §2 "MCP는 어디에 떠 있나" 갱신

### 검증

`tests/test_mcp_lan_token_auth.py` 16건 + README CLI 그룹 수 가드가 중첩 그룹(`mcp token`)을 세지 않게 정규식을 줄 맨 앞 `app.add_typer`로 좁힘 (RED 확인 후 GREEN): 해시만 저장·0600, 중복 이름 거부, verify/revoke, loopback·tailnet 5종 무토큰 통과, 발급 0개 401, 토큰 없음/틀림/scheme 누락 401, revoke 즉시 반영, tailnet 대역 바로 밖(100.128.0.1) 401, 바인딩/광고 주소, 앱 래핑, CLI add/list/revoke.

실서버 확인(임시 `WIKI_VAULTS_DIR`, `--host 0.0.0.0 --mcp`): loopback 200 · tailnet 200 · LAN 무토큰 401 · 틀린 토큰 401 · 맞는 토큰 200 · `X-Forwarded-For: 127.0.0.1` 위조 401 · revoke 후 401 · 토큰 파일 `-rw-------`.

## 32. 문서 내 찾기 (Cmd/Ctrl+F) — 데스크톱 웹뷰에 찾기 막대가 없었다

데스크톱 앱 웹뷰(WKWebView)에는 찾기 막대가 없어 Cmd+F가 아무 반응도 없었다. 문서 화면(`InlineMarkdownEditor`)에 자체 찾기 막대를 붙였다.

- 읽기 모드: CSS Custom Highlight API로 렌더된 본문을 칠한다 (`dashboard/src/lib/domFind.ts`). DOM을 바꾸지 않는다.
- 편집 모드: textarea 뒤 backdrop에 `<mark>`로 칠한다 (`FindBackdrop.tsx`). WebKit이 포커스 없는 textarea 선택을 그리지 않아서다. 글자 위치를 맞추려고 textarea와 backdrop이 글꼴·패딩·box-sizing·scrollbar-gutter를 공유한다.
- Enter/Shift+Enter 이동, Esc 닫기 — Esc는 전파를 막아 편집 취소와 겹치지 않는다.
- 한계: 텍스트 노드 경계를 넘는 일치(굵게 표시를 사이에 둔 구절)는 읽기 모드에서 찾지 않는다.

### 검증

`findInText` / `domFind` / `FindBar` / `FindBackdrop` / `InlineMarkdownEditor.find` 테스트 (RED 확인 후 GREEN). 대시보드 전체 vitest 통과, `tsc -b` 통과. 레이아웃(편집칸 높이, classic 스크롤바 폭)은 Chromium 측정으로 확인.

## 33. 전체 vault 백업 내보내기·가져오기 — 다른 PC로 vault를 그대로 옮긴다

다른 PC로 vault를 옮길 도구가 없었다(`vault import`는 같은 PC 안 clone 별칭이고 raw/·log.md·.graph_positions.json을 빠뜨린다).

- core `raven/core/backup.py` — wiki.db·.mcp/·.DS_Store만 빼고 vault 폴더 전체를 zip 하나로. manifest.json에 레지스트리 메타(path/workspace_path 제외).
- 가져오기: 같은 이름이면 `name-2`…, 기존 vault는 건드리지 않음. `.vault.json` path 재작성, workspace_path는 비우고 보고. 임시 폴더에 풀고 rename. zip-slip(빈 경로 구간 포함)·symlink·크기 상한은 풀기 전에 전부 거부, vault 하나 실패는 그 vault만 오류로 남김. 백업 파일을 vault 안에 저장하는 것은 거부(자기 자신을 읽으며 무한히 커짐).
- CLI `raven vault export [-o] [--vault]`, `raven vault import-backup <zip>`.
- API `POST /api/backup/export|import` — 경로를 받으므로 loopback + 로컬 Origin 전용(그 외 403). Vite 개발 프록시에 `xfwd: true`(프록시 경유 LAN 요청이 loopback으로 보이던 것 차단). 엔드포인트 68 → 70.
- 데스크톱 관리 화면 "백업" 섹션 — `tauri-plugin-dialog` 2.7(신규 의존성) 저장/열기 대화상자. 브라우저 대시보드·원격 호스트에서는 숨김. MCP로는 노출하지 않음(경로 기반 파일 읽기/쓰기를 LAN·에이전트에 열지 않음).
- 후속 제안: `_meta/dr-runbook.md` 복구 절차를 이 기능 기준으로 갱신 (경로가 2026-06 구조 기준).

### 검증

`tests/test_backup.py` 32건(왕복·이름 충돌·경로 재작성·default·zip-slip/symlink/크기/형식 거부·부분 실패 격리·1980 이전 mtime·vault 안 저장 거부), `test_api_backup.py`(loopback/Origin 게이트), `test_cli_backup.py`, `BackupPanel.test.tsx`, Rust capability 가드. Python 전체 953 통과, 대시보드 vitest 통과, `cargo test` 12 통과. 임시 `WIKI_VAULTS_DIR` 두 개로 CLI export → import 실동작 확인(t1 → t1-2, 검색 동작).

## 34. 데스크톱 v0.3.1 그래프 500·wiki.db 재빌드 실패 — 번들에 python-frontmatter가 빠졌다

데스크톱 UI 점검 중 발견했다. 설치된 v0.3.1에서 GET `/graph`가 500인데 화면은 "아직 시각화할 문서가 없습니다"를 띄웠고, 앱의 wiki.db 재빌드가 그날 하루만 25번 실패했다(`log.md` `build | wiki.db rebuild (fail, ? pages)`). 앱의 내장 Python에 `python-frontmatter`가 없었다. raven 코드는 repo와 같았고, 이 PC에서 만든 번들(`desktop/src-tauri/resources`)에는 패키지가 있다 — v0.3.1을 빌드한 쪽 번들에서만 빠졌다(그 빌드의 python-dotenv도 1.2.4로 달랐다). 빠진 이유는 그 빌드 로그 없이 확인하지 못했다.

- 그래프 API(`raven/api/server.py` `vault_graph` 2곳)와 `scripts/build_db.py`가 외부 `frontmatter` 대신 `raven.core.frontmatter.parse`를 쓴다. 실제 vault 2개 658파일에서 두 파서의 DB 사용 필드 11개·본문이 같고, hub-control-room 복사본으로 옛/새 빌더 DB를 만들어 pages·tags·links·relations·build_files·pages_fts가 모두 같음을 확인했다.
- `scripts/prepare-bundle.sh`: pip 설치 뒤 `requirements.txt`의 패키지가 모두 설치됐는지 확인하고, 빠지면 번들을 만들지 않는다. 설치된 v0.3.1의 Python에 돌리면 `python-frontmatter`로 실패한다.
- GraphPage: HTTP 오류 응답을 빈 그래프로 바꾸던 처리를 오류로 던져, 기존 "그래프를 불러오지 못했습니다 / 다시 시도" 상태가 뜨게 했다.
- `python-frontmatter`는 테스트 2곳이 아직 쓰므로 `requirements.txt`에 그대로 둔다.

### 같은 점검의 UI 수정

- 보관함: 긴 slug에 밀려 "복원" 버튼이 "복/원"으로 꺾이던 것 — 시각·경과·작업 칸 `nowrap`. 일수 입력칸에 `input-base`.
- 로그: `input-base`의 `width: 100%` 때문에 "액션" 라벨이 세로로 꺾이던 것 — select `width: auto`.
- 새 vault: 페이지 제목("새 vault 만들기")과 위저드 제목("새 vault 추가")이 겹치던 것 — 페이지 쪽 제거.
- Markdown 코드 블록(라이트 모드): 배경은 v0.7.56부터 어둡게 강제했는데 구문 강조는 라이트 팔레트로 남아 YAML 키(#0a3069)가 묻혔다 — 라이트 모드 `pre` 안에서 라이브러리 다크 팔레트 변수를 쓴다.

### 검증

`tests/test_no_third_party_frontmatter.py` 2건(외부 `frontmatter` import가 실패하는 환경에서 `/graph` 200, `build_db` ok — 수정 전 RED 확인), `GraphPage.cache.test.tsx` 오류 상태 1건 추가. Python 전체 955 통과, 대시보드 vitest 315 통과, `tsc --noEmit` 0. Vite 개발 서버 + 실행 중인 앱 API로 수정한 5개 화면을 1280·900px 스크린샷으로 확인.

후속: 수정본을 배포하려면 v0.3.2 릴리스가 필요하다(서명 키는 집 PC). GitHub Actions `desktop-release`는 v0.2.0부터 매번 실패 중이다.

## 35. 가드닝 지원 — wiki_stale_detect의 updated 기준, wiki_log 필터

정책 repo v1.17.0의 가드닝 절차(VAULT-OPERATOR §3.3)를 MCP로 실행해 보니 두 도구가 막았다.

- `wiki_stale_detect`: `last_verified`만 봐서, 그 필드를 쓰지 않는 vault(대부분)에서는 후보가 늘 0건이었다. 이제 `last_verified`가 없으면 `updated`로 판정한다(lint #7과 같은 기준). evidence에 `updated N일 전 (임계값 90, last_verified 없음)`. 날짜만 있는 값(`2026-07-01`)은 naive datetime이라 aware `now`와 빼면 `TypeError`로 도구 전체가 죽던 것도 고쳤다(UTC로 간주). `SCHEMA.md` 템플릿의 `last_verified` 주석 갱신.
- `wiki_log`: 선택 인자 `action`·`contains`. 주면 log.md 전체에서 항목(제목+세부 줄) 단위로 걸러 최근 `tail_n`개 항목을 돌려준다. 필터 없는 호출은 기존과 같다(최근 N줄). hub-control-room log.md가 1,978줄이라 줄 단위 tail로는 마지막 `reason: gardening:` 기록을 찾을 수 없었다. `TOOLS.md` 템플릿 갱신.
- 보류: 가드닝 회차 기록(변경 0건 회차·보류 목록)을 log.md에 남기는 경로. 에이전트 쓰기 경로를 하나 늘리는 결정이라 따로 정한다.

### 검증

`tests/scenarios/test_stale_detect_updated_basis.py` 4건, `tests/test_mcp_wiki_log_filter.py` 4건(수정 전 각 2·3건 RED 확인). Python 전체 963 통과.

## 36. 가드닝 회차 기록 — MCP wiki_gardening_record

§35에서 보류했던 경로다. ADR `adr-2026-10-02-gardening-record-log-entry`.

- MCP `wiki_gardening_record(vault, summary, deferred?, proposed?, actor?)` (write 모드) — log.md에 `## [날짜] gardening | <summary>` 항목과 `- actor:`·`- deferred:`·`- proposed:` 줄을 남긴다. 에이전트가 log.md에 쓰는 유일한 경로이며 형식이 고정돼 있다. 줄바꿈이 든 값(항목 위조)·300자 초과·목록 50개 초과는 거부.
- `raven.core.log`: 액션 `gardening` 추가. `append(extra=...)`의 값이 리스트면 항목마다 한 줄.
- Dashboard 로그 화면 액션 필터·배지에 `gardening`.
- `TOOLS.md` 템플릿, README 도구 수(24 → 25).
- 정책 repo: VAULT-OPERATOR §3.3 기록 규칙과 `vault-gardening` 스킬이 회차 끝에 이 도구를 부르고, 이어받기에서 `wiki_log(action="gardening")`을 읽는다.

### 검증

`tests/test_mcp_gardening_record.py` 8건(기록 형식, `wiki_log` 필터로 조회, 잘못된 입력 5종 거부 시 log.md 불변, read 모드 미노출 — 수정 전 RED 확인).

## 37. 데스크톱 점검 P2 — CI 업로드 제거, 루트 목차 고아 면제, UI 정리

- **CI `desktop-release`**: 빌드는 매번 성공했고 업로드 단계만 DMG 파일명 `Raven_0.1.0_aarch64.dmg` 고정으로 v0.2.0~v0.3.1 내내 실패했다. 파일명을 고치는 대신 업로드를 뺐다 — 릴리스는 서명 키가 있는 머신의 `make desktop-release`가 DMG와 서명된 업데이터를 함께 올리는데, CI가 같은 릴리스에 `--clobber`로 DMG를 올리면 DMG와 업데이터가 서로 다른 빌드가 된다(§34가 바로 빌드 차이에서 생긴 사고). 이제 태그마다 깨끗한 환경에서 DMG까지 빌드되는지만 검증하고, §34의 번들 패키지 검사도 여기서 돈다.
- **`content/index` 고아 면제**: lint #4와 정원(garden)이 vault 루트 목차를 고아로 잡고, 정원은 무관한 도구 문서를 연결하라고 추천했다. 둘 다 면제(`index_builder`가 만드는 루트이며 analytics·advice·db도 이미 따로 다룬다). 점검 때 보인 "정원 1 / 린트 2" 개수 차이는 사이에 vault가 바뀐 탓으로 재현되지 않았다.
- **보관소 관리**: 900px에서 헤더 버튼("보/관함")·숫자 칸("링/크", "859.5/KB")·이름이 글자 단위로 꺾이던 것 — 해당 칸 `nowrap`, 경로만 `break-all`(최소 120px), 작업 버튼은 버튼 단위로 줄바꿈.
- **raw**: 파일 선택 전 본문 트리가 사이드바 raw 트리와 겹쳤다. 사이드바가 항상 보이는 폭(>744px)에서는 숨기고, 사이드바가 서랍이 되는 744px 이하에서는 유지(`.raw-panel-grid`/`.raw-panel-tree`). v0.7.112 "파일을 열면 내부 트리 숨김" 계약은 그대로.
- **제목**: "Vault Log" → "로그", "Vault 관리" → "보관소 관리", 속성 패널 "Properties" → "속성" (탭 라벨·사이드바 표현에 맞춤). 로그 요약 카드 라벨(PATH 등)은 그대로.

### 검증

`test_lint_v2.py::test_vault_root_index_is_not_orphan`(lint·garden 모두 — garden 쪽은 수정 전 RED 확인), `RawPanel.viewer-layout.contract.test.ts` 1건 추가. Python 972, vitest 316 통과, `tsc --noEmit` 0. 보관소 관리 900·1280px, raw 1280·700px, 로그·문서 화면 스크린샷 확인(가로 넘침 0).

## 38. 보안 — Core API 접근 게이트 (Issue #14, PR #21)

인증 없는 Core API가 LAN에 열려 있었다. 데스크톱 기본 bind가 `0.0.0.0`이었고, 경로에 따라 `DELETE /api/vaults/{name}?force=true`까지 닿았다. 게이트를 실행기가 아니라 앱 자체에 붙여 모든 실행 경로가 같은 판정을 받게 했다. 결정 근거: [[adr-2026-10-08-core-api-access-gate]].

- **게이트** (`raven/core/access.py::TokenGate`, `raven/api/server.py`에 설치): loopback·tailnet은 통과하고, 그 외는 `raven mcp token add`로 발급한 Bearer 토큰이 필요하다. 발급 0개면 전부 401이고 경로 예외는 없다. MCP의 `LanTokenAuth`도 같은 클래스를 쓴다.
- **프록시 헤더**: strict 모드(기본)에서는 X-Forwarded-For / Forwarded / X-Real-IP가 붙은 요청에 출처 신뢰를 주지 않는다. 그래서 `--forwarded-allow-ips '*'`여도 사칭할 수 없다. Raven 실행기는 `proxy_headers=False`로 띄우고, 이 기기의 프록시(vite `xfwd`)가 붙인 XFF만 해석한다.
- **bind**: 기본은 loopback이다. 원격 bind는 `RAVEN_ALLOW_REMOTE=1`(또는 `--host tailscale`)일 때만 허용한다. standalone은 opt-in 없이 요청하면 exit 2로 거부한다. 우선순위는 `--host` > `RAVEN_HOST`다. CORS는 더 이상 `*`로 넓어지지 않는다.
- **Docker**: compose가 `RAVEN_ALLOW_REMOTE=1`을 명시한다. 대시보드 프록시는 사용자 토큰(`/__raven/login` → HttpOnly·SameSite=Strict 쿠키)을 Bearer로 실어 보낸다. Docker 대역은 신뢰하지 않는다. 쿠키로 인증된 쓰기 요청은 같은 Origin일 때만 받는다.
- **감사 개정 (tailnet 판정)**: `100.64.0.0/10` 대역 소속만으로 신뢰하던 것을 고쳤다. `100.64.200.0/24` Docker 망의 컨테이너가 토큰 없이 vault를 지울 수 있었다(실제 재현). 이제 응답 라우트가 이 기기의 Tailscale 주소(`tailscale ip`)로 나갈 때만 tailnet으로 본다. Tailscale이 없으면 토큰이 필요하다. 이 판정은 요청 시점 라우트에 의한 추론이고 WireGuard 인증을 직접 증명하지 않는다 (승인된 잔여 위험, 토큰 필수화는 #24).
- **감사 개정 (Docker 세션)**: 쿠키에는 API 토큰 대신 메모리 세션 id를 담는다(로그아웃 시 서버에서 폐기). 로그인 본문과 토큰 형식을 제한하고, 잘못된 Content-Length는 400/413으로 거부한다. 프록시는 CORS 응답 헤더를 버리고, `RAVEN_DASHBOARD_SECURE_COOKIE` opt-in을 추가했다.
- **구조적 한계**: XFF 없이 API를 중계하는 로컬 프록시는 직접 loopback 접속과 구분할 수 없어 인증 없이 통과한다(재현됨). 지원 프록시(vite·spa_server·Caddy→dashboard)는 모두 XFF를 붙인다. loopback 프로세스 신뢰와 비공식 프록시는 2026-10-08 승인된 잔여 위험이다 (공식 지원 프록시 3종으로 한정).
- **운영 변화**: Docker 대시보드는 첫 접속 때 토큰이 필요하다 (`docker compose exec api python -m raven.cli mcp token add <이름>`). 테스트에서 `TestClient`의 기본 출처 `"testclient"`는 IP가 아니라서 거부되므로, `tests/conftest.py`가 loopback을 기본값으로 준다.

### 검증

`test_core_api_access.py` 74건, `test_core_api_forwarded.py` 50건, `test_spa_server_auth.py` 28건, `test_core_api_tailnet.py` 11건을 추가했다. 세 파일 모두 수정 전 RED를 확인했다. Python 1127 passed / 1 failed / 1 skipped이고, 실패 1건은 기존 baseline인 `test_mcp_semantic_lint_queue::test_no_candidates_is_not_an_error`다. cargo test 13, vitest 380, `tsc -b` 0. 실제 확인 범위: LAN·tailnet 소켓, 실제 vite 프록시, `docker compose` 스택(다른 컨테이너 401 포함), Chrome 로그인, Tauri `tauri dev` 기본·원격 모드.

### 후속

#24 (tailnet Bearer 토큰 필수화·멀티호스트 호환), #22 (원격 모드 포트 선택이 loopback 점유를 놓침), #23 (SIGTERM 후 Python Core 잔존).

## 39. 보안 — Core API tailnet 토큰 필수화 (Issue #24)

PR #21은 tailnet 출처를 라우트 검사로 판정해 토큰 없이 받았다. 이 검사는 추론일 뿐 WireGuard 인증의 증명이 아니어서, 승인된 잔여 위험으로 남겨 두었다. 이번에 그 위험을 Core API에서 걷어냈다. 이제 **loopback 직접 연결만** 토큰 없이 받고, tailnet을 포함한 다른 모든 출처는 Bearer 토큰이 필요하다. 결정 근거: [[adr-2026-10-08-core-api-tailnet-token]].

- **서버**: `TokenGate.trust_tailnet = False`. MCP의 `LanTokenAuth`만 `True`를 명시해 기존 ADR을 유지한다. 경로 예외는 추가하지 않았다. 모든 메서드와 WebSocket handshake에 같은 판정을 적용한다. 운영 메시지와 보관소 관리 화면의 "tailnet 통과" 표기도 실제 정책에 맞췄다.
- **대시보드**:
  - 호스트별 토큰은 sessionStorage에만 둔다(`lib/host-auth.ts`).
  - fetch 래퍼는 `/api/*` 요청에, 그 요청이 가는 정확한 호스트의 토큰만 붙인다. 절대 URL은 origin이 정확히 일치할 때만이다(E2E에서 `apiFetch`의 절대 URL 누락을 발견해 RED→GREEN으로 수정). beacon은 토큰이 있으면 keepalive fetch로 보낸다.
  - 게이트 401이 오면 토큰 입력창(`AuthTokenDialog`)을 띄운다. 저장 전에 검증한다. 실제 브라우저 E2E에서 두 결함을 발견해 RED→GREEN으로 고쳤다.
    - 원격 호스트의 401은 cross-origin이라 브라우저가 `WWW-Authenticate`를 숨겼다 → API CORS에 `expose_headers=["WWW-Authenticate"]`를 추가했다.
    - 첫 `/api` 호출의 401이 입력창이 마운트되기 전에 도착하면 이벤트가 유실됐다 → 대기 중인 인증 요청을 보관해 마운트 시 연다.
  - Docker 프록시의 401은 로그인 화면으로 보낸다(`spa_server`에 `Session realm` 표기 추가).
  - 호스트 추가 화면에 토큰 칸을 추가했다.
- **Breaking change**: tailnet에서 토큰 없이 쓰던 대시보드 멀티호스트, 원격 브라우저, 스크립트는 401을 받는다. 마이그레이션 절차는 README "Breaking change (Issue #24)"에 있다.
- **범위**: **Core API 한정**이다. MCP 인증 정책은 바꾸지 않았다(2026-10-09 결정, 후속 #26).
- **보안 심층 리뷰 반영 (PR #25 리뷰)**: 토큰 유출 결함은 발견되지 않았다. 아래 결함은 모두 RED→GREEN으로 고쳤다.
  - `fetch(Request)`가 토큰 없이 나가던 것. 코드베이스에는 사용처가 없다.
  - 대소문자나 기본 포트가 다른 호스트 키가 토큰을 못 받던 것. origin으로 정규화했다.
  - 자동으로 붙인 토큰이 실린 요청이 redirect를 따라가던 것. `redirect: "error"`로 막았다.
  - sessionStorage 저장 실패를 성공으로 표시하던 것.
  - 거절된 저장 토큰이 남던 것. 스킴도 대소문자 구분 없이 판정한다.
  - Docker에서 폐기된 세션의 Bearer 401이 토큰 입력창을 띄우던 것. 세션 인증과 Bearer 인증이 섞였다. 이제 `spa_server`가 자기 realm으로 답한다.
  - 실증 (Chrome 154, 실제 서버 2개):
    - 브라우저 기본: cross-origin 302/307/308에서 Authorization이 제거된다. 다른 origin을 거친 체인에서는 원래 origin으로 돌아와도 복구되지 않는다.
    - 자동 토큰 요청은 첫 hop에서 멈춘다.
    - HTTP↔HTTPS 전환과 WKWebView는 UNKNOWN.
- **원격 API 직접 서빙 대시보드** (`http://<tailnet-IP>:8765/`)가 HTML부터 401로 막히는 동작은 의도된 breaking change로 승인했다(2026-10-09). 인증 없는 HTML 예외 경로는 두지 않는다. 대체 경로는 데스크톱 멀티호스트, Docker 로그인 화면, vite 개발 대시보드다.
- **남는 위험 (해결 주장 ❌)**:
  - **MCP tailnet 무인증 — 실제 소켓으로 확인**. 데스크톱 원격 모드(`RAVEN_ALLOW_REMOTE=1`, MCP admin)에서 이 기기의 tailnet IP로 보낸 요청 결과:
    - Core API DELETE → 401
    - MCP `wiki_delete` → 토큰 없이 성공(임시 vault 페이지 archive)
    - 즉 원격 모드에서는 Core API 토큰을 MCP로 우회할 수 있다.
    - standalone `raven.mcp.cli`(team, Docker)는 게이트 자체가 없다(코드 확인).
    - 후속 #26. 임시 완화책은 `RAVEN_DESKTOP_MCP=0`(MCP 끄기) 또는 `RAVEN_DESKTOP_MCP_MODE=read`(읽기는 열림).
  - loopback 프로세스 신뢰와 XFF 없는 비공식 로컬 프록시
  - 평문 HTTP의 토큰 노출
  - sessionStorage 토큰의 XSS 노출
  - 실제 원격 tailnet 기기 미검증(UNKNOWN)

## 40. 보안 — MCP 원격 접근 토큰 필수화 (Issue #26)

§39는 Core API에서만 tailnet 무인증 신뢰를 걷어냈다. MCP는 같은 기기에서 그 토큰을 우회하는 경로로 남아 있었다. 이번에 **모든 MCP HTTP 리스너**를 같은 정책으로 맞췄다. 직접 loopback만 토큰 없이 받고, tailnet을 포함한 다른 모든 출처는 Bearer 토큰이 필요하다. 결정 근거: [[adr-2026-10-09-mcp-remote-token]]. [[adr-2026-09-30-mcp-lan-token-auth]]의 tailnet 통과와 standalone 범위 밖을 대체한다.

- **수정 전 상태 (실제 소켓·이미지로 재현)**:
  - 데스크톱 원격 모드: tailnet 무토큰 `initialize`·`wiki_delete`가 통과했다.
  - standalone `raven.mcp.cli`(`./raven.sh start`, team launchd, Docker `mcp-http`): 게이트가 없었다. LAN·tailnet·Docker CGNAT IPv4·IPv6에서 무토큰 `initialize`가 200이었다.
  - Docker에서는 XFF·Host·Origin을 위조해도, 잘못된 토큰을 보내도 200이었다. uvicorn이 `forwarded_allow_ips="*"`와 `proxy_headers=True`로 떠 있었다.
- **서버**:
  - `LanTokenAuth.trust_tailnet = False`.
  - 새 `raven.mcp.cli.build_http_app()`이 MCP 앱 전체를 게이트로 감싼다. 데스크톱 런타임과 standalone이 같은 빌더를 쓴다.
  - standalone은 Core API와 같은 `serve_kwargs()`(`proxy_headers=False`)로 뜬다.
  - opt-out과 경로 예외는 없다. stdio는 범위 밖이다.
  - 운영 메시지, CLI 도움말, Rust·Docker·launchd·`raven.sh` 주석, AGENTS.md §2를 실제 정책에 맞췄다.
- **검증 (RED → GREEN, 임시 vault)**:
  - 프로세스 안에서 실제 MCP 앱으로 확인했다. 데스크톱·standalone 각각 tailnet IPv4·IPv6, LAN, Docker bridge, ULA 출처에서 다음이 모두 401이었고 `wiki_delete`는 실행되지 않았다.
    - initialize, tools/list, tools/call(wiki_delete), GET, DELETE
    - 발급 0개 상태, 틀린 토큰
    - XFF·Forwarded·X-Real-IP·Host·Origin 위조
  - 실제 소켓으로 데스크톱 런타임, standalone, team plist 인자 그대로를 확인했다.
    - LAN IP와 이 기기의 Tailscale IPv4에서 무토큰 → 401
    - 유효 토큰 → SDK 연결 성공. 데스크톱·standalone에서는 `wiki_delete`도 실행됐다.
    - loopback 무토큰 → 연결 성공
  - Docker E2E: 실제 `mcp-http` entrypoint, CGNAT `100.64.200.0/24`와 `fd7a:115c:a1e0:ab::/64`.
    - 수정 전 이미지: 무토큰 200
    - 수정 후 이미지: 무토큰·위조·틀린 토큰 401, 유효 토큰 200, 컨테이너 내부 loopback 200
    - 서버 로그에 토큰 0줄
- **Breaking change**: 원격 MCP 클라이언트는 토큰을 설정해야 한다. 같은 PC의 에이전트는 영향이 없다. 설정·복구 방법은 README "에이전트 인터페이스 (MCP) → 원격 접근 — 토큰"에 있다. team 인스턴스는 앱 번들 코드를 실행하므로 Raven.app을 재설치해야 적용된다.
- **남는 위험 (해결 주장 ❌)**:
  - 실제 원격 tailnet 기기 E2E는 UNKNOWN이다. 자기 Tailscale IPv6 자기 접속은 macOS에서 불가했다.
  - loopback 무인증 신뢰는 그대로다. MCP는 DNS-rebinding 보호가 꺼져 있어, rebinding으로 loopback에 닿는 브라우저 페이지도 이 신뢰에 포함될 수 있다(추론, 실증 안 함).
  - 평문 HTTP의 토큰 노출.

## 41. 대시보드 — Core 실패를 "vault 0개"로 오인하던 /vault/new 이동 제거 (Issue #30)

Core API가 401·403·5xx를 돌려주거나 연결이 끊기면, 대시보드(데스크톱 웹뷰 포함)가 "등록된 vault 0개"로 판단해 **새 vault 추가 화면으로 강제 이동**했다. 토큰 입력창을 닫으면 사용자는 vault를 새로 만들라는 폼 앞에 남았다.

- **원인**:
  - `fetchVaults`가 `!r.ok`를 `[]`로 바꿨다.
  - 그 `[]`가 성공 값으로 `cachedFetch("vaults", 30s)`에 들어가, Core가 복구돼도 30초 동안 잘못된 상태가 남았다.
  - `Layout`의 `.catch(() => setVaults([]))`가 네트워크 오류도 빈 목록으로 만들었다. `loaded && vaults.length === 0` 하나로 이동을 결정해서 실패와 빈 목록을 구분할 수 없었다.
- **수정**:
  - `fetchVaults`는 HTTP 실패 시 `ApiHttpError(status)`로 reject한다. `cachedFetch`는 원래 reject를 캐시하지 않으므로, 재시도는 실제 재요청이 된다.
  - `Layout`은 실패를 `auth`/`forbidden`/`server`/`network`로 분류한다(`classifyVaultsFailure`). 기존 `EmptyState` + `Button`으로 상태별 메시지와 "다시 시도"를 보여 준다(`role="alert"`).
  - `/vault/new` 이동은 **성공한 빈 목록**에서만 한다. 실패 시 이전 목록을 덮어쓰지 않는다. 목록을 한 번도 받지 못했다면 하위 페이지를 띄우지 않는다.
  - 401은 기존 흐름(`api-base` 래퍼 → `AuthTokenDialog`)을 그대로 쓴다. 새 모달은 없다. "다시 시도"가 재요청하면 래퍼가 같은 입력창을 다시 연다.
  - 두 번째 호출부인 `HomePage`도 reject를 잡는다. 이전에는 실패 시 "첫 vault 만들기" CTA가 떴고, 이제 reject를 잡지 않으면 "불러오는 중…"에 멈춘다. 이제 실패 문구를 표시한다.
- **검증 (RED → GREEN)**:
  - 신규 `Layout.vaults-failure.test.tsx` 12건: 실제 `api.ts`·`api-base.ts`를 거치고 `window.fetch`만 stub했다. 수정 전에는 8건 실패했다.
  - 신규 `HomePage.vaults-failure.test.tsx` 2건: 수정 전 1건 실패.
  - 전체 vitest 67 files, 423 passed / 1 skipped. `tsc --noEmit` 통과.
  - 실화면: 격리된 Vite(5199)와 가짜 Core stub으로 확인했다. 운영 API·vault는 쓰지 않았다.
    - 503 → 오류 + 재시도 → 정상 복귀
    - 401 → 기존 입력창 1개, 닫으면 안내만 남고, 재시도하면 입력창이 다시 열린다
    - 403 → 권한 오류
    - 200 + 빈 목록 → `/vault/new`
- **범위 밖·남는 것**:
  - 실패 상태에서도 사이드바는 "보관소 없음"과 Stats 위젯 "—"를 표시한다(#3 정보 구조 작업에서 처리).
  - 데스크톱 앱(Tauri) 창 안에서의 실화면 확인은 UNKNOWN이다.
  - 실제 네트워크 오류(연결 거부)는 단위 테스트로만 확인했다. Vite 프록시 경유 시에는 프록시가 5xx로 바꾼다.
- **PR #31 리뷰 보완**:
  - **HomePage 실패 복구**: 로드 effect가 mount 1회(`[]`)뿐이었다. 실패하면 같은 인스턴스에서 재조회할 경로가 없었다(Layout 재시도는 목록이 있으면 Outlet을 remount하지 않는다). 오류가 "남는" 버그는 아니었지만 복구할 길도 없었다. 실패 상태에 "다시 시도"를 추가했다(`reloadKey`, 시작 시 `loadFailed` 초기화). 실패 → 재시도 → 성공 회귀 테스트를 추가했다.
  - **호스트 전환과 이전 목록**:
    - 같은 탭의 HostPicker 전환은 전체 페이지 이동이라 state가 남지 않는다(실화면 확인).
    - 그러나 `api-base`는 매 요청마다 localStorage의 활성 호스트를 읽는다. 다른 탭에서 호스트를 바꾸면 이 탭의 다음 요청은 새 호스트로 간다. 이 경로에서 세 가지 결함이 재현됐다(테스트 RED 6건).
      1. `fetchVaults` 캐시 키(`"vaults"`)가 호스트와 무관해, A의 목록이 B의 응답으로 반환됐다. → `vaults@<host>`로 바꿨다. `invalidateCache("vaults")`는 prefix 매칭이라 그대로 동작한다.
      2. B 실패 시 A의 목록이 유지됐다. → 이전 목록 유지는 그 목록을 받아 온 호스트와 같을 때만 한다(`vaultsHostRef`). 다른 호스트면 비우고, 하위 페이지를 띄우지 않는다.
      3. 늦게 도착한 이전 요청(성공·실패 모두)이 최신 결과를 덮었다. → effect cleanup의 `stale` 가드를 추가했다.
    - 실화면에서 하나 더 발견했다: B 실패 화면에서 사이드바 하단 위젯이 localStorage에 남은 A의 vault를 "alpha / 현재 보관소"로 보여 줬다(팔레트도 그 이름으로 B에 요청할 수 있었다). → 현재 목록에 있는 vault만 사이드바·팔레트로 내린다(`listedVault`).
    - 같은 호스트의 일시 장애에서 이전 목록을 유지하는 정책은 보존했고 테스트로 고정했다.
  - **검증**:
    - 신규 `Layout.vaults-host-switch.test.tsx` 6건, HomePage +1건.
    - mutation 확인: `stale` 가드를 빼면 순서 테스트 2건, 호스트 가드를 빼면 전환 테스트 1건이 실패한다.
    - 전체 vitest 68 files, 430 passed / 1 skipped. tsc, build 통과.
    - 실화면(격리 Vite + 가짜 호스트 2개): HostPicker로 A→B 전환 시 B 503 오류만 표시되고 alpha 흔적이 없다. B 복구 후 재시도하면 beta가 표시된다.

## 42. 대시보드 — 라우트 ErrorBoundary: 렌더 오류·청크 로딩 실패가 앱 전체를 비우지 않게 (Issue #1 A-1, 대시보드 부분)

하위 화면 하나가 렌더 중 throw하거나 lazy 라우트의 청크를 못 받으면, 오류가 루트까지 올라가 React가 `#root`를 비웠다. 데스크톱 셸의 `RECOVER_IF_BLANK_JS`는 `#root`가 비면 `location.reload()`를 하므로, 번들이 깨진 상태에서는 창 포커스마다 reload → crash → blank가 반복될 수 있었다.

- **수정** (`dashboard/src/components/RouteErrorBoundary.tsx` 신규, `App.tsx`):
  - **라우트 단위 boundary** (`RouteErrorBoundary`): 13개 라우트를 `RouteSlot`(boundary + 기존 Suspense)으로 감쌌다. Layout의 Outlet 안이라 사이드바·헤더는 남는다. boundary가 Suspense 바깥이어서 lazy reject도 잡힌다. 화면 이동(`location.key` 변경) 시 오류 상태를 해제한다.
  - **최상위 boundary** (`AppErrorBoundary`): Layout 자체가 터져도 빈 화면 대신 복구 UI를 그린다. 그래서 `#root`가 비지 않고, 셸의 blank 복구 reload도 발동하지 않는다.
  - **복구 UI**: 기존 `EmptyState` + `Button` + `EmptyIcon.AlertTriangle`, `role="alert"`. 렌더 오류에는 "이 화면을 표시하지 못했습니다" + "다시 시도"를, 청크 실패에는 "화면 파일을 불러오지 못했습니다" + "다시 시도" + "앱 다시 불러오기"를 보여 준다.
  - **`lazyRoute`**: `React.lazy`는 reject된 import를 영구 캐시한다. 그래서 사용자 재시도(버튼·화면 이동) 뒤 첫 렌더에서만 새 lazy를 만든다.
- **무한 반복 방지**: 자동 재시도·자동 새로고침은 없다. 재시도는 사용자 조작 1회당 import 1회다. 실패 즉시 lazy를 갈아 끼우던 1차 구현은 React가 오류 직후 하는 자동 재렌더 때문에 클릭 0회에 import가 5회 나갔다(테스트로 잡음). 이후 재시도 회차(`retryEpoch`)로 막았다. `window.location.reload()`는 청크 실패 화면에서 사용자가 "앱 다시 불러오기"를 누를 때만 부른다.
- **실측 — Chrome은 실패한 동적 import를 다시 요청하지 않는다**: Chrome 154에서 청크를 404로 막았다. 첫 시도 후 "다시 시도"를 2회 눌러도 요청은 1회뿐이었고, 청크를 되살린 뒤에도 "다시 시도"로는 복구되지 않았다. 사용자가 누른 "앱 다시 불러오기"로는 복구됐다. 그래서 청크 실패 화면에서는 "앱 다시 불러오기"를 기본 버튼으로 둔다. Tauri 웹뷰(macOS WKWebView)의 동작은 확인하지 못했다.
- **검증 (RED → GREEN)**:
  - 신규 `tests/App.route-error-boundary.test.tsx` 10건: 실제 `App`(라우트 표 + Layout)을 렌더하고 라우트 모듈만 mock했다. master의 `App.tsx`에서는 9건이 실패했다. 나머지 1건은 정상 라우팅 회귀 가드라 원래 통과한다.
  - 전체 vitest 69 files, 440 passed / 1 skipped. `tsc --noEmit` 통과. `vite build` 성공.
  - 실화면: 빌드 산출물을 scratch 정적 서버에 띄우고 GardenPage 청크만 404로 막아 확인했다. 운영 API·Vite는 쓰지 않았다.
    - 청크 실패 → 복구 UI, 사이드바·헤더 유지
    - 5초 대기 동안 추가 요청·자동 새로고침 없음
    - 홈으로 이동하면 오류 해제
    - "앱 다시 불러오기" → 정원 정상 표시
- **범위 밖·남는 것**:
  - Issue #1 A-1의 셸 쪽 수용 기준(`RECOVER_IF_BLANK_JS` 재시도 카운터·쿨다운)은 Rust/Tauri 셸 정책 변경이라 이번에 하지 않았다.
  - A-2~A-5도 그대로다. 그래서 PR은 Issue #1을 자동 종료하지 않는다.
  - 렌더 오류의 실화면 확인, Tauri 창 안 동작은 UNKNOWN이다(단위 테스트로만 확인).

### PR #33 Tauri 검증 보완 — 데스크톱에서는 "앱 다시 불러오기" 대신 앱 재실행 안내

- **Tauri 실측** (실제 Raven 데스크톱 셸, macOS WKWebView): 격리 identifier와 가짜 Core를 쓰고, 프런트엔드는 scratch 빌드로 띄웠다. 운영 API·MCP·Vite와 실제 vault는 쓰지 않았다.
  - **PASS**:
    - 정상 라우트
    - 실제 렌더 오류 → 복구 UI, 사이드바·헤더 유지
    - 다른 화면으로 이동하거나 "다시 시도"로 복구
    - 청크 실패 → 복구 UI
    - 자동 새로고침 없음
  - **셸과의 상호작용**: 오류 화면에서 창 포커스를 옮겨도 셸은 새로고침하지 않았다. 대조로 `#root`를 비우고 포커스를 옮기면 셸이 새로고침했다. 새로고침된 페이지는 오류 화면에 머물렀고 추가 새로고침은 없었다.
  - **FAIL**: 청크를 되살린 뒤 "앱 다시 불러오기"를 눌러도 같은 화면이 계속 실패했다.
    - 같은 URL을 `fetch`하면 200이 왔다.
    - 같은 URL로 `import()`하면 여전히 실패했다.
    - `?x=1`을 붙이면 성공했다.
    - 즉 WKWebView는 실패한 모듈 URL을 같은 프로세스 안에서 `location.reload()` 뒤에도 기억한다. WebKit 오류 문구에 URL이 없어 앱 코드로 캐시를 피할 수도 없다.
- **수정** (`RouteErrorBoundary.tsx`): 데스크톱(`__TAURI_INTERNALS__`)의 청크 실패 화면에서는 "앱 다시 불러오기" 버튼을 없애고 "앱을 종료한 뒤 다시 실행하세요"라고 안내한다.
  - 브라우저 동작과 렌더 오류 화면은 그대로다.
  - 앱 relaunch(`tauri-plugin-process`)는 Python Core까지 재시작하므로 이번 UI 수정 범위에서 제외했다.
- **검증**:
  - 테스트 2건을 추가했다(데스크톱 청크 실패, 데스크톱 렌더 오류). 브라우저 청크 실패 테스트에는 재실행 안내가 없는지 확인하는 단언을 더했다. 수정 전에는 1건이 RED였다.
  - 전체 vitest 69 files, 442 passed / 1 skipped. `tsc --noEmit` 통과. `vite build` 성공(scratch outDir).
  - Tauri 재검증:
    - 청크 실패 화면에 재실행 안내와 "다시 시도" 버튼만 있다.
    - 사이드바·헤더가 유지된다.
    - 다시 시도하고 15초를 기다려도 자동 새로고침이 없다.
    - 렌더 오류 화면은 기존 안내 그대로이고, 홈으로 이동하면 해제된다.
- **남는 것**:
  - 앱 재실행(새 프로세스)으로 복구되는지는 UNKNOWN이다.
  - 앱에 내장된 정식 번들(`tauri build`)로는 검증하지 않았다.
  - 셸 `RECOVER_IF_BLANK_JS` 재시도 상한(Issue #1 A-1의 셸 부분)은 그대로 남아 있다.

### PR #33 마무리 — 데스크톱 청크 실패 화면에서 "다시 시도"도 제거

- **이유**: Tauri 재검증에서 데스크톱(WKWebView) 청크 실패 후 "다시 시도"를 누르면 같은 모듈 재요청조차 나가지 않았다(차단 서버 요청 1회 그대로). 버튼을 남기면 복구할 수 있다는 잘못된 기대를 준다.
- **수정** (`RouteErrorBoundary.tsx`): 데스크톱 청크 실패 화면은 버튼 없이 앱 재실행만 안내한다. 렌더 오류의 "다시 시도"와 브라우저 청크 실패의 "다시 시도"·"앱 다시 불러오기"는 그대로다. 화면 이동으로 다른 메뉴를 쓰는 것은 계속 된다.
- **검증**:
  - 데스크톱 청크 실패 테스트에 "다시 시도 없음" 단언을 추가했다(수정 전 RED).
  - 전체 vitest 69 files, 442 passed / 1 skipped. `tsc --noEmit` 통과. `vite build` 성공(scratch outDir).
  - Tauri 재검증:
    - 검색 청크 실패 → 재실행 안내만, 버튼 0개
    - 사이드바·헤더 유지
    - 15초 동안 자동 새로고침 없음
    - 렌더 오류는 "다시 시도" 유지, 홈 이동 시 해제

## 43. 데스크톱 셸 — blank 화면 자동 복구에 예산을 두어 무한 reload 차단 (Issue #1 A-1, 셸 부분)

데스크톱 셸은 창 포커스·트레이 "Open Dashboard"·Dock 재오픈 때마다 `RECOVER_IF_BLANK_JS`를 웹뷰에 eval한다. 기존 스크립트는 `#root`가 비어 있으면 무조건 `location.reload()`했다. 그래서 첫 JS 번들이 깨지면 포커스마다 reload가 끝없이 반복됐다(실측: 포커스 5회 → reload 8회, 간격 1.4~3.0초, 번들 404 요청 9회). §42의 ErrorBoundary는 React가 뜬 뒤의 오류만 막으므로, React가 아예 뜨지 못하는 이 경로는 셸에서 막아야 한다.

- **수정**:
  - `desktop/src-tauri/src/blank_recovery.js`를 새로 두고, `lib.rs`가 `include_str!`로 읽어 기존 3개 경로(포커스·트레이·Reopen)에서 그대로 eval한다. 이벤트 배선은 바꾸지 않았다.
  - **예산**: 정상 화면이 확인되기 전까지 자동 reload는 최대 3회다.
  - **차단**: 4번째 blank 감지 때는 reload하지 않는다. 대신 React 없이 정적 안내를 `#root`에 직접 그리고(`role="alert"`, 버튼 없음, 시작 중 로더 제거), `blocked`를 기록한다. 안내가 있으면 이후 점검은 아무것도 하지 않는다.
  - **차단 해제 없음**: 차단은 자동으로 풀리지 않는다. 앱을 재실행하면 sessionStorage가 비워지면서 풀린다(실측).
  - **카운터 초기화 조건**: 마지막 자동 reload 뒤 60초 이상 지나, 셸 점검에서 `#root`가 비어 있지 않은 것을 확인했을 때만 비운다. React가 잠깐 마운트됐다는 것이나 시간이 흘렀다는 것만으로는 비우지 않는다. 그래서 60초 구간이 지난 뒤에도 정상 화면이 없으면 예산이 새로 생기지 않고, 60초마다 무한 재시도하는 구조가 없다.
  - **부팅 유예**: 페이지 가동 10초 미만의 blank는 부팅 중으로 보고 세지도 reload하지도 않는다.
    - Tauri 실측: 창 생성 직후 첫 포커스 때 HTML이 아직 파싱 중이라 `#root`가 없었다. 기존 로직은 정상 시작인데도 reload했고, 첫 구현도 이 경우 횟수를 셌다(테스트를 추가해 막음).
    - main.tsx도 Core endpoint를 기다리는 동안 최대 약 6초간 `#root`를 비워 둔다.
  - **보수적 처리**: 저장소에 접근하지 못하거나, 값이 손상됐거나, 쓰기가 실패하거나 조용히 무시되면 reload하지 않고 안내를 그린다. 예외가 eval 밖으로 새지 않는다.
  - **기록 순서**: 카운터는 reload 직전에 기록하고, 다시 읽어 확인한 뒤에만 reload한다.
- **조사**:
  - `sessionStorage`는 reload 뒤에 유지된다.
  - WKWebView 렌더러(WebContent)를 강제 종료하면, 창이 보일 때든 숨겨졌을 때든 Tauri 2.11(`tauri-runtime-wry`의 기본 처리기)이 스스로 웹뷰를 reload한다. 이때도 sessionStorage가 **유지된다**. "렌더러가 죽으면 카운터도 초기화된다"는 가정은 **거짓**이었다. 그래서 정상 화면 확인으로 카운터를 비우는 규칙을 둔다.
  - 앱을 재실행하면 sessionStorage가 비워진다.
  - 사용자의 Cmd+R(View > Reload)은 예산과 무관하다. Cmd+R 뒤에도 차단 기록은 유지된다.
- **검증**:
  - 신규 `dashboard/tests/desktop.blank-recovery.test.ts` 28건: 셸이 eval하는 바로 그 파일을 `?raw`로 읽어 jsdom에서 실행한다.
    - 기존 로직을 그대로 옮긴 상태에서 23건이 RED였다(나머지 4건은 원래 통과하는 회귀 가드). 수정 후 전부 GREEN.
    - 부팅 유예 회귀 테스트 1건은 직전 조건에서 RED임을 따로 확인했다.
  - `cargo test`: 14 passed(스크립트 배선 테스트 1건 추가).
  - 전체 vitest: 70 files, 470 passed / 1 skipped. `tsc --noEmit` 통과.
  - **실제 Tauri**: 격리 identifier, 가짜 Core, scratch 프런트 빌드를 썼고 첫 번들을 404로 막았다. 운영 API·MCP·Vite와 `dashboard/dist`는 쓰지 않았다.
    - 정상 시작 + 포커스 3회: reload 0회.
    - 일시적 blank: reload 1회로 복구. `count: 1`이 reload 전에 기록됐고 새 문서에서도 유지됐다.
    - 정상 화면에서 60초 뒤 포커스: 카운터가 비워지고 reload는 없었다.
    - 첫 번들 404 + 실제 포커스 반복:
      - 자동 reload는 정확히 3회(간격 11.8초, 1169초). 번들 404 요청도 3회로 일치한다.
      - 2·3회차 사이 1169초 동안 정상 화면이 없어 카운터가 이어졌다.
      - 4번째 감지 때 안내가 표시됐다(다크 모드 색상, 제목 22px, 화면 고정, 버튼 0개). `blocked: true`가 기록됐다.
    - 앱 재실행: 차단이 해제됐다(`sessionStorage {}`).
- **범위 밖**: A-2~A-5, #23(Core 고아 프로세스), #32, Dashboard UI 구조 변경은 포함하지 않았다.

## 44. 대시보드 — 탭별 호스트 고정: 다른 탭의 호스트 전환이 이 탭의 쓰기를 옮기지 않게 (Issue #32)

활성 호스트(`raven:active_host`, `raven:hosts`)는 탭끼리 공유하는 localStorage에 있다. 그런데 fetch 래퍼(`api-base.ts`)와 `apiFetch`(`api.ts`)가 **요청할 때마다** 이 값을 다시 읽었다. 그래서 다른 탭에서 호스트를 B로 바꾸면, A의 화면을 보고 있는 이 탭의 저장·삭제가 B로 갔다. B에 같은 vault·slug가 있으면 B의 문서가 바뀌거나 지워진다. 호출 직전에 다시 읽는 방식으로는 이 문제를 막을 수 없다.

- **수정**:
  - **탭별 호스트 고정** (`api-base.ts`):
    - 문서가 로드될 때 이 탭의 호스트(id와 원격 주소)를 한 번만 정한다(`getTabHostId`/`getTabHostEndpoint`).
    - 상대 경로 `/api` 래퍼, `sendBeacon`, `apiFetch`, 토큰 선택, 401 안내가 모두 이 호스트만 쓴다.
    - `getActiveHostId`/`getActiveHost`/`getActiveHostUrl`도 이 탭의 호스트를 돌려주므로, 화면에 표시되는 호스트(HostPicker, VaultManage)와 실제 요청 대상이 같다.
    - 다른 탭이 이 호스트의 주소를 바꾸거나 지워도, 이 탭은 로드할 때의 주소로만 보낸다.
  - **다른 탭의 변경 감지**:
    - `watchTabHostChange`는 `storage` 이벤트(`raven:active_host`, `raven:hosts`, 저장소 비움 `key=null`)를 받아, 저장된 선택이 이 탭의 호스트와 달라졌을 때만 알린다.
    - `tab-host-sync.ts`가 같은 탭에서 전환할 때(HostPicker)처럼 처리한다. 캐시를 비우고 `/`로 전체 재로드하며, 이동은 한 번만 한다. `App`이 이를 설치한다.
    - 재로드가 늦어지거나 막혀도(편집 중 beforeunload 취소) 요청은 계속 화면의 호스트로 간다.
  - **캐시** (`api.ts`):
    - `fetchPages`와 `fetchTree`의 키에 호스트를 넣었다(`tree:<vault>@<host>`). `fetchVaults`의 `vaults@<host>`와 같은 형식이고, 기존 `invalidateCache("pages:<vault>")` 접두어 무효화도 그대로 동작한다.
    - **무효화 세대**를 두었다. 무효화 이전에 시작된 요청은 늦게 끝나도 캐시에 쓰지 않는다. 무효화 뒤의 호출은 진행 중이던 이전 요청에 합류하지 않는다.
    - 기존에는 무효화 뒤의 조회가 오래된 진행 중 요청에 합류해, 나중 요청이 먼저 보낸 요청의 결과를 받았다. 이번 RED에서 처음 드러났다.
  - **편집 초안** (`draftStorageKey`, `InlineMarkdownEditor`):
    - 원격 호스트의 초안 키에 호스트를 넣었다(`raven:draft@<host>:<vault>:<slug>`). 같은 vault·slug를 가진 다른 호스트의 페이지에 이 초안이 복구 대상으로 뜨고, 그대로 저장되는 경로를 막는다.
    - 로컬은 기존 키를 그대로 써서 저장된 초안을 보존한다.
- **비동기 응답**:
  - 한 탭은 한 호스트와만 통신하고, 호스트를 바꾸려면 전체 재로드가 필요하다. 그래서 "A 요청 → B 전환 → A의 늦은 응답이 B 화면을 덮음"은 한 탭 안에서 일어날 수 없다. 재로드하면 이전 JS 상태가 사라진다.
  - 트리·페이지·검색·그래프 화면별 stale guard는 추가하지 않았다. 같은 호스트 안의 응답 순서 문제는 #32 범위 밖이다.
  - Layout vault 목록의 기존 가드(PR #31)는 유지한다.
- **기존 테스트 변경**:
  - `Layout.vaults-host-switch.test.tsx`(PR #31)와 `HostAuthBoundary.test.tsx`의 전환 테스트 1건은 "다른 탭이 바꾸면 이 탭의 다음 요청이 새 호스트로 간다"는 수정 전 동작을 전제로 했다.
  - 보호 목적은 그대로 두고 새 불변식에 맞게 고쳤다. 새 불변식은 "탭은 로드할 때의 호스트로 고정, 새 호스트는 재로드 뒤 적용"이다.
  - 다른 호스트의 목록·이름을 섞지 않음, 늦은 응답이 최신 결과를 덮지 않음, 전환 직후 첫 요청이 새 호스트의 토큰을 씀(재로드 후)을 확인한다.
- **검증**:
  - 신규 `tests/cross-host-isolation.test.tsx` 18건:
    - 동작이 없는 자리표시자 상태에서 그때 있던 17건 중 12건이 실패했다.
    - App 설치 테스트는 그 뒤에 추가했다. 감지기만 끈 상태에서 이 테스트를 포함해 4건이 실패했다.
    - 수정 후 18건 모두 통과했다.
  - 고친 기존 테스트를 수정 전 `src`로 돌리면 4건이 실패한다. 진행 중 요청 합류 결함 2건이 여기에 포함된다.
  - 전체 vitest: 71 files, 489 passed / 1 skipped. `tsc --noEmit` 통과. `vite build` 성공(scratch outDir).
  - **Chrome 두 탭 실증**: scratch 정적 서버와 가짜 호스트 A·B를 썼다. 운영 API·MCP·Vite는 쓰지 않았다.
    - 탭 1을 A로 로드했다. 저장소만 B로 바꾼 상태(이벤트 처리 전 구간)에서 PUT·DELETE를 보내자 **둘 다 A로 갔고 B는 0건**이었다.
    - 탭 2에서 B로 전환하자 탭 1이 `storage` 이벤트를 받아 `/`로 재로드했다. 이후 탭 1은 B의 문서만 표시하고 B로만 요청했다.
    - 아직 A 화면인 탭 2의 DELETE는 A로 갔다.
- **남은 것**:
  - `raven:active_vault`, 즐겨찾기, 열린 폴더 같은 UI 선호는 여전히 호스트 구분 없이 공유된다. Layout이 vault 목록으로 검증하므로 쓰기 오귀속 경로는 아니다.
  - 기존 원격 호스트 초안은 이전 키에 남아 있어, 로컬 페이지에서 복구 대상으로 보일 수 있다. 이전과 같은 동작이며 마이그레이션은 하지 않았다.
  - 다른 탭의 전환으로 재로드될 때 편집 중인 내용은 beforeunload 확인과 초안 자동 저장에 기댄다.

### 44-1. PR #35 리뷰 보완 — 레거시 초안 격리, 원격 설정 오류 시 요청 차단

- **P1-1 레거시 초안의 호스트 간 오염** (재현됨):
  - PR #35 이전에는 모든 호스트의 초안이 `raven:draft:<vault>:<slug>` 한 키에 저장됐다. 원격 A에서 쓰던 초안이 남아 있으면, 같은 vault·slug의 로컬 페이지에 "초안 복구"가 떴다.
  - 복구한 뒤 저장하면 로컬에 `PUT {"content":"<A의 초안>"}`이 나갔다. precondition은 로컬 페이지 그대로라 서버도 받아들인다.
  - **수정**: 새 초안은 로컬도 `raven:draft@local:<vault>:<slug>`에 쓴다(위 §44의 "로컬은 기존 키" 결정을 바꿈). 레거시 키에 새 초안이 더 섞이지 않게 하려는 것이다.
  - 레거시 키의 초안은 출처를 알 수 없으므로 편집기로 불러오지 않는다. 로컬·원격 페이지 모두에서 "어느 호스트에서 작성됐는지 알 수 없는 이전 초안" 안내를 띄우고, 읽기 전용 보기와 버리기만 제공한다. 버리기는 사용자가 누를 때만 하고, 일괄 삭제는 하지 않는다.
  - 원격 페이지도 레거시 초안을 숨기지 않으므로, PR #35 이전에 원격에서 쓰던 초안도 계속 볼 수 있다.
- **P1-2 원격 설정 누락 시 로컬 fallback** (재현됨):
  - 원격을 고른 상태에서 다음 경우 `readStoredHost()`가 조용히 로컬 Core로 보냈다: `raven:hosts` 없음, JSON 손상, 활성 ID가 목록에 없음, endpoint 누락.
  - endpoint가 URL이 아니면 `not a url/api/...` 같은 상대 경로로 요청이 나갔다.
  - **수정** (`api-base.ts`):
    - 위 경우와 http(s)가 아닌 endpoint는 설정 오류(`getTabHostError()`)로 처리한다.
    - 이 탭의 `/api` fetch는 `HostConfigError`로 거절하고, beacon은 `false`를 돌려준다. `apiFetch`도 이 경로를 탄다.
    - 저장소 자체를 못 읽는 경우만 로컬로 둔다. 선택을 저장할 수도 없으니 원격 선택이 있을 수 없다.
  - **화면**: `HostConfigGate`가 앱(Layout·라우트) 대신 설정 오류를 보여 준다. 로컬 전환은 사용자가 "로컬로 전환"을 누를 때만 하고, "새로고침"도 둔다.
  - **다른 탭이 원격 호스트를 지운 경우**:
    - `removeHost`처럼 선택을 로컬로 되돌리면, 이 탭은 재로드되어 로컬을 표시한다. 사용자가 다른 탭에서 명시적으로 고른 결과이고, 화면과 요청 대상이 일치한다.
    - 선택을 남긴 채 목록에서만 지우면, 이 탭은 재로드 뒤 설정 오류 화면이 되고 요청은 0건이다.
    - 어느 경우든 재로드 전까지는 로드할 때의 A로만 보낸다.
- **P2 캐시 세대**:
  - 부분 무효화도 전역 세대를 올리므로, 관련 없는 키의 진행 중 요청은 결과를 캐시에 남기지 못한다.
  - 그 요청에 합류한 호출은 같은 결과를 받고, 다음 조회는 다시 요청할 뿐이다. 정합성 결함이 아니라 성능 영향이므로 이번에는 고치지 않았다(테스트로 고정).
- **검증**:
  - 신규 `tests/cross-host-review.test.tsx` 19건:
    - RED(자리표시자 상태)에서 16건이 실패했다. 통과한 3건은 P2, 정상 설정의 게이트, 설정 수정 감지다.
    - 실패 중 "정상 설정" 1건은 테스트 하네스 탓이었다. 재로드를 흉내 낼 때 이전 모듈의 fetch 래퍼가 남아 있었고, 하네스를 고친 뒤 GREEN에서 통과했다.
    - GREEN에서 19건 모두 통과했다.
  - 수정 전 코드에서 별도 재현 스크립트로 확인했다(커밋하지 않음): 레거시 초안 복구 후 저장하면 로컬에 원격 초안이 PUT된다. 깨진 설정 4종은 로컬 `/api`로, 잘못된 endpoint는 `not a url/api/...`로 PUT된다.
  - 기존 초안 키 테스트 2곳(`PageEdit.draft-recovery`, `cross-host-isolation`)을 `@local` 키로 갱신했다.
  - 전체 vitest: 72 files, 508 passed / 1 skipped. `tsc --noEmit` 통과. `vite build` 성공(scratch outDir).
  - **격리 Chrome 실증** (scratch 정적 서버와 가짜 호스트 A, 운영과 분리):
    - 레거시 원격 초안이 있는 로컬 페이지에 "초안 복구" 버튼이 없었다. 읽기 전용 보기는 동작했다.
    - 편집 후 저장한 `PUT`의 본문은 로컬 수정본뿐이었고, 레거시 키는 보존됐다.
    - 활성 ID 없음과 endpoint 누락은 각각 설정 오류 화면을 띄웠고, 두 로드 모두 API 요청이 0건이었다. 수동 PUT은 거절, beacon은 false였다.
    - 두 탭: 탭 1이 A를 보는 중 탭 2가 A를 목록에서 지우자, 탭 1은 설정 오류로 재로드됐고 요청은 0건이었다.
    - "로컬로 전환"을 누르자 선택이 local로 바뀌어 재로드됐고, LOCAL로만 요청했다.

### 44-2. PR #35 최종 경계 — 저장소 읽기 실패, 모순된 호스트 설정

- **저장소 읽기 실패**:
  - 수정 전에는 `readStoredHost()`가 `localStorage` 접근 예외(getter 또는 `getItem`의 SecurityError)를 받으면 무조건 로컬로 돌려줬다. 하지만 원격을 골라 둔 상태일 수 있다.
  - 이제는 선택한 호스트를 확인할 수 없다는 설정 오류로 처리한다. `/api` 읽기·쓰기와 beacon을 막고, `HostConfigGate`를 띄운다.
  - 오류 화면의 "로컬로 전환"이 저장소 쓰기에 실패하면, 재로드하지 않고 실패를 안내한다(재로드해도 같은 오류이기 때문).
- **모순된 설정**:
  - `raven:active_host = "a"`인데 목록의 `a`가 `isLocal: true`이면, 수정 전에는 조용히 로컬로 대체했다.
  - 이제 설정 오류로 처리한다. 로컬 Core로 인정하는 것은 내장 `local` 항목뿐이다.
- **정상 로컬은 그대로**:
  - 선택이 없을 때(첫 실행), 로컬을 선택하고 목록이 손상됐을 때, 로컬을 선택하고 다른 항목이 모순일 때 모두 오류 없이 로컬로 요청한다. 테스트로 고정했다.
- **검증**:
  - `cross-host-review.test.tsx`에 8건을 추가해 27건이 됐다. 추가분은 모순 2건, 저장소 실패 3건, 로컬 회귀 3건이다.
  - 수정 전 `src`에서는 5건이 실패했다(모두 로컬로 대체되는 경우). 수정 뒤에는 27건 모두 통과했다.
  - 처음 RED는 `Storage.prototype` 스파이가 이 환경의 localStorage에 걸리지 않아 하네스 문제로 실패했다. 인스턴스 스파이로 고친 뒤 RED를 다시 확인했다.
  - 전체 vitest: 72 files, 516 passed / 1 skipped. `tsc --noEmit` 통과. `vite build` 성공(scratch outDir).
- **Chrome 실증(44-1)에 미치는 영향**: 없다.
  - 그때 쓴 설정은 모두 저장소를 읽을 수 있었고, `local`만 `isLocal: true`였다. 바뀐 두 분기를 타지 않는다.
  - 게이트 버튼의 성공 경로도 같다.

## 45. 데스크톱 셸 — `mcp_endpoint` 타임아웃을 빈 값이 아니라 오류로 전파 (Issue #1 A-4)

`mcp_endpoint` Tauri 명령은 Python Core가 15초 안에 준비되지 않으면 `Ok("")`를 돌려줬다(`desktop/src-tauri/src/lib.rs`). 빈 문자열은 원래 "Core는 떠 있고 MCP는 꺼져 있음"(`RAVEN_DESKTOP_MCP=0`, 또는 Python이 MCP를 best-effort로 포기함)을 뜻한다. 그래서 Core 기동 실패·지연이 "MCP 꺼짐"으로 위장됐다. 같은 루프의 `core_endpoint`는 같은 상황에서 이미 `Err("Python Core startup timed out")`를 돌려주고 있었다.

- **경로별 결과 (수정 후)**:

  | 상황 | 결과 |
  |---|---|
  | Core 실행 중, MCP 켜짐 | `Ok("http://<mcp_host>:<port>/mcp")` |
  | Core 실행 중, MCP 꺼짐 또는 MCP 기동 실패(best-effort) | `Ok("")` (정상 빈 값) |
  | Core가 15초 안에 준비되지 않음 | `Err("Python Core startup timed out")` (이전: `Ok("")`) |
  | Core 상태 lock 손상 | 같은 `Err` (이전: `Ok("")`) |

  "연결 실패"와 "비정상 응답"(Python 기동 실패, readiness 형식 오류, loopback이 아닌 보고)은 `ManagedCore::start`가 `Err`를 내고 앱을 종료한다(대화상자). 이 명령에서는 Core 상태가 계속 비어 있는 경우, 즉 위의 타임아웃으로만 나타난다.
- **수정**:
  - 두 명령이 같은 대기 함수 `wait_for_core`를 쓴다. 타임아웃이면 `Err`, 기본값은 없다.
  - 기존 오류 문구를 재사용했고, 타임아웃(15초)·폴링 간격(100ms)·재시도 정책은 바꾸지 않았다. `core_endpoint`의 동작도 같다.
  - 오류 문구에는 경로·주소·토큰이 들어가지 않는다.
- **호출자**:
  - 저장소 안에서 `mcp_endpoint`를 호출하는 코드는 없다. 대시보드는 `core_status`(MCP 주소는 `Option`)를 쓴다.
  - 따라서 현재 화면에 보이는 영향은 없고, 이 명령의 계약(웹뷰 권한 `default.toml`에 허용됨)을 바로잡는 수정이다. 호출하는 쪽에서는 Tauri `invoke`가 reject된다.
- **검증**:
  - Rust 단위 테스트 6건을 추가했다. 테스트 전용 `ManagedCore::for_test`로 실행 중인 Core를 흉내 낸다. 확인 항목은 다음과 같다:
    - 정상 endpoint
    - 정상 빈 값
    - 타임아웃
    - lock 손상
    - 대기 중 준비 완료
    - `core_endpoint` 회귀
  - 수정 전 의미의 자리표시 구현에서 2건(타임아웃, lock 손상)이 `Ok("")`로 실패했다. 수정 후 `cargo test` 20건이 모두 통과했다.
  - clippy 신규 경고는 없다. 기존 1건은 Reopen 처리부다. 새 코드는 rustfmt 형식에 맞췄다(기존 파일의 rustfmt 차이는 그대로 둠).
- **범위 밖 발견 (수정하지 않음)**:
  - `core_endpoint`/`mcp_endpoint`는 `async` 명령인데 `std::thread::sleep`로 대기해, 최대 15초 동안 async 런타임 스레드를 막는다.
  - lock이 손상되면 회복되지 않는데도 15초를 다 기다린 뒤에 오류를 낸다.
  - MCP 기동 실패와 MCP 꺼짐은 readiness JSON에서 구분되지 않는다(`mcp_port` 생략). 그래서 `core_status`와 `mcp_endpoint` 모두 둘을 같은 값으로 보고한다.

## 46. 대시보드 — 미등록 경로를 빈 화면 대신 "페이지를 찾을 수 없습니다"로 (Issue #1 A-5)

A-5의 원래 질문은 Tauri 프로덕션 번들에서 `/page/vault/slug` 같은 경로를 직접 새로고침할 때 `index.html` fallback이 보장되느냐였다. 결론은 보장된다는 것이다. Tauri 2.11.5의 asset 해석(`get_asset`)이 `{path}` → `{path}.html` → `{path}/index.html` → `index.html` 순서로 찾는다. 격리 Tauri 런타임에서도 중첩 한글 경로 새로고침, query·hash가 붙은 직접 이동, `/raw/...` 경로가 모두 같은 경로에서 마운트됐다. 그래서 BrowserRouter를 유지하고 HashRouter로 바꾸지 않는다.

문제가 남은 곳은 라우트 표다. catch-all이 없어서 미등록 경로(`/no/such/route`, vault가 빠진 `/page` 등)에서는 `<Routes>`가 아무것도 그리지 않았고, `#root`가 비었다. 데스크톱 셸의 blank 복구(§43)는 이 상태를 번들 고장과 구분하지 못한다. 그래서 자동 reload를 3회 한 뒤 "앱을 완전히 종료한 뒤 다시 실행해 주세요" 차단 안내로 끝났다(격리 Tauri 실측). 이 경로로 들어오게 되는 계기는 다음과 같다:
- 본문에 직접 쓴 `[x](/foo)` 같은 링크
- 바뀐 옛 주소
- 오타

본문 링크는 클릭할 때 문서 전체를 다시 불러오므로 바로 이 경로를 탄다.

- **수정**:
  - `App.tsx`의 Layout 아래 마지막 자식으로 `<Route path="*">` → `NotFoundPage`를 추가했다.
  - `NotFoundPage`는 기존 `EmptyState`와 `Button`을 재사용한다. 디코드한 경로를 보여 주고, "홈으로 가기" 버튼은 `navigate("/")`로 문서를 다시 불러오지 않고 이동한다.
  - 다른 라우트와 같은 `RouteSlot`으로 감싸지만 lazy로 두지 않는다. 청크 로딩이 실패해 다시 빈 화면이 되는 일을 피하기 위해서다.
  - 기존 라우트의 순서와 파라미터, BrowserRouter, 셸 복구 스크립트는 바꾸지 않았다.
- **검증**:
  - `tests/App.unknown-route.test.tsx`에 7건을 추가했다. 실제 App을 `#root` 안에 렌더하고 라우트 모듈만 표식으로 mock한다. 확인 항목:
    - 미등록 경로
    - `/page`
    - 한글 경로 디코드
    - 홈 이동
    - `/` 회귀
    - 중첩 한글 경로의 파라미터·query·hash 회귀
    - 셸 blank 복구 비대상: `blank_recovery.js`를 그대로 실행해 reload와 카운터가 0인지 확인
  - 수정 전에는 5건이 실패했다(회귀 2건은 통과). 임시 probe로 측정하니 `#root` 자식이 0개였고, 복구 스크립트가 reload를 3회 호출했다.
  - 수정 후 7건이 모두 통과했다. 전체 vitest는 73 files, 523 passed / 1 skipped다. `tsc -b --noEmit` 통과, `vite build` 성공(scratch outDir).
  - Tauri 런타임 결과는 PR 본문에 둔다.
- **범위 밖 (후속 후보, 수정하지 않음)**:
  - wikilink `<a>` 클릭이 문서 전체를 다시 불러오는 문제(SPA 이동으로 바꾸는 것이 후보)
  - 본문의 외부 링크가 웹뷰 자체를 다른 사이트로 이동시키는 문제
  - Tauri에서 debug-log beacon이 `tauri://localhost/api/debug-log`로 가는 문제
  - Core가 시작에 실패하면 "Raven 시작 중…"이 끝나지 않는 문제

## 47. 데스크톱 셸 — Core 준비 대기가 async 런타임 워커를 붙잡지 않게 (Issue #1 A-2)

`core_endpoint`/`mcp_endpoint`는 async Tauri 명령인데, 대기 루프(`wait_for_core`)가 명령 안에서 바로 돌며 `std::thread::sleep(100ms)`로 폴링했다. Tauri async 런타임의 워커 스레드는 CPU 수만큼(이 기기 8개)이다. Core가 늦으면 호출 하나가 워커 하나를 최대 15초 붙잡는다. 동시 호출이 워커 수를 넘으면 뒤의 호출과 다른 async 작업(플러그인 명령 등)이 앞의 대기가 끝날 때까지 시작조차 못 한다.

- **수정**:
  - 대기 자체(`wait_for_core`, 15초 타임아웃, 100ms 폴링, 반환 계약)는 그대로 두었다.
  - 새 `off_runtime`이 그 대기를 `tauri::async_runtime::spawn_blocking`으로 blocking 풀에서 돌린다. 두 명령은 `AppHandle`을 받아 클로저 안에서 `CoreState`를 읽는다. webview 쪽 invoke 인자는 바뀌지 않는다.
  - 새 의존성은 없다. `tokio::time::sleep`은 tokio를 직접 의존성으로 추가해야 해서 택하지 않았다. readiness 알림(Condvar/Notify)은 `CoreState` 구조와 재시작 경로까지 바꾸게 되어 택하지 않았다.
  - lock은 매 폴링마다 잡았다 놓으므로 sleep이나 await 너머로 guard를 들고 있지 않다. 대기는 상태를 읽기만 하므로, 호출이 취소돼도 공유 상태는 바뀌지 않는다.
  - 새 오류 경로는 대기 작업 자체가 panic한 경우의 `Python Core wait failed: …` 하나뿐이다. 정상 경로의 값과 오류 문자열은 그대로다.
- **검증**:
  - `lib.rs` 테스트에 5건을 추가했다. 모두 실제 `tauri::async_runtime` 위에서 명령과 같은 경로(`off_runtime`)로 돈다.
    - 워커 비점유: 준비 안 된 Core에 64개를 동시에 대기시키는 동안 다른 작업이 200ms 안에 실행되는지, 그리고 64개가 타임아웃 한 번 남짓에 같은 오류로 끝나는지
    - 준비된 Core는 실제 정책 상수(15초/100ms)로도 폴링 간격 없이 바로 응답하는지, MCP 켜짐/꺼짐(`""`) 계약
    - 타임아웃 오류 문자열 유지
    - 동시 호출 32개가 Core 준비 후 모두 같은 값을 200ms 안에 받는지
    - 취소된 호출이 lock을 오염시키거나 상태를 바꾸지 않는지
  - RED는 같은 경계 함수에 지금 동작(명령 안에서 바로 대기)을 넣고 돌렸다. 워커 비점유 테스트가 "다른 async 작업이 4.78초 동안 실행되지 못했다"로 실패했다. 나머지 4건은 단독으로는 통과했다(계약 테스트). 함께 돌리면 남은 대기가 워커를 붙잡아, 준비된 Core의 응답까지 0.56~3.6초 밀렸다.
  - 수정 후 `cargo test` 25건이 모두 통과했다(새 5건은 연속 6회 반복해도 통과). `cargo build` 성공. `cargo clippy --all-targets`의 신규 경고는 없다(기존 1건은 Reopen 처리부로 master와 같다). 새 코드는 rustfmt 형식에 맞췄다.
  - Tauri 런타임 결과는 PR 본문에 둔다.
- **범위 밖 (수정하지 않음)**:
  - Core 기동(`CoreState::start`)도 `async_runtime::spawn` 안에서 readiness 줄을 blocking `read_line`으로 기다린다. 그래서 기동 중에는 워커 하나를 쓴다. 이번 범위는 대기 명령이고, Core 기동 방식은 바꾸지 않는다.
  - lock이 손상돼도 15초를 다 기다린 뒤에 오류를 내는 문제, MCP 기동 실패와 MCP 꺼짐을 구분하지 못하는 문제(§45의 범위 밖 항목)는 그대로다.

## 48. 데스크톱 셸 — 시작 실패 안내를 osascript 대신 tauri_plugin_dialog로 (Issue #1 A-3)

Core가 처음 뜨지 못하면(`CoreState::start`가 `Err`) 셸은 macOS 전용 `osascript`로 "Raven failed to start" 대화상자를 띄운 뒤 `exit(1)`했다. Linux/Windows에서는 `osascript`가 없어 안내 없이 바로 종료됐다. 또 `osascript`의 `.status()`가 사용자가 OK를 누를 때까지 async 런타임 워커 하나를 붙잡았다.

- **수정**:
  - 실패 감지 조건과 문구(`Raven failed to start:\n{오류}`)는 그대로 두었다. `osascript` 호출과 AppleScript용 이스케이프를 지웠다.
  - 새 `report_startup_failure_and_exit`가 이미 등록된 `tauri_plugin_dialog`(2.7.3)의 `MessageDialogBuilder::show(콜백)`으로 오류 아이콘·OK 버튼 대화상자를 띄운다. `show`는 바로 반환한다. 플러그인이 메인 스레드에서 대화상자를 띄우고, 사용자가 응답하면 별도 스레드에서 콜백을 부른다. 콜백에서 `exit(1)`하므로 "확인 후 종료"는 그대로이고, 워커도 이벤트 루프도 막지 않는다. `blocking_show`는 호출 스레드를 막기 때문에 쓰지 않았다.
  - `Builder::build()`가 실패하는 경로에는 아직 이벤트 루프도 `AppHandle`도 없어서 플러그인을 쓸 수 없다. 이 경로는 사용자 결정에 따라 stderr 출력 후 `exit(1)`만 한다(새 의존성 ❌). macOS에서 이 드문 경로의 GUI 안내는 사라진다.
  - 플랫폼별 분기는 없다. 새 의존성도 없다.
- **검증**:
  - `lib.rs` 테스트 2건 추가: 오류 문구가 이스케이프 없이 그대로 전달되는지, 소스에 `osascript` 호출이 다시 들어오지 않고 플러그인 경로가 남아 있는지.
  - macOS 격리 런타임(릴리스 빌드, 임시 HOME, API 포트 18765/18775, MCP 꺼짐): 정상 기동이면 대화상자 없음. 기동 실패면 stderr에 문구가 찍히고 앱은 종료되지 않은 채 대화상자 하나를 띄운다. 이때 메인 스레드는 `NSApplication run`에서 이벤트를 받고 tokio 워커 8개는 모두 대기(park) 상태다.
  - 대화상자를 확인하면 프로세스가 끝난다. 관측된 종료 코드는 0이다. master도 같다: `osascript`를 즉시 끝나는 가짜로 바꿔 master를 돌려도 0이다. Tauri wry 런타임이 `App::run`에서 `RequestExit(code)`를 코드 없는 `ControlFlow::Exit`로 처리하기 때문이다. 종료 정책(`handle.exit(1)` 호출)은 바꾸지 않았다.
  - Linux 컨테이너(`rust:1-bookworm`, aarch64)의 `cargo check`는 기존 `RunEvent::Reopen`(macOS 전용 variant) 한 곳에서 실패한다. 이번 변경과 무관한 master의 상태이고, 이번 변경에서 나온 추가 오류는 없다. Windows는 이 기기에서 확인하지 못했다.
  - Tauri 런타임 결과와 플랫폼별 범위는 PR 본문에 둔다.
- **범위 밖 (수정하지 않음)**:
  - Core 기동 자체는 여전히 `async_runtime::spawn` 안에서 blocking `read_line`으로 readiness를 기다린다(§47 범위 밖 항목과 같다).
  - 재시작 실패(트레이 "Restart Backend", `restart_core`)는 원래 대화상자가 없었고 그대로다.
  - `handle.exit(1)`의 종료 코드가 0으로 나가는 문제(`run_return` 필요), Linux에서 `RunEvent::Reopen` 때문에 빌드가 안 되는 문제는 별도 후속으로 둔다.

## 49. 데스크톱 셸 — Linux 빌드 실패 수정: `RunEvent::Reopen`을 macOS에서만 매칭 (Issue #40)

`app.run` 콜백이 `RunEvent::Reopen`(Dock 아이콘을 다시 눌렀을 때 숨긴 창 복구)을 조건 없이 매칭했다. Tauri 2.11.5는 이 variant를 `#[cfg(target_os = "macos")]`로만 정의한다. 그래서 Linux에서는 `error[E0599]: no variant named Reopen`으로 셸 빌드가 깨졌다(#1 A-3 검증 중 발견). CI(`desktop-release.yml`)는 `macos-14`만 돌아서 잡지 못했다.

- **수정**:
  - 해당 match arm에 `#[cfg(target_os = "macos")]`를 붙였다. Tauri의 정의와 같은 조건이다.
  - macOS에서는 cfg가 참이므로 컴파일되는 코드가 이전과 같다. Dock 재오픈 동작은 그대로다.
  - 다른 플랫폼에서는 이 이벤트 자체가 없으므로 잃는 동작이 없다. 새 의존성은 없다.
- **검증**:
  - `lib.rs` 테스트 1건 추가: `Reopen` 처리부 바로 앞에 `#[cfg(target_os = "macos")]`가 있는지 소스로 확인한다(macOS CI만으로는 회귀를 잡을 수 없어서).
  - macOS(aarch64): `cargo test` 28/28, `cargo build` 성공. `cargo clippy --all-targets` 경고 1건은 master와 같다(이 `Reopen` arm 안의 collapsible-if).
  - Linux(Docker `rust:1-bookworm`, rustc 1.99.0, aarch64): `cargo check --locked --all-targets` 성공, `cargo test --locked` 28/28, `cargo clippy --locked --all-targets` 경고 0건, `cargo build --locked` 성공.
  - Windows: 같은 컨테이너에서 `x86_64-pc-windows-msvc` 대상 `cargo check`를 시도했다. 의존성 `ring`의 C 빌드 스크립트가 MSVC 툴체인 없이 실패해, 우리 crate까지 가지 못했다. **UNKNOWN**.
  - macOS Dock 재오픈의 런타임 재검증은 하지 않았다. 컴파일되는 코드가 같아서다(`.app` 번들이 있어야 Reopen 이벤트가 온다).
- **범위 밖**:
  - Linux/Windows 런타임 동작(창, 트레이, 대화상자)은 확인하지 않았다(**UNKNOWN**).
  - Linux `cargo check`를 CI에 추가하는 일은 별도로 결정한다.

## 50. Desktop Core — readiness가 다른 서버를 가리키지 않게 포트 선택과 정체성 확인 (Issue #22)

원격 모드(`RAVEN_ALLOW_REMOTE=1`, `--host 0.0.0.0`)에서 다른 프로세스가 `127.0.0.1:P`를 쓰고 있어도 Desktop Core가 `*:P`에 bind했다. 그리고 readiness로 `127.0.0.1:P`를 알렸다. macOS/BSD는 `SO_REUSEADDR`이면 이 bind를 허용하고, loopback 연결은 더 구체적인 bind인 다른 서버가 받는다. 격리 재현에서 webview 주소로 보낸 페이지 생성 요청이 **다른 서버의 vault에 기록**됐다. 반대로 다른 서버가 `0.0.0.0:P`이고 Core가 loopback이면, Core가 그 서버의 loopback 트래픽을 가로챘다.

- **수정** (`raven/desktop/runtime.py`):
  - `_free_port` → `_bind_api_socket`. 후보 포트(8765 → OS 할당)마다 실제 소켓을 bind·listen하고, loopback(webview가 접속하는 주소)과 bind 주소로 connect해 **우리 accept 큐에 들어오는지** 확인한다. 다른 프로세스가 받거나 timeout 등 판단이 불확실하면 점유로 보고 다음 후보로 넘어간다. ECONNREFUSED만 "비어 있음"으로 인정한다.
  - 기본 포트는 bind 전에도 한 번 connect해 본다. 우리 `127.0.0.1:P`가 생기면 `0.0.0.0:P`의 다른 서버를 가려서 이후 검사가 자기 자신만 보기 때문이다.
  - 확인한 그 소켓을 `uvicorn.Server.run(sockets=[...])`로 넘긴다. 사전 검사와 실제 bind 사이에 다른 프로세스가 끼어들 틈(TOCTOU)이 없다.
  - `SO_REUSEADDR`는 유지한다. 직전 실행이 TIME_WAIT로 남긴 포트도 그대로 다시 쓴다.
  - readiness를 출력하기 전에 정체성을 확인한다. 기동마다 메모리에만 있는 nonce를 만들고, API 앱을 감싼 `_ProbeResponder`가 그 nonce 헤더(`x-raven-core-probe`)가 실린 요청을 받으면 이벤트를 세운다. readiness 주소로 probe를 보내 **이 프로세스가 받았을 때만** ready를 알린다. 응답 내용은 근거로 쓰지 않으므로 다른 서버가 204를 돌려줘도 통과하지 않는다. 실패하면 서버를 내리고 1로 종료한다. 영구 토큰이나 새 엔드포인트는 없다.
  - 이 nonce는 **인증이 아니라 정체성 확인**이다. 아무 권한도 주지 않고 다른 곳에서 검사하지도 않는다. 값을 보낸 클라이언트는 앱 대신 빈 204를 받을 뿐이며, 접근 제어는 그대로 앱의 `TokenGate`가 맡는다.
- **검증**:
  - `tests/test_desktop_runtime.py` 7건 추가. 기본 포트 선택 / `127.0.0.1:P` 점유 + `0.0.0.0` 요청 / `0.0.0.0:P` 점유 + loopback 요청 / 직전에 닫힌(TIME_WAIT) 포트 재사용 / 다른 서버가 probe에 응답해도 거부 / probe는 앱으로 전달되지 않음 / 종단 간: 다른 Raven API가 `127.0.0.1:P`에 있을 때 쓰기가 Desktop vault에만 생김. 수정 전 코드에서는 7건 모두 실패한다(종단 간 테스트는 `assert P != P`).
  - 전체 suite 1978 passed. 실패 2건(`test_desktop_core_survives_closed_stderr_pipe`, `test_no_candidates_is_not_an_error`)은 master에서도 같다.
  - 격리 포트 재현 5종: 충돌 없음 / 원격+loopback 충돌 / loopback+loopback 충돌 / `0.0.0.0` 점유+loopback / Tailscale IP. 앞의 4종은 readiness가 자기 Core를 가리키고 쓰기가 Desktop vault에만 생긴다.
- **범위 밖 (#16)**:
  - Tailscale IP처럼 loopback이 아닌 특정 주소로 bind하면 Core는 loopback에 없다. 그래서 readiness(`127.0.0.1`)는 원래부터 자기 Core가 아니다. 이 경우 정체성 확인은 건너뛰고 stderr에 경고만 남긴다. 충돌이 없으면 동작은 이전과 같다(같은 포트, 원격 접근 그대로). 다만 `127.0.0.1:8765`에 다른 서버가 있으면 이제 그 포트를 피한다. 그래서 webview는 다른 서버 대신 연결 거부를 받고, 원격 클라이언트용 포트는 OS 할당 값으로 바뀐다.
  - readiness 이후 다른 프로세스가 더 구체적인 주소(`127.0.0.1:P`)로 bind해 가로채는 경우는 막지 못한다. macOS `SO_REUSEADDR` 의미상 그렇다. 격리 포트 실측: 원격 모드(`*:P`)에서 Core가 ready를 알린 뒤 다른 `raven.api`가 `127.0.0.1:P`로 뜨면 loopback 요청이 그쪽으로 간다(**CONFIRMED**, master도 동일해 이번 변경으로 악화되지 않음). 기본 loopback 모드에서는 같은 주소 bind가 `EADDRINUSE`로 실패하고, `0.0.0.0:P` bind는 성공하지만 loopback은 Core에 남는다(재현 안 됨).
  - Linux 실행 결과는 없다(**UNKNOWN**). Linux는 이 충돌을 bind 단계에서 거부하므로 동작이 같을 것으로 보지만 확인하지 않았다.
  - MCP 포트 검사(`_port_is_free`)는 같은 구조의 문제가 남아 있다. IPv6 wildcard(`--host ::`)는 IPv4 소켓만 쓰는 탓에 여전히 기동에 실패한다.

## 51. 데스크톱 셸 — 셸이 SIGTERM 등으로 죽어도 Python Core가 고아로 남지 않게 (Issue #23)

셸(`raven-desktop`)은 Core 정리를 `RunEvent::Exit`/`ExitRequested`에서만 했다. 신호 핸들러가 없어서 SIGTERM·SIGHUP을 받거나 크래시·SIGKILL로 죽으면 이 경로를 타지 않았다. 그래서 Core(`python -m raven.desktop.runtime`)가 고아로 남아 API/MCP 포트를 계속 잡았다. 다음 기동은 "MCP port … already in use"로 MCP를 건너뛰었다.

- **수정**:
  - 셸이 Core를 띄울 때 자기 PID를 `RAVEN_DESKTOP_PARENT_PID`로 넘긴다(`core.rs`).
  - 감시 대상은 `main()` 맨 앞에서 정한다. Core는 readiness 이후 대기 루프(0.1초 주기)에서 `os.getppid()`가 그 값과 달라지면(부모가 죽어 재부모화됨) 기존 종료 경로로 서버를 내린다. 소켓이 닫혀 포트가 풀린다. 셸이 API/MCP 기동 중에 죽어도 기동이 끝나는 즉시 같은 경로로 종료한다.
  - 그 시점에 값이 실제 부모 PID와 다르면, 그 PID의 프로세스가 **이미 없을 때**(셸이 인터프리터 기동 중에 죽음)는 계속 감시해 종료한다. 살아 있는 다른 프로세스이거나 형식이 틀리면 감시하지 않는다(경고만). 살아 있는 부모를 두고 잘못 종료하는 일이 없다. 변수가 없으면(standalone 실행, 테스트) 동작이 이전과 같다.
  - Rust 신호 핸들러를 넣지 않아 새 의존성이 없다. 상주 데몬도 없다. updater 종료 계약도 바뀌지 않는다.
- **검증 (macOS, 실제 셸 debug 바이너리, 격리 HOME + 포트 28790/28791)**:
  - 수정 전: SIGTERM / SIGHUP / SIGKILL 모두 Core 생존, 두 포트 LISTEN 유지.
  - 수정 후: 세 경우 모두 3초 안에 Core 종료, 포트 해제. SIGTERM 직후 재실행하면 같은 포트(28790/28791)로 MCP까지 정상 기동한다.
  - 정상 Quit(`NSRunningApplication.terminate` → `RunEvent::Exit`)은 수정 전후 모두 정상 정리된다.
  - 기동 중 셸 SIGTERM(Core 생성 직후 0초·0.05초 = 모듈 import 중, 0.15~0.5초 = API bind 후 MCP 준비 전, 0.8초·readiness 직후): 모두 기동 시작 후 약 1초 안에 Core 종료, 포트 해제. 첫 PR HEAD(`1a89ff8`, 감시를 readiness 뒤에 설정)에서는 readiness 전 종료(0초, 0.3초)에서 고아가 남았다.
  - `tests/test_desktop_runtime.py` 4건 추가: 부모 PID 판정(이미 죽은 부모 포함) / SIGTERM으로 대리 셸을 죽이면 Core가 종료되고 포트가 풀림 / 대리 셸이 Core 기동 중에 끝나도 Core가 종료됨 / Rust와 Python의 env 이름 일치. master 코드에서는 4건 모두 실패한다(종료 테스트는 `Core outlived its shell`). 감시를 readiness 뒤에 정하던 첫 PR HEAD `1a89ff8`에서는 이미 죽은 부모 판정과 기동 중 종료 테스트가 실패한다.
  - 전체 pytest 1980 passed. 실패 2건은 master와 같다. `cargo test` 28/28.
- **범위 밖 / UNKNOWN**:
  - Core 재시작(트레이 / `restart_core`)과 updater relaunch(`request_restart` → `RunEvent::Exit`)는 코드가 바뀌지 않았다. 새 Core도 같은 셸 PID를 받으므로 감시 조건은 같다. UI로 실행해 확인하지는 않았다(**UNKNOWN**).
  - 플랫폼: macOS는 위에서 실제로 검증한 종료 경로만 PASS. Linux는 **UNKNOWN**(부모가 죽으면 init 또는 subreaper로 재부모화되므로 같은 감시가 동작할 것으로 보지만 실행하지 않았다). Windows는 **UNKNOWN**이며 이 방식에 제약이 있다: 부모가 죽어도 `os.getppid()` 값이 바뀌지 않아 감시가 동작하지 않을 것으로 본다.
  - 셸이 죽은 뒤 그 부모가 셸을 회수(reap)하지 않아 좀비로 남아 있는 동안 Core가 `main()`에 들어가면, 셸 PID가 아직 존재해 감시가 꺼질 수 있다. launchd나 일반 실행기는 곧바로 회수하므로 실측에서는 나타나지 않았다.
  - SIGINT는 백그라운드 실행 셸이 무시해 재현 조건을 만들지 못했다. 셸이 SIGINT로 종료되는 경우는 같은 경로로 정리된다.

## 52. Desktop Core — 원격 모드에서 ready 이후 `127.0.0.1:P`를 다른 프로세스가 가로채지 못하게 (Issue #49)

#22 수정 후에도 남은 경로다. 원격 모드에서 Core는 `0.0.0.0:P`에 bind하고 readiness를 알린다. 그 **뒤에** 다른 프로세스가 `127.0.0.1:P`에 bind하면 macOS는 이를 허용한다(`SO_REUSEADDR` 또는 `SO_REUSEPORT`). 더 구체적인 주소가 이기므로 webview의 loopback 요청이 그 프로세스로 갔다(격리 재현: 다른 `raven.api`의 vault가 응답).

- **수정** (`raven/desktop/runtime.py`):
  - bind 주소가 `0.0.0.0`이면 같은 포트의 `127.0.0.1:P`도 함께 bind한다(`_bind_loopback_guard`). 두 소켓을 uvicorn에 함께 넘긴다(`Server.run(sockets=[wildcard, loopback])`). 같은 주소를 이미 우리가 잡고 있으므로, 다른 프로세스의 bind는 `SO_REUSEADDR`·`SO_REUSEPORT` 어느 조합이든 `EADDRINUSE`로 실패한다.
  - Linux는 wildcard가 listen 중이면 `127.0.0.1:P` bind를 아예 거부한다. 다른 프로세스뿐 아니라 우리 guard도 거부된다. 그래서 **Linux에서 `EADDRINUSE`일 때만** wildcard 소켓만으로 진행한다(Linux에서는 이것으로 이미 안전).
  - 그 밖의 실패(Linux의 다른 errno, macOS 등 다른 플랫폼의 모든 실패 — macOS에서는 다른 프로세스가 그 주소를 잡았다는 뜻)는 fail-closed다. 이미 잡은 API 소켓을 닫고 readiness를 알리지 않은 채 1로 종료한다.
  - loopback 기본 모드, Tailscale IP 등 특정 주소 bind, API 인증, MCP 정책은 바뀌지 않는다.
- **검증**:
  - 소켓 실측(별도 프로세스가 `127.0.0.1:P` bind 시도, `reuseaddr`/`reuseport` 4조합):
    - macOS 25.2, guard 없음: `SO_REUSEADDR` 또는 `SO_REUSEPORT`를 켜면 bind 성공, loopback이 그쪽으로 감.
    - macOS 25.2, guard 있음: 4조합 모두 `EADDRINUSE(48)`, loopback은 guard 소켓.
    - Linux(Docker `python:3.12-slim`, linuxkit 6.10, root): guard 유무와 무관하게 4조합 모두 `EADDRINUSE(98)`. guard bind 자체도 98로 실패.
  - 격리 포트 재현(macOS): Core `0.0.0.0` ready 후 다른 `raven.api`를 `127.0.0.1:P`로 기동하면 master는 가로채짐. 수정 후에는 다른 서버가 `EADDRINUSE(48)`로 기동에 실패하고 loopback은 Core가 응답한다. loopback 모드 두 경우는 수정 전후 같다(가로채지 않음).
  - 두 소켓 처리(macOS): loopback 순차 GET 200회와 동시 GET 300회(32 스레드) 모두 200. tailnet IP 경유 GET 20회(wildcard 소켓, 토큰 없음) 모두 401. 페이지 POST 1회는 파일 1개를 만들고, `log.md` 기록 수는 master 단일 소켓과 같다. SIGTERM 시 exit 0이고 두 리스너 모두 해제, stderr 오류 없음.
  - `tests/test_desktop_runtime.py` 8건 추가: guard가 `reuseaddr`/`reuseaddr+reuseport` 후발 bind를 막고 loopback이 우리 소켓으로 옴(2) / fallback은 Linux+`EADDRINUSE`만, Linux 다른 errno·macOS `EADDRINUSE`는 예외이고 실패한 소켓은 닫힘(3) / guard를 못 잡으면 readiness 없이 exit 1, API 소켓 닫힘 / loopback 모드는 guard를 요청하지 않음 / 종단 간(ready 후 다른 API 기동 → 쓰기는 Desktop vault에만). master 코드에서는 종단 간 테스트가 macOS에서 실패한다(Desktop vault에 파일이 없음).
  - Linux(Docker): `tests/test_desktop_runtime.py` 37 passed, 1 failed(`test_desktop_core_survives_closed_stderr_pipe`, macOS와 같은 기존 실패). 실제 Linux 커널에서 `0.0.0.0` Core 옆 guard가 `EADDRINUSE` → `None`으로 fallback하는 것을 확인했다. master에서는 종단 간 테스트가 통과한다(Linux는 원래 취약하지 않음).
  - macOS 전체 pytest 1990 passed. 실패 2건은 기존과 같다. Rust 코드는 바뀌지 않았다.
- **한계**:
  - Linux는 Docker linuxkit 커널, root 사용자로만 확인했다. 데스크톱 Linux 배포판과 다른 사용자 조합(`SO_REUSEPORT`는 같은 UID 조건)은 **UNKNOWN**. Windows는 **UNKNOWN**.
  - macOS에서 다른 UID의 프로세스로는 시험하지 않았다.

## 53. Desktop Core — 광고한 MCP endpoint를 다른 서버가 받지 않게 (Issue #50)

Desktop MCP 포트 검사 `_port_is_free(host, port)`는 #22 이전 API 검사와 같은 구조였다. bind 주소에서만, `SO_REUSEADDR`를 켠 채 시험 bind했다. macOS는 주소가 겹치는 다른 리스너가 있어도 이 bind를 허용한다. 그래서 standalone MCP가 떠 있어도 Desktop MCP가 같은 포트에 함께 떴다(격리 재현, master `3ec889b`):

- 다른 서버 `127.0.0.1:P` + Desktop MCP `0.0.0.0:P` → `127.0.0.1:P`로 접속하는 로컬 에이전트가 다른 서버에 연결됨.
- 다른 서버 `0.0.0.0:P` + Desktop MCP `127.0.0.1:P` → Desktop이 양보하지 않고 다른 서버의 loopback 트래픽을 가림.
- 다른 서버 `100.x:P`(Tailscale IP) + Desktop MCP `0.0.0.0:P` → **readiness가 광고한 `100.x:P`를 다른 서버가 받음**. 지금 운영 구성(standalone MCP `100.x:8766`)과 같은 형태다.

- **수정** (`raven/desktop/runtime.py`):
  - #22의 후보 포트 검사를 `_claim_port(host, port, dial_hosts)`로 분리해 API와 MCP가 함께 쓴다. API 동작은 같다.
  - `_port_is_free` → `_bind_mcp_socket(host, port, advertised)`. 접속 주소(광고할 host, `0.0.0.0`/loopback bind면 `127.0.0.1`, 특정 주소 bind면 그 주소)마다 bind 전 connect와 bind+listen 후 자기 accept 큐 확인을 거친다. 하나라도 다른 프로세스가 받으면 None을 돌려주고, 기존 정책대로 MCP를 양보해 API만 띄운다. 포트는 고정(기본 8766)이고 대체 포트는 쓰지 않는다.
  - 확인한 소켓을 그대로 MCP uvicorn에 넘긴다(`Server.run(sockets=[...])`). 검사와 bind 사이의 TOCTOU가 없다.
  - readiness에 `mcp_port`를 넣기 전에, MCP 앱을 감싼 `_ProbeResponder`(기동마다 새 nonce, 인증 아닌 정체성 확인)로 광고 host와 loopback(wildcard/loopback bind일 때)을 probe한다. 이 프로세스가 받지 못하면 MCP를 내리고 API만 알린다.
  - MCP 인증(`LanTokenAuth`), API 인증, 포트 번호 정책은 바뀌지 않았다.
- **검증**:
  - 위 세 충돌: 수정 후 모두 readiness에 `mcp_port`가 없다(API only, 경고 출력). 다른 서버의 리스너는 그대로이고 Desktop은 그 포트를 잡지 않는다.
  - 충돌 없음(`0.0.0.0`): `mcp_port` 유지. 광고한 `100.x:P`는 Desktop MCP가 받는다(토큰 없음 → 401). loopback `127.0.0.1:P`도 Desktop MCP가 받는다(406).
  - `tests/test_desktop_runtime.py` 7건 추가: 세 겹침 경우 양보(광고 IP 경우는 이 호스트의 비-loopback 주소로 대신하며, 없으면 생략) / 충돌 없으면 포트 유지(2) / 충돌 시 readiness에 `mcp_port` 없음 / 다른 포트로 서빙되는 등 광고 endpoint를 받지 못하면 `mcp_port`를 알리지 않음. master에서는 종단 간 테스트가 `mcp_port`가 있어서 실패한다.
  - macOS 전체 pytest 1997 passed. 실패 2건은 기존과 같다. Linux(Docker `python:3.12-slim`, linuxkit 6.10, root)는 `test_desktop_runtime.py`·`test_mcp_lan_token_auth.py` 60 passed, 1 failed(같은 기존 실패)이고, 신규 MCP 테스트 7건은 광고 IP 경우까지 모두 통과했다.
- **잔여 위험**:
  - readiness **이후** 다른 프로세스가 더 구체적인 주소(`127.0.0.1:P`, `100.x:P`)로 bind해 MCP를 가로채는 경로는 남아 있다(#49의 MCP 판). macOS에서 `SO_REUSEADDR`·`SO_REUSEPORT` 모두 재현했고 이번 범위 밖이다 → #54.
  - 광고 host는 기동 시점의 Tailscale IP다. 실행 중 IP가 바뀌는 경우는 다루지 않는다.
  - 충돌로 양보할 때도 그 앞에 "MCP bound to 0.0.0.0" 안내가 먼저 찍힌다(기존 출력 순서).
  - Linux는 Docker linuxkit + root만 확인했고, 그 밖의 Linux 배포판과 Windows는 **UNKNOWN**.
- **보완 — MCP를 내릴 때 소켓까지 정리** (병합 전 검증에서 발견):
  - 위 수정은 확인한 소켓을 uvicorn에 넘긴다. 그런데 uvicorn은 **기동에 성공한** 서버를 종료할 때만 넘겨받은 소켓을 닫는다. 그래서 MCP 기동이 실패하거나(lifespan `startup.failed`) 10초 안에 끝나지 않으면, API만 알린 뒤에도 Core가 `*:P`를 계속 listen했다. 접속은 커널이 받지만 아무도 응답하지 않는다(격리 재현, `2e0bacd`). 정체성 확인 실패 경로도 종료 요청만 하고 기다리지 않아, readiness 직후에는 리스너가 아직 남아 있었다.
  - `_stop_mcp(server, thread, sock, port)`: 종료를 요청한다. 기동하지 못한 서버면 소켓을 먼저 닫는다(asyncio가 아직 넘겨받지 않았다). 그다음 스레드를 2초 기다린 뒤 소켓을 닫는다. 스레드가 끝나지 않으면 양보한 것으로 치지 않고 `❌ … did not stop within 2s (socket released|STILL LISTENING) — MCP was not cleanly yielded.`를 남긴다. 기동 실패, 기동 시간 초과, 정체성 확인 실패의 세 경로가 모두 이것을 거친 뒤 readiness를 출력한다. join을 2초로 둔 것은 기동 시간 초과(10초) 경로가 shell의 readiness 한도(15초)를 넘지 않게 하기 위해서다.
  - 수정 후 재현: 기동 실패 시 readiness 1.5초, `127.0.0.1:P` 접속은 `ConnectionRefused`. 기동 지연 시 readiness 13.4초, 소켓 해제, ❌ 오류 출력. 정체성 확인 실패 시 Core 리스너 없음, 다른 서버는 loopback을 계속 받음.
  - 테스트 5건 추가: `_stop_mcp` 단위 3건(기동 못 한 서버 소켓 해제 / 멈춘 기동은 소켓 해제 후 오류 보고 / 멈춘 started 리스너 오류 보고), 종단 간 2건(기동 실패 시 포트 해제 / claim 뒤 다른 프로세스가 `127.0.0.1:P`를 잡으면 API only, 우리 wildcard 해제, 다른 서버 영향 없음). `2e0bacd` 코드에서는 5건 모두 실패한다. 마지막 건은 Linux에서 후발 bind 자체가 거부되므로 skip된다.

## 54. Desktop Core — readiness 이후 다른 프로세스가 MCP 주소를 가로채지 못하게 (Issue #54)

#50 이후에도 남은 경로이며, #49의 MCP 판이다. wildcard 모드에서 Desktop MCP는 `0.0.0.0:P`에만 bind한다. readiness 이후 다른 프로세스가 더 구체적인 `127.0.0.1:P`나 광고한 Tailscale `IP:P`에 bind하면 macOS는 이를 허용한다. 그러면 그 주소로 접속하는 에이전트 요청이 Bearer 토큰째 그 프로세스로 간다. 격리 재현(master `914ca10`, `--host 0.0.0.0`)에서 `SO_REUSEADDR`·`SO_REUSEPORT` × loopback·광고 주소 4조합이 모두 가로채졌다. loopback 모드(`--host 127.0.0.1`)는 같은 주소를 이미 Core가 잡고 있어 후발 bind가 `EADDRINUSE`로 거부됐다.

- **수정** (`raven/desktop/runtime.py`):
  - #49의 guard 본문을 `_bind_guard(host, port)`로 일반화했다. `_bind_loopback_guard(port)`는 이를 부르는 API용 이름으로 남아 동작이 같다.
  - `_bind_mcp_guards(port, advertised)`: MCP가 `0.0.0.0`이면 `127.0.0.1:P`와 광고 주소 `IP:P`(loopback과 같으면 한 번)를 같은 포트로 bind+listen한다. MCP 소켓 전부를 uvicorn에 함께 넘긴다(`sockets=[wildcard, loopback, advertised]`). 정확히 같은 주소를 우리가 잡고 있으므로 다른 프로세스의 bind는 옵션 조합과 무관하게 `EADDRINUSE`로 실패한다.
  - guard 하나라도 못 잡으면 이미 잡은 guard와 MCP 소켓을 닫고, 기존 MCP 양보 정책대로 API만 띄운다(`could not hold every MCP address … API only`). MCP는 best-effort라 Core 전체를 fail-closed하지 않는다. readiness에 `mcp_port`가 없으므로 다른 서버로 가는 endpoint를 광고하지 않는다.
  - Linux는 wildcard listen 중 특정 주소 bind를 다른 프로세스와 우리 모두에게 거부한다. 그래서 **Linux에서 `EADDRINUSE`일 때만** guard 없이 wildcard 소켓만으로 진행한다(#49와 같은 규칙).
  - `_stop_mcp`는 MCP 소켓 목록을 받아 전부 해제한다(#50의 정리 경로를 그대로 따른다).
  - 특정 주소 bind 모드(loopback, Tailscale IP)와 MCP 인증(`LanTokenAuth`), 포트 정책, readiness 형식은 바뀌지 않는다.
- **Tailscale IP 변경 시점**:
  - 보장: 기동 시점에 광고한 주소와 loopback은 readiness부터 종료까지 Core가 잡고 있다.
  - 보장하지 않음(#16 범위): 기동 때 tailnet이 없어 loopback만 광고했다가 나중에 tailnet이 올라온 경우, 실행 중 Tailscale IP가 바뀐 경우. 둘 다 새 `IP:P`에는 guard가 없고 readiness의 `mcp_host`도 실측값이 아니다.
  - 확인 못 함: tailnet이 내려갔다 같은 IP로 다시 올라올 때 기존 guard 소켓이 그 주소를 계속 막는지는 운영 tailnet을 건드리지 않고는 확인할 수 없어 **UNKNOWN**.
- **검증**:
  - 격리 재현(macOS): 수정 후 4조합 모두 후발 bind가 `EADDRINUSE(48)`. loopback 접속은 Desktop MCP가 받고(406), 광고 주소는 토큰 없이 401로 인증 응답이 그대로다.
  - `tests/test_desktop_runtime.py` 8건 추가: readiness 이후 loopback과 광고 주소 bind가 `SO_REUSEADDR`/`SO_REUSEPORT`/둘 다 3조합에서 실패하고 인증 응답이 유지됨(3) / guard가 두 주소를 잡음(Linux는 빈 목록) / 한 주소를 못 잡으면 먼저 잡은 guard를 닫음(macOS) / claim과 guard 사이에 loopback·광고 주소를 다른 프로세스가 잡으면 API only, MCP 소켓 해제, 다른 서버 영향 없음(2). master 코드에서는 7건이 실패한다. 광고 주소는 이 호스트의 비-loopback 주소로 대신한다.
  - 병합 전 보강 12건: tailnet 유무에 따른 광고 주소(2) / tailnet이 없으면 loopback guard 하나 / 뒤 guard가 어떤 errno로 실패해도 앞 guard 해제 / Linux fallback(None)은 빈 목록 / 멈춘 기동에서 MCP 소켓 전부 해제 / loopback·특정 주소 MCP 모드는 guard를 요청하지 않고 endpoint 유지, 같은 주소 후발 bind 거부(2) / Linux `EADDRINUSE`가 아닌 errno면 API only, wildcard·loopback guard 모두 해제 / 로컬에 없는 광고 주소(TEST-NET-1)면 API only / MCP 기동 실패 시 loopback·광고 주소 모두 해제 / SIGTERM 후 exit 0, loopback·광고 주소 모두 해제, readiness 키는 기존과 같음(`host`, `port`, `mcp_port`, `mcp_host`).
  - Linux(Docker `python:3.12-slim`, linuxkit 6.10, root): `test_desktop_runtime.py`·`test_mcp_lan_token_auth.py` 80 passed, 1 failed(기존 `closed_stderr_pipe`), 4 skipped(Linux가 겹치는 bind를 거부해 해당 경로가 없음). 실제 Linux 커널에서 `EADDRINUSE` fallback으로 guard 없이 진행하고, readiness 이후 bind 3조합도 거부된다.
- **잔여 위험**:
  - 광고하지 않은 다른 로컬 주소(예: LAN IP)는 guard가 없다. macOS에서 그 주소로 직접 접속하는 에이전트는 여전히 가로채일 수 있다.
  - 위 Tailscale IP 변경 경우는 #16으로 넘긴다.
  - IPv6는 다루지 않는다(MCP 소켓은 IPv4 전용).
  - 로컬에 없는 광고 주소는 claim 단계 사전 probe에서 API only가 되지만, 경고 문구는 "already in use or answered by another server"로 나온다(동작은 안전, 문구만 부정확).
  - Linux는 Docker linuxkit + root만 확인했다. 다른 배포판·다른 UID 조합과 Windows는 **UNKNOWN**.

## 55. Gemini 호출에 `GEMINI_API_KEY`만 사용 — 다른 서비스 키의 Google 전송 차단 (Issue #47)

Gemini를 호출하는 5개 기능(태그 추천 `tagger`, RAG 답변 `rag`, AI 조언 `ai_advice`, 모순 탐지 `contradiction`, 초안 생성 `draft`)은 각자 `GEMINI_API_KEY` → `OPENAI_API_KEY` → `API_KEY` 순서로 키를 골라 `generativelanguage.googleapis.com`에 `x-goog-api-key` 헤더로 보냈다. `GEMINI_API_KEY`가 없으면 **OpenAI 키나 이름이 범용인 `API_KEY`(다른 도구가 설정한 값일 수 있음)가 Google로 전송됐다.** 인증이 실패해도 키는 이미 나간 뒤다. 저장소에 OpenAI를 호출하는 코드는 없다.

- **수정**:
  - `raven/core/gemini_client.py::gemini_api_key()`: 키 선택을 이 한 곳으로 모았다. `GEMINI_API_KEY`만 읽고, 비어 있거나 공백뿐이면 None.
  - 5개 호출부는 각자 환경 변수를 읽지 않고 `gemini_api_key()`를 쓴다. 키가 없으면 지금처럼 요청 없이 비-LLM fallback으로 동작한다.
  - Google 공식 별칭 `GOOGLE_API_KEY`도 읽지 않는다(키 이름 하나로 범위를 고정).
  - 모델, payload, timeout, 헤더 인증 방식(#20), 응답 파싱, fallback 내용은 바뀌지 않았다. 새 의존성 없음.
- **호환성 변경**: `OPENAI_API_KEY`나 `API_KEY`만 설정해 Gemini 기능을 써 왔다면, 이제 5개 기능이 fallback 결과(`used_llm: false`, AI 조언은 템플릿 문구)를 낸다. Gemini를 계속 쓰려면 같은 값을 `GEMINI_API_KEY`로 설정한다. README 환경 변수 표에 명시했다(`GOOGLE_API_KEY`도 쓰지 않음).
- **독립 리뷰**: 남은 전송 경로·호출부 회귀·테스트 공허 통과 여부를 별도 리뷰로 확인했다. blocker 없음. 지적 3건(공백 키, 검사 범위를 `raven/` 전체로, README에 `GOOGLE_API_KEY` 명시)을 반영했다.
- **검증** (가짜 키, httpx 전송 계층 `HTTPTransport.handle_request`에서 모든 요청 기록):
  - master `785bd07`: 5개 기능 × `OPENAI_API_KEY`·`API_KEY` 단독 10가지 모두 Google로 요청이 나갔다(헤더에 그 키 값).
  - 수정 후: 같은 10가지와 `GOOGLE_API_KEY` 단독 5가지에서 나가는 HTTP 요청 0건, 각 기능은 fallback 결과. `GEMINI_API_KEY`가 비어 있거나 공백뿐이어도 같다.
  - 네 키를 모두 설정하면 기능마다 요청 1건, 대상은 `generativelanguage.googleapis.com`, 헤더 값은 `GEMINI_API_KEY`, URL·본문에 어떤 키도 없음, LLM 결과가 반영된다(`used_llm: true`).
  - `raven/` 전체에서 키 환경 변수를 읽는 곳은 `gemini_client.py`뿐임을 테스트로 고정.
  - `tests/test_gemini_key_scope.py` 24건 추가. master 코드에서 14건 실패(공백 키 경우 포함).
- **잔여 위험**:
  - 이미 Google로 전송된 적 있는 `OPENAI_API_KEY`/`API_KEY`는 이 수정으로 회수되지 않는다. 그런 설정으로 AI 기능을 쓴 적이 있다면 해당 키 교체를 권한다.
  - 프로세스 밖(셸 프로필, launchd plist 등)의 기존 설정은 바꾸지 않는다.

## 56. 경로를 받거나 vault를 지우는 API는 이 PC에서만 (Issue #15)

`_require_loopback`(소켓 loopback + 로컬 Origin 화이트리스트)은 백업 내보내기·가져오기 2곳에만 붙어 있었다. 앱 전체 게이트(TokenGate, #14)는 유효한 Bearer 토큰을 가진 원격 클라이언트를 통과시키므로, LAN·tailnet 기기가 토큰 하나로 서버 PC의 임의 경로에 vault를 만들고, 등록하고, 복제하고, 정적 사이트를 내보내고, vault를 디스크에서 지울 수 있었다(격리 재현, master `ec1f67b`: 원격 Bearer, vite 프록시를 거친 tailnet, loopback 소켓 + 외부 Origin 모두 통과).

- **수정** (`raven/api/server.py`):
  - 기준: 서버 PC의 **임의 경로를 받는** 작업과 데이터를 **복구할 수 없게 지우는** 작업은 이 PC에서만. 아래 8곳에 `_require_loopback`을 적용했다. 핸들러 첫 줄에서 검사해 404 등 다른 판정보다 먼저 거부한다.
    - 경로를 받는 API: `POST /api/vaults`(생성), `POST /api/vaults/register`, `POST /api/vaults/{name}/workspace`, `POST /api/vaults/{name}/repair`, `POST /api/vaults/{name}/clone`, `POST /api/vaults/{name}/export`(`out_dir`를 줄 때만)
    - 복구 불가 삭제: `DELETE /api/vaults/{name}?force=true`, `POST /api/vaults/{name}/archive/clean?apply=true`
  - 원격 Bearer 토큰으로 우회할 수 없다. TokenGate가 `scope["client"]`를 실효 출처로 바꿔 두므로 vite 프록시(xfwd)를 거친 tailnet 요청, strict 모드의 `unknown` 출처도 비-loopback이다.
  - 거부 문구를 백업 전용에서 일반 문구로 바꿨다("서버 PC의 경로를 지정하거나 vault를 지우는 작업은 이 PC에서만 할 수 있습니다").
  - 독립 리뷰에서 찾은 결함: `PUT /api/vaults/{name}`(이름 변경)이 새 이름을 검증하지 않아 `../x`나 절대경로로 vault 디렉터리를 서버의 임의 위치로 옮길 수 있었다. 새 이름은 같은 폴더 안의 디렉터리 이름만 허용하고(구분자·`.`·`..`·절대경로 400), 이미 있는 디렉터리 위로는 옮기지 않는다(409, POSIX rename은 빈 디렉터리를 조용히 교체한다). 이름 변경 자체는 원격에서도 그대로 된다.
  - 읽기 전용 API, 전면 인증, MCP 인증 정책은 바꾸지 않았다.
- **원격에 그대로 열어 둔 것** (TokenGate 인증, 원격 Dashboard·MCP와 같은 vault 안 편집):
  - 페이지 생성·수정·삭제. 페이지 삭제는 `_archive/`로 옮기는 복구 가능한 삭제이고 slug는 vault 안으로 검증된다. MCP의 같은 동작과 같은 경로다.
  - `DELETE /api/vaults/{name}?force=false`(등록 해제만, 페이지가 있으면 409 그대로), `archive/clean?apply=false`(미리보기), `export`(기본 위치), 이름 변경(같은 폴더 안), 폴더 생성, raw·draft·feedback 편집.
- **호환성 변경**: 원격 Dashboard(tailnet·LAN 브라우저, Docker dashboard 프록시)에서는 위 8개 작업이 403으로 막힌다. 백업이 이미 그랬던 것과 같다. 같은 PC에서도 Dashboard를 LAN·tailnet 주소(예: `http://100.x:5173`)로 열면 Origin이 로컬이 아니어서 막힌다 — 데스크톱 앱, `http://localhost:5173`, CLI를 쓴다. `tests/test_spa_server_auth.py`의 CSRF 검사 표본을 vault 삭제에서 vault 안 폴더 생성으로 바꾸고, 프록시를 거친 `force=true` 삭제는 같은 Origin이어도 403임을 함께 확인한다.
- **검증**:
  - `tests/test_api_local_only_guard.py` 145건: 8개 endpoint × (로컬 허용 Origin 6종 정상 동작·실제 반영 / 원격 Bearer 403·변경 없음 / 토큰 없는 원격 401 / vite 프록시 경유 tailnet 403 / strict 모드 `unknown` 403 / loopback 소켓 + 외부 Origin 6종 403·문구 확인), IPv6·IPv4-mapped·`127.0.0.2` loopback 허용, `force=false` 409 유지, `apply=false`·기본 export·페이지 쓰기·삭제는 원격 인증으로 유지, 이름 변경 경로 탈출 6종 400·기존 디렉터리 409·일반 이름 변경 유지. master 코드에서 80건 실패.
  - 기존 백업 가드(`test_api_backup.py`), TokenGate 프록시 판정(`test_core_api_forwarded.py`) 회귀 없음.
- **잔여 위험**:
  - raw 파일 삭제(`DELETE .../raw/{path}`)와 draft 삭제는 vault 안의 단일 파일 hard delete이며 원격 인증 클라이언트에 열려 있다(raw의 `X-Actor`는 식별용 헤더이지 인증이 아니다). vault 안 편집으로 분류해 이번에는 막지 않았다.
  - `POST /api/debug-log`의 무제한 append는 #19 범위.
  - Origin 검사는 `tauri://` 스킴이면 호스트를 보지 않는다(브라우저가 이 스킴을 위조할 수 없어 실제 피해 없음).
  - Origin이 없는 비브라우저 요청은 소켓·프록시 판정만으로 통과한다 — 앞단 로컬 프록시가 X-Forwarded-For를 붙여야 한다(`access.py`에 문서화된 기존 전제).
  - Dashboard의 archive 정리는 403일 때 상태 코드만 보여 준다(문구 표시는 Dashboard 변경이라 범위 밖).

## 57. Desktop Core readiness가 실제 bind를 보고하고 셸이 실측값으로 판정 (Issue #16)

readiness는 실제 bind와 무관하게 항상 `{"host": "127.0.0.1"}`을 보고했고, Rust 셸은 그 값이 `127.0.0.1`인지만 비교했다(상수 비교라 항상 통과). 격리 재현(master `bf2f866`): `--host 0.0.0.0`은 모든 인터페이스에 열려 있는데 readiness는 loopback, 특정 IP(`192.168.0.52`) bind는 loopback에 아무것도 없는데도 readiness가 `127.0.0.1`을 보고해 셸이 죽은 주소를 webview에 넘겼다. `::`와 해석 불가 host는 소켓 traceback으로 종료됐다.

- **readiness 계약** (`raven/desktop/runtime.py`): `{"host": <webview가 접속할 주소>, "port", "bind_host": <실제 bind>, "mcp_port"?, "mcp_host"?}`.
  - loopback bind → `host` `127.0.0.1`, `bind_host` `127.0.0.1`
  - `0.0.0.0` bind → `host` `127.0.0.1`(wildcard와 #49 guard가 loopback을 받음), `bind_host` `0.0.0.0`
  - 특정 IPv4 bind → 둘 다 그 주소. `0.0.0.0`은 접속 주소로 보고하지 않는다.
  - #22의 정체성 확인(nonce probe)을 그 접속 주소로 수행한다 — 특정 IP bind에서 건너뛰던 공백을 메웠다.
  - 이름 host(opt-in 하에 `safe_bind_host`가 남기는 값)는 IPv4로 해석해 그 주소로 bind·보고한다. 해석 실패, IPv6(`::` 등 — Core 소켓은 IPv4 전용), bind 실패는 원인을 밝히고 readiness 없이 exit 1.
- **Rust 셸** (`desktop/src-tauri/src/core.rs`): 상수 비교를 `ready_endpoints()`로 교체했다.
  - `bind_host`(필수)와 `host`를 IP로 해석, port 0·wildcard 접속 주소 거부, loopback·wildcard bind면 접속 주소가 loopback이어야 하고 특정 bind면 같은 주소여야 한다. 어긋나면 시작 실패.
  - MCP 주소가 쓸 수 없는 값(wildcard·해석 불가)이면 MCP만 끄고 API는 계속.
  - 거부할 때(그리고 readiness 형식 오류일 때) 이미 떠 있는 Core 자식 프로세스를 종료한다 — 이전에는 이 경로가 사실상 도달 불가였다. 형식 오류 시 stderr를 끝까지 읽느라 셸이 멈추던 가능성도 함께 막았다(독립 리뷰).
- **관리 화면** (`dashboard`): `describeBindExposure()`로 `GET /api/system/info`의 실제 `bind_host`를 세 가지로 표시한다 — loopback 전용 / 모든 네트워크 인터페이스(같은 PC만 토큰 없이) / 특정 주소에서만 수신(loopback 미수신, 같은 PC여도 토큰 필요). 이전에는 특정 주소도 "같은 PC만 토큰 없이"로 표시했다.
- **호환성**: 기본 loopback 실행과 `0.0.0.0` 원격 실행은 접속 주소가 그대로다. 특정 IP bind(`--host tailscale` 포함)에서는 webview가 그 주소로 접속하므로 loopback 클라이언트가 아니어서 토큰 입력창이 뜬다(이전에는 연결 자체가 안 됐다) — 같은 PC를 토큰 없이 쓰려면 `0.0.0.0`. 인증 정책(TokenGate, MCP LanTokenAuth)은 바뀌지 않았다. 셸과 runtime은 같은 번들로 배포되며, `bind_host`가 없는 readiness는 형식 오류로 거부된다.
- **Tailscale 경계**: 기동 시점의 tailnet 유무는 정확히 반영된다(tailnet 없으면 `--host tailscale`이 loopback으로 낮아지고 readiness·관리 화면도 loopback). 실행 중 IP가 생기거나 바뀌면 특정 IP bind·셸 endpoint·MCP 광고·MCP guard가 기동 시점 값에 고정된다 — 런타임 재바인딩/재시작 설계가 필요해 #58로 분리했다. 운영 Tailscale 설정은 건드리지 않았다.
- **검증**:
  - 격리 재현(macOS): loopback·`localhost`·`0.0.0.0`·특정 LAN IP 모두 readiness가 실제 listen과 일치, 특정 IP는 토큰 없이 401·토큰으로 200·loopback 미수신. `::`·`999.1.1.1`·로컬에 없는 IP는 원인 메시지와 exit 1.
  - `tests/test_desktop_runtime.py` 12건 추가(loopback 3·wildcard·특정 IP·정체성 확인 범위·실패 3·wildcard 미보고·이름 host 해석·해석 실패). #54 테스트의 readiness 키 고정 단언에 `bind_host` 추가.
  - Rust `core.rs` 7건 추가(loopback/wildcard/특정 bind, 불일치·쓸 수 없는 readiness 7종 거부, `bind_host` 누락 형식 오류, MCP 주소 처리 2). `cargo test` 35 passed.
  - dashboard `bind-exposure.test.ts` 3건, `tsc -b` 통과, vitest 526 passed.
- **잔여 위험**:
  - 실행 중 Tailscale IP 변화(#58).
  - 셸이 Core 자식을 종료하는 거부 경로는 단위 테스트로 직접 검증하지 못했다(실제 Tauri GUI 실행은 **UNKNOWN**).
  - 특정 IP bind 테스트는 비-loopback 주소가 없는 환경에서 건너뛴다.

## 58. Desktop 셸의 Core readiness 대기에 상한 — 출력 없이 살아 있는 Core가 셸을 붙잡지 않게 (Issue #43)

셸은 Python Core의 readiness 줄(stdout 첫 줄)을 타임아웃 없는 blocking `read_line`으로 기다렸다. 격리 재현(master `305fc97`): 출력 없이 살아 있는 가짜 Core와, import 단계에서 멈춘 실제 venv Python(`sitecustomize`에서 sleep) 모두 `ManagedCore::start`가 20초 넘게 반환하지 않았고 자식은 살아 있었다. 같은 재현에서 readiness 전에 stderr를 파이프 버퍼(64 KiB) 넘게 쓰는 Core도 무기한 멈췄다 — readiness 전까지 아무도 stderr를 읽지 않아 Core 쪽 write가 막혔다.

- **상한** (`desktop/src-tauri/src/core.rs`): `CORE_READINESS_TIMEOUT` 60초.
  - 정상 기동은 2초 미만(macOS 실측 0.4–0.7초, bytecode 캐시가 없을 때 약 2초, 셸 경로 MCP 포함 1.15초).
  - Core 자체 deadline은 정상적으로 그보다 길어질 수 있다 — uvicorn 10초, MCP 10초(넘으면 API만), #22 정체성 확인 수 초씩, #50 MCP 정지 2초. import 이후만 약 30초이고 import 자체에는 deadline이 없다. 60초는 이 경로보다 길어 느리지만 정상인 Core를 죽이지 않는다.
  - 웹뷰 계약은 그대로다: `core_endpoint`/`mcp_endpoint`는 15초 뒤 `Err`, dashboard는 다시 묻는다(최대 30회).
- **대기 방식**: 첫 줄은 reader 스레드가 읽어 채널로 넘기고(이후 같은 스레드가 stdout 중계를 계속), 대기 스레드는 50ms마다 자식 종료·취소·deadline을 확인한다. 정상 readiness 외의 모든 출구에서 자식을 kill·wait한 뒤 `Err`로 기존 실패 안내(대화상자 → 종료) 경로를 탄다.
  - 구분되는 실패: timeout / readiness 전 종료(exit status 포함) / 살아 있는 채 stdout 닫힘 / 읽기 오류 / 형식 오류(`bind_host` 누락 포함, #16) / readiness 직후 종료 / 불일치 readiness(#16) / 실행 파일 없음.
  - 손자 프로세스가 파이프를 잡고 있어 EOF가 오지 않아도 Core 종료를 따로 감지한다. 실패 메시지용 stderr 수집도 1초로 묶여 오류 경로가 멈추지 않는다.
  - stderr는 spawn 직후부터 중계하고 마지막 8 KiB를 실패 메시지에 붙인다. 파이프 버퍼를 넘는 기동 로그로 멈추던 경로가 사라졌다.
- **취소**: 대기 중인 자식은 `PendingStart`에 둔다. `CoreState::stop`(앱 종료, 재시작)이 그 자식을 직접 kill한다 — 이전에는 기동 중 앱이 끝나면 Core가 남을 수 있었다. readiness와 저장 사이에 stop이 끼어도 그 Core는 저장되지 않고 종료된다. 새 기동은 이전 대기 기동을 취소한다. 취소는 실패 대화상자를 띄우지 않는다.
- **런타임 워커·메인 스레드**: 최초 기동을 `async_runtime::spawn`에서 `spawn_blocking`으로 옮겨 대기가 async 워커를 점유하지 않는다. `restart_core` 커맨드와 트레이 "Restart Backend"는 메인 스레드에서 동기로 돌던 것을 blocking pool로 옮겼다 — 재시작 대기 중에도 UI와 종료가 응답하고, 종료가 대기 중인 재시작을 취소한다. `restart_core`의 호출 방식과 반환은 그대로다.
- **기동 교체**: 새 기동은 이미 실행 중인 Core도 먼저 멈춘다(두 Core 동시 실행 방지). 취소된 기동이 그 뒤 스스로 실패해도(형식 오류·timeout 등) 실패로 보고하지 않는다 — 초기 기동 중 재시작을 누르면 실패 대화상자로 앱이 꺼지던 경로를 막았다(독립 리뷰).
- **바뀌지 않은 것**: readiness 프로토콜(첫 줄 JSON), `core_endpoint`/`mcp_endpoint` 15초 계약, `restart_core`의 `Result<(), String>` 반환, 신규 의존성 없음. Python 쪽은 docstring에 셸의 대기 상한만 적었다.
- **검증**:
  - 재현(위)과 수정 후: 출력 없는 가짜 Core는 timeout 뒤 종료, import에서 멈춘 실제 Python Core는 60.01초에 kill·reap. 실제 Core 정상 기동은 셸 경로로 0.62–1.15초(MCP 포함), drop 후 프로세스 없음.
  - `core.rs` 15건 추가: 정상 readiness와 drop 정리, 출력 없는 Core timeout과 kill, deadline 직후 readiness는 timeout·직전은 수용, 형식 오류, `bind_host` 없는 readiness(#16), 불일치 readiness(#16), 살아 있는 채 stdout 닫힘, 조기 종료(status·stderr), 손자가 파이프를 잡은 조기 종료, readiness 전 stderr 256 KiB, 대기 중 취소, spawn 전 취소, 연속 실패 뒤 재시도, 실행 파일 없음.
  - `lib.rs` 6건 추가: stop이 대기 중 기동을 kill, readiness와 저장 사이의 stop, 새 기동이 대기 기동을 대체, 취소 뒤 실패를 실패로 보고하지 않음, 새 기동이 실행 중 Core를 멈춤, 실패 뒤 재시도 저장. 마지막 리뷰 보완 2건은 수정을 되돌리면 실패함을 확인했다.
  - `cargo test --lib` macOS 56 passed(5회 반복 안정), Linux Docker(rust:1-bookworm, 전체 crate) 56 passed. `cargo clippy` 신규 경고 없음.
  - Python: `tests/test_desktop_runtime.py` 80 passed(#16·#22·#23·#49·#50·#54 회귀 포함). 전체 pytest 2202 passed, 2 failed — `test_desktop_core_survives_closed_stderr_pipe`(master에서도 3/3 실패)와 `test_no_candidates_is_not_an_error`(기존 실패), 이번 변경과 무관.
- **잔여 위험**:
  - `kill`은 Core 프로세스만 종료한다. 기동 전에 Core가 띄운 손자가 파이프를 잡고 있으면 손자와 셸의 relay 스레드 2개가 남는다(기동 실패마다). 현재 Core는 readiness 전에 오래 사는 하위 프로세스를 만들지 않는다.
  - 셸이 대기 중 비정상 종료(crash, SIGKILL)하면 readiness 전 Core의 정리는 #23 부모 감시에 달려 있고, 그 감시는 readiness 뒤에 시작한다 — 멈춘 Core는 남을 수 있다.
  - Windows 런타임, 실제 Tauri GUI에서의 대화상자·재시작 동작은 **UNKNOWN**(단위 테스트는 `sh`를 쓰는 unix 전용).

## 59. Core 재시작 동시성·실패 안내 — 한 번에 하나, 트레이 실패도 사용자에게 (Issue #44)

#43(§58)에서 재시작이 메인 스레드를 떠났다. 이번에는 실제 macOS GUI에서 응답성을 실측하고, 남은 동시성·안내 공백을 메웠다.

- **실측** (실제 Tauri GUI, scratch에만 둔 계측 빌드, 격리 HOME·vault·API 48765·MCP 48766): 메인 스레드에 50ms 간격 heartbeat를 보내 지연을 쟀다. 트레이 클릭은 UI 스크립팅 권한이 없어 메뉴 콜백과 같은 메인 스레드에서 같은 함수를 호출했고, 대시보드 재시작은 실제 webview IPC로 호출했다.
  - #43 이전 코드(`305fc97`): 정상 재시작 동안 메인 스레드가 약 555ms 응답하지 않았다(대시보드·트레이 모두). readiness가 오지 않으면 28초 이상 응답이 없었고 `sample`의 메인 스레드 1481/1481 샘플이 `restart_core → ManagedCore::start → read_line → read`였다. 종료 요청도 처리되지 않았고 Core가 남았다.
  - 이번 코드: 60초 readiness 지연 내내 heartbeat 최대 8ms(`sample` 실행 구간 151ms 1회 제외), 메인 스레드 1293/1296 샘플이 run loop 대기(`mach_msg`), 재시작 코드는 blocking pool 스레드에만 있었다.
- **동시 재시작 정책** (`desktop/src-tauri/src/lib.rs`): 한 번에 하나의 기동·재시작만 실행하고, 그 사이 들어온 요청은 큐에 넣지 않고 `StartError::Busy`로 거절한다("이미 진행 중입니다. 끝난 뒤 다시 시도하세요").
  - 이전(§58) 정책은 새 요청이 대기 중인 기동을 취소했다. readiness는 보고했지만 아직 저장되지 않은 이전 Core가 새 Core 옆에서 살아 있는 구간이 있었다(단위 테스트로 재현 — 두 Core 동시 생존).
  - 기동 중 슬롯이 곧 "진행 중" 표시다. 앱 종료(`stop`)는 대기를 취소하되 슬롯은 기동이 끝날 때 스스로 비운다 — 정리 중인 Core 옆에서 새 기동이 시작되지 않는다. 기동 중 panic이 나도 RAII guard가 슬롯을 비워 이후 재시작이 영구 거절되지 않는다.
  - 새 기동은 저장된 Core를 먼저 멈춘 뒤 시작한다. 늦게 끝난 기동이 최신 상태를 덮어쓸 수 없다(기동이 겹치지 않음).
  - 최초 기동 중 트레이 재시작은 거절되고, 트레이 재시작이 먼저 시작했다면 최초 기동이 조용히 물러난다(실패 대화상자로 종료하지 않음).
- **실패 안내**: 트레이 재시작 실패·거절을 `eprintln!`만이 아니라 non-blocking 경고 대화상자로 보여 준다(#1 A-3의 시작 실패 안내와 같은 방식). 앱 종료로 취소된 경우는 안내하지 않는다. 대기 중 반복 클릭으로 대화상자가 쌓이지 않게 한 번에 하나만 띄운다. 대시보드 `restart_core`의 `Result<(), String>` 계약은 그대로이며 `Busy`도 문자열 오류로 전달된다.
- **재시작 후 endpoint 정합성**: API 포트는 8765가 비어 있으면 8765, 아니면 OS가 고른다 — 재시작으로 바뀔 수 있는데 dashboard는 endpoint를 로드 시 한 번만 읽었다.
  - 트레이 재시작: 셸이 마지막으로 webview에 준 endpoint와 비교해 바뀌었으면 페이지를 reload한다. 실패한 재시작 뒤(실행 중 Core 없음)에도 비교 기준이 남는다(독립 리뷰).
  - 대시보드 재시작: 셸은 reload하지 않는다 — 진행 중인 IPC 호출 아래에서 reload하면 IPC 계층이 그 호출을 다시 보낼 수 있다(GUI 실측에서 콜백 2회 발생 확인). `VaultManage`가 호출이 끝난 뒤 `core_endpoint`를 `getApiBase()`와 비교(`coreEndpointMoved`)해 스스로 reload한다.
  - MCP는 고정 포트(8766)이고 관리 화면은 5초마다 `core_status`로 다시 읽는다.
- **기타**: readiness 대기 중 실패 처리(kill·reap·stderr drain)를 cancel 슬롯 lock 밖에서 하도록 옮겼다 — 앱 종료의 cancel이 최대 1초 기다릴 수 있던 구간(독립 리뷰, §58 코드).
- **GUI 시나리오 결과** (이번 코드, 실제 Core):

  | 시나리오 | 결과 |
  |---|---|
  | 정상 재시작(대시보드·트레이) | 0.58–0.80초, heartbeat 최대 0.2ms, Core 1개로 교체 |
  | readiness 60초 지연 | UI 응답 유지, 63.3초에 timeout 오류 전달, Core 정리 |
  | 대시보드 재시작 중 트레이 재시작 / 대시보드 재시작 | 트레이: 거절 안내 대화상자, 대시보드: `Busy` 오류(3–5ms) |
  | 트레이 재시작 중 대시보드 재시작 | 대시보드 `Busy`, 트레이 재시작 정상 완료 |
  | 최초 기동 중 트레이 재시작(정상·지연) | 거절 안내, Core 1개만 기동 |
  | 최초 기동·재시작 대기 중 앱 종료 | 대기 취소, 자식 정리, 남은 Core 0 |
  | Core 조기 종료 / 잘못된 readiness | 오류 전달(exit status·stderr 포함), 자식 없음, 트레이는 실패 안내 |
  | 실패 후 재시도 | 정상 복구 |
  | 연속 재시작 10회(대시보드 5·트레이 5) | 매 단계 Core 1개, 모두 다른 PID, 누수 없음 |
  | 포트가 바뀌는 재시작(대시보드·트레이) | 페이지 reload 후 새 endpoint 사용 |
  | 전체 실행 | Core 25개 기동, 앱 종료 후 남은 Core 0 |
- **검증**:
  - Rust `cargo test --lib`: macOS 65 passed(5회 반복), Linux Docker 전체 crate 65 passed(3회). 신규 9건(동시 기동 중 두 번째 Core 없음, 동시 10개·연속 10회 재시작, 실패 뒤 재시도, 종료 중 취소, endpoint 이동 보고 2, panic 뒤 슬롯 해제, 트레이 안내 2) + §58 정책 테스트 1건을 새 정책으로 갱신. 새 정책·리뷰 보완 테스트는 수정을 되돌리면 실패함을 확인했다. `cargo clippy` 신규 경고 없음.
  - dashboard: `core-endpoint.test.ts` 3건, vitest 529 passed, `tsc -b` 통과.
  - Python 변경 없음. 전체 pytest 2202 passed, 2 failed(§58과 같은 기존 실패 2건).
- **잔여 위험·UNKNOWN**:
  - 트레이 메뉴 실제 클릭은 UI 스크립팅 권한이 없어 실행하지 못했다. 같은 함수를 메뉴 콜백과 같은 메인 스레드에서 호출해 측정했다.
  - Windows, Linux GUI 런타임은 **UNKNOWN**(Linux는 단위 테스트만).
  - 트레이 재시작으로 포트가 바뀌어 reload될 때 그 순간 진행 중인 IPC 호출은 다시 보내질 수 있다(읽기는 무해). 편집 중인 미저장 내용은 reload로 사라진다 — 포트가 실제로 바뀐 경우에만 발생한다.
  - 지연된 기동(최대 60초) 동안 재시작은 거절된다. 멈춘 기동을 즉시 끊고 다시 시작하는 수단은 앱 종료뿐이다.

## 60. 실행 중 Tailscale 주소가 바뀌어도 MCP·API 보호와 광고 주소를 실제 소켓에 맞춘다 (Issue #58)

Desktop Core는 Tailscale 주소를 기동 시점에 한 번 정하고, 그 값으로 `--host tailscale` bind, readiness endpoint, MCP 광고 주소, #54 MCP guard를 고정했다. 실행 중 tailnet이 올라오거나 IP가 바뀌면 다음 문제가 생겼다.

- wildcard(`0.0.0.0`) 모드: 새 `IP:P`는 wildcard 소켓이 받지만 아무도 잡고 있지 않다. macOS에서는 다른 프로세스가 그 주소에 bind해 에이전트 요청을 Bearer 토큰째 가져갈 수 있었다(#54 경로가 새 주소에서 다시 열림). API 포트도 같다.
- 광고된 MCP 주소는 옛 IP나 loopback으로 남았다.
- `--host tailscale` 모드: API·MCP 소켓이 사라진 주소에 묶여 있고 webview endpoint도 그 주소에 남았다.

- **수정 전 재현** (macOS, 격리 포트 48765/48766, Tailscale 조회 결과만 control 파일로 시뮬레이션, 새 주소 = 이 PC의 LAN IP):
  - 기동 시 tailnet 없음 → 나중에 주소 A가 생김: master(`a52d27a`)는 readiness `mcp_host`가 `127.0.0.1`로 남았다. 다른 프로세스가 `A:48766`(MCP)·`A:48765`(API)에 `SO_REUSEADDR`·`SO_REUSEPORT` 어느 쪽으로든 bind했고, 에이전트가 보낸 Bearer 토큰을 그 프로세스가 받았다(4/4 가로챔).
  - 시작 시 주소 A → 사라짐 → 같은 A로 복귀, 조회 실패·지연, Core 재시작 중 변경은 master에서 아무것도 갱신되지 않았다(이벤트 없음, 광고 주소 고정).
- **설계 비교**:
  - A. 주소가 바뀔 때마다 Core 전체 재시작: readiness·bind 초기화는 재사용하지만, wildcard 모드에서도 진행 중 요청이 끊기고 webview가 reload된다. wildcard 소켓은 새 주소도 이미 받으므로 재시작할 이유가 없다. 재시작 사이에는 guard도 없다.
  - B. guard·광고 주소만 실행 중 갱신(**채택**, wildcard 모드): 새 주소를 먼저 잡고, 응답을 확인한 뒤 광고한다. Core 재시작, 요청 중단, reload가 없다.
  - C. `--host tailscale` 비권장 + 수동 재시작: 단순하지만 특정 주소 bind 사용자의 복구가 자동화되지 않는다.
  - 결론: B에 `--host tailscale`용 재시작 정책을 결합했다. 특정 주소 소켓은 주소를 옮길 수 없으므로 그 모드만 #44 경로로 재시작한다.
- **수정 — Core** (`raven/desktop/netwatch.py` 신규, `runtime.py`):
  - **감지**: readiness 이후 감시 스레드가 1초마다 Tailscale 주소를 확인한다. macOS는 routing socket의 주소 변경 메시지로 더 빨리 깨어난다(0.2초 정착 대기). 조회는 DNS 없이, `100.100.100.100`으로 가는 경로의 출발 주소를 본다. `100.64.0.0/10` 안이고 이 PC에 bind할 수 있을 때만 주소로 인정한다(userspace 모드처럼 경로만 있는 경우는 "없음"). 기동 시 조회도 같은 함수를 쓴다.
  - **실패와 미할당 구분**: 조회는 2초 timeout이 있는 별도 스레드에서 돈다. 이전 조회가 아직 걸려 있으면 새로 시작하지 않는다. 오류·timeout·비정상 값(빈 문자열, `0.0.0.0`, loopback, IPv6 등)은 "error"이고 **아무것도 바꾸지 않는다**. "none"만 광고를 loopback으로 되돌린다.
  - **guard 수명주기 (wildcard API·MCP)**:
    - 새 주소를 처음 본 tick에 그 주소의 guard 소켓을 bind+listen한다. 실행 중 uvicorn 서버가 그 소켓도 받게 한다(`attach_socket`: uvicorn `startup`과 같은 protocol factory를 서버 자신의 event loop에서 붙인다. uvicorn 종료 시 함께 닫힌다).
    - #22 정체성 probe로 이 Core가 그 주소에서 응답하는지 확인한 뒤에만 `protected`가 된다. MCP는 그다음 tick(2회 연속 관측)에 광고한다. 광고는 보호 확인 뒤에만 일어난다.
    - 다른 프로세스가 이미 그 주소를 잡고 있으면(`EADDRINUSE`): `blocked`. 광고하지 않고, loopback 광고를 유지하고, `alert` 이벤트·stderr·`/api/system/info`로 알린다. 매 tick bind를 다시 시도하고 그 프로세스가 놓으면 그때 잡는다.
    - 주소가 아직 할당되지 않았으면 `pending`, 응답 확인 실패·attach 실패는 `error`(재시도). 어느 쪽도 광고하지 않는다. 광고 중인 주소가 `protected`가 아니게 되면 debounce 없이 즉시 loopback으로 되돌린다.
    - **이전 guard는 Core 종료 때까지 유지**한다. 주소가 사라져도 닫지 않으므로 같은 주소가 돌아오는 순간부터 보호된다(돌아오면 응답을 다시 확인). 이미 받는 wildcard 소켓보다 노출 범위가 넓어지지 않는다.
    - Linux는 wildcard 옆 특정 주소 bind를 커널이 막으므로 guard 없이(`None`) 응답 확인만 한다(#49와 같은 규칙).
  - **`--host tailscale`**: bind한 주소와 현재 주소가 5초 넘게 다르면 shell에 `rebind`를 요청한다(요청이 해결되지 않으면 30초마다 다시). tailnet 없이 loopback으로 낮춰 기동한 경우 tailnet이 생기면 같은 방식으로 그 주소로 옮겨 간다. 5초 미만 흔들림은 무시한다.
  - **이벤트 채널**: readiness 이후 stdout에는 이 이벤트(`mcp_endpoint`, `alert`, `rebind`)만 한 줄씩 나간다. fd 1을 stderr로 옮기므로 이후의 `print`나 자식 프로세스 출력이 이벤트로 읽힐 수 없다. readiness 형식은 그대로다.
  - **종료**: 감시 스레드를 서버보다 먼저 멈추고 기다린다(최대 3초). 종료 중인 서버에는 guard를 붙이지 않고, 붙은 뒤 종료가 시작됐으면 바로 닫는다. attach가 timeout된 뒤 늦게 성공하면 그 결과를 다음 tick에 쓰고, 같은 소켓을 두 번 붙이지 않는다(독립 리뷰 N1).
- **수정 — shell** (`desktop/src-tauri/src/core.rs`, `lib.rs`):
  - readiness 뒤 stdout 줄 중 알려진 이벤트만 파싱한다(나머지는 기존처럼 stderr로 중계). 이벤트에는 보낸 Core의 id가 붙는다. id는 셸 안에서 재사용되지 않는다.
  - 이미 교체된 Core의 이벤트는 버린다. 아직 저장되지 않은 Core(readiness 직후 첫 확인)의 이벤트는 5초까지 기다렸다가 전달한다(독립 리뷰 S1: 이것이 없으면 기동 직후 API guard 경고가 사라졌다).
  - `mcp_endpoint`: 관리 화면이 5초마다 읽는 `core_status`·`mcp_endpoint`가 새 주소를 돌려준다.
  - `alert`: non-blocking 경고 대화상자(한 번에 하나). 이 주소로 오는 요청이 다른 프로세스로 갈 수 있다고 알린다.
  - `rebind`: 전용 스레드에서 #44 경로(`do_restart_core`, 한 번에 하나, 이전 Core 먼저 정지)로 재시작한다. endpoint가 바뀌었으면 webview를 reload한다. 실패는 대화상자로 알리고, `Busy`·취소는 조용히 넘긴다(Core가 다시 요청함).
  - **재시작 루프 방지**: 네트워크 재시작은 첫 번째는 즉시, 다음은 20초 뒤부터 가능하다. 그 뒤 5분 안에 다시 일어날 때마다 간격이 두 배가 된다(최대 10분). 현재 간격보다 5분 넘게 조용하면 20초로 돌아간다. 간격 안에 온 요청은 버리지 않고 기다렸다가, 그 Core가 아직 실행 중이면 실행한다(독립 리뷰 S2).
- **상태 보고** (`raven/core/network_status.py`, `raven/api/server.py`, `dashboard`):
  - `GET /api/system/info`에 `network`를 추가했다(추가 필드, 기존 필드는 그대로). 현재 Tailscale 조회 결과(state·ip·detail), API의 실제 bind·접속 주소·tailnet 주소 상태(`protected`/`blocked`/`pending`/`error`/`not_listening`)·재시작 요청 여부, MCP의 bind·실제 광고 주소·tailnet 상태, 그리고 지금 문제인 항목(`problems`)이 들어간다. Desktop Core가 아닌 실행에서는 `null`이다.
  - 관리 화면은 Core가 잡고 있는(`protected`) 주소만 Tailscale API·MCP URL로 보여 주고, 아니면 이유를 표시한다(예: API가 127.0.0.1에만 bind, 다른 프로세스가 점유). MCP URL은 API 포트가 아니라 실제 MCP 포트를 쓴다(기존 표시는 API 포트 + `/mcp`였다). `네트워크 상태` 줄에 `problems`를 보여 주고, 10초마다 다시 읽는다.
- **API·MCP 인증 정책은 바뀌지 않았다**: guard 소켓으로 들어온 요청도 출발지가 tailnet 주소이므로 TokenGate·LanTokenAuth가 같은 규칙으로 판정한다.
- **수정 후 재현** (같은 조건):

  | 상황 | 결과 |
  |---|---|
  | 기동 시 없음 → A | 첫 tick에 A의 MCP·API guard, 2초 뒤 `mcp_endpoint` A. 후발 bind 4조합 모두 `EADDRINUSE(48)`. 토큰 없는 MCP 401, API 401, loopback MCP 406 |
  | A → 없음 → A | 없음 2 tick 뒤 loopback 광고, guard 유지(없는 동안에도 후발 bind 거부), 복귀 후 A 재광고 |
  | A를 다른 프로세스가 먼저 점유 | `blocked`, `alert` 1회, 광고는 loopback 유지, `problems`에 표시. 점유 해제 후 1–2초 안에 guard 확보·A 광고 |
  | 조회 실패 / 30초 지연 | 상태 유지(광고 A, 이벤트 없음), `problems`에 실패 표시. 지연 중 `/api/system/info` 지연 최대 5.6ms |
  | `--host tailscale` A → 1초 흔들림 → 없음 | 흔들림 무시, 5.5초 지속 뒤 `rebind` 1회 |
  | 주소 변화 중 토큰 없는 MCP 요청 연속(4 스레드, 13초) | loopback 406, A 401만. 오류 0(같은 부하의 master와 동일). 200 응답 없음 |
- **Linux 실제 커널** (Docker `python:3.12-slim`, linuxkit 6.10, dummy 인터페이스로 `100.64.1.1`/`100.64.1.2`를 실제로 추가·삭제, 조회 함수는 실제 코드):
  - 조회 함수가 주소·없음을 구분했다.
  - wildcard: 없음 → A → B → 없음 → B 각각 1.5초 안에 `mcp_endpoint` 이벤트. 새 주소 후발 bind는 커널이 `EADDRINUSE(98)`로 거부. 토큰 없는 요청 401.
  - `--host tailscale`: 1.5초 동안 주소가 사라졌다 돌아와도 같은 소켓이 계속 응답했다(Linux). 다른 주소로 지속 변경 시 6초 뒤 `rebind`.
- **macOS 실제 GUI** (scratch에만 둔 별도 identifier 빌드, 실제 셸 + 실제 Core, 격리 HOME·vault·API 48765·MCP 48766, Tailscale 조회만 control 파일로 시뮬레이션):
  - wildcard: A 등장 후 셸의 MCP endpoint가 `http://A:48766/mcp`로, 사라지면 loopback으로 바뀌었다. 등장 전 후발 bind 성공, 등장 후 거부(48).
  - 점유된 A: 경고 대화상자 경로 실행, 메인 스레드는 run loop 대기(`mach_msg`), 재시작 프레임 없음. 점유 해제 후 A 광고.
  - 기동 전에 API의 tailnet 주소를 점유: readiness 직후 경고가 셸에 도달(리뷰 S1 수정 확인).
  - `--host tailscale`: A → 없음이면 6초 뒤 재시작해 `127.0.0.1`에, 다시 A면 20초 간격을 지켜 재시작해 `A`에 bind. 20초 걸리는 느린 재시작 동안 메인 스레드는 대기 상태였고 Core는 항상 1개였다.
  - 흔들림 5회: 네트워크 재시작이 7초, 27초(+20), 67초(+40), 147초(+80), 307초(+160)에 일어났다. 매 단계 Core 1개, 종료 후 남은 Core 0.
- **검증**:
  - Python: `tests/test_desktop_netwatch.py` 42건 신규(조회 7경우·DNS 없음·비정상 값·timeout·중복 조회 없음·예외 / attach 서빙·종료 시 해제·종료 중 거부·느린 attach 재사용 / 늦게 등장한 주소 보호 후 광고·사라짐·흔들림·조회 실패·점유(macOS)·응답 확인 실패·미할당·즉시 철회·비정상 조회값 / rebind 3경우·흔들림·조회 실패 / 스레드 정지·예외 생존·유휴 tick 수·routing 메시지 필터 / 이벤트 채널 끊김·stdout 분리 / 실제 Core 종단 간 2건·standalone `null`). 기존 테스트 2건은 조회 함수가 바뀌어 patch 대상만 바꿨다.
  - 변형 검사: guard 생략, 보호 전 광고, 조회 실패를 "없음"으로 처리, stdout 분리 생략, rebind debounce 생략, 비정상 조회값 허용, 늦은 attach 재사용 생략 — 각각 신규 테스트가 실패한다.
  - 전체 pytest(macOS): 2243 passed, 2 failed(기존 실패 `closed_stderr_pipe`·`test_no_candidates_is_not_an_error`).
  - Linux Docker pytest(`test_desktop_netwatch`·`test_desktop_runtime`·`test_mcp_lan_token_auth`·`test_core_api_access`): 수정본 205 passed, 7 skipped(Linux에는 guard 소켓이 없어 해당 경로가 없음), 1 failed(같은 기존 실패). master는 같은 3개 파일에서 165 passed, 1 failed(같음).
  - Rust `cargo test`(macOS): 78 passed(신규 13: 이벤트 파싱 2·relay 2·endpoint 갱신·교체된 Core 무시·경고·재시작 간격·backoff·저장 전 이벤트 대기·실패 안내·Core 일치·구조). `cargo clippy` 신규 경고 없음.
  - dashboard: `network-status.test.ts` 6건, vitest 535 passed, `tsc -b` 통과.
- **독립 리뷰**: blocker 없음. should-fix 2건(S1 기동 직후 경고 유실, S2 흔들림 시 무한 재시작)과 nit 4건(늦은 attach 중복, 첫 tick 예외 보호, 종료 순서 주석, API 경고 문구)을 반영했다. ssl factory 인자(데스크톱은 TLS 없음)는 반영하지 않았다.
- **잔여 위험·UNKNOWN**:
  - 새 주소가 처음 관측되기 전 구간(폴링 최대 1초, macOS routing socket으로는 약 0.2초)에는 다른 프로세스가 먼저 잡을 수 있다. 그 경우 `blocked`로 알리고 광고하지 않지만, 그 주소로 직접 접속하는 에이전트 요청은 막지 못한다. 어떤 방식으로도 0으로 만들 수 없다.
  - 실제 Tailscale 주소 변경은 운영 tailnet을 건드리지 않고는 재현할 수 없어 **UNKNOWN**(macOS는 조회 시뮬레이션, Linux는 dummy 인터페이스로 실제 주소 변경). 특히 macOS에서 주소가 사라졌다 돌아올 때 guard 소켓이 계속 유효한지는 **UNKNOWN**(돌아오면 응답 확인을 다시 하고, 실패하면 광고하지 않고 `problems`에 표시한다).
  - IPv6 tailnet 주소(`fd7a:…`)는 다루지 않는다. Core 소켓은 IPv4 전용이라 IPv6로는 듣지 않지만, MagicDNS 이름으로 IPv6를 고르는 에이전트는 그 주소를 먼저 잡은 다른 프로세스에 닿을 수 있다(#54부터 있던 한계).
  - CGNAT `100.64.0.0/10`을 LAN 주소로 받는 환경에서는 그 주소를 tailnet으로 오인할 수 있다(기존 `get_tailscale_ip`와 같은 한계).
  - `--host tailscale`의 자동 재시작은 webview를 reload한다. 편집기 초안은 localStorage에 남지만 그 밖의 화면 상태는 사라진다. 이 모드에서 tailnet 주소로 옮겨 가면 webview는 loopback 클라이언트가 아니게 되어 토큰이 필요하다(#16부터의 동작).
  - uvicorn 내부 속성(`servers`, `server_state`, `lifespan.state`, `config.http_protocol_class`, `config.backlog`)에 기대 guard를 붙인다. 0.52.1(uvloop 0.22.1 포함)에서 확인했다. 바뀌면 attach가 실패해 `error`로 보고되고 광고하지 않는다(fail-closed).
  - Windows는 **UNKNOWN**. Linux GUI 런타임도 **UNKNOWN**이다(Linux는 Core·단위 테스트만).

## 61. `/api/debug-log` — 기본 꺼짐, 크기 상한, 한 줄 JSON 기록 (Issue #19)

대시보드는 브라우저 오류(`window.onerror`, `unhandledrejection`, fetch 실패)를 `POST /api/debug-log`로 보낸다. 이 endpoint는 docstring에만 "dev only"라고 적혀 있었고, 실제로는 항상 열려 있었다.

- **수정 전 재현** (master `c6b1211`, loopback 클라이언트, 임시 로그 경로):
  - 환경 변수 없이도 200을 돌려줬고, 응답에 서버 쪽 로그 절대 경로가 담겼다.
  - `message`에 개행을 넣으면 `[2026-10-12 18:00:00] ERROR forged … msg: forged` 같은 가짜 항목이 실제 항목과 구분되지 않게 기록됐다.
  - 200 KB 요청 50회로 로그가 10,004,320바이트까지 커졌다. 상한도 회전도 없었다.
  - 원격 출처는 #24의 TokenGate가 이미 토큰을 요구하므로, 이 문제는 loopback 출처(이 PC의 프로세스·브라우저 페이지)에 해당한다.
- **수정** (`raven/api/server.py`):
  - **opt-in**: `RAVEN_DEBUG_LOG=1`(`true`/`yes`/`on`)일 때만 기록한다. 그 밖에는 **404**다. 값은 요청마다 읽는다. 본문을 읽기 전에 판정하므로 꺼진 endpoint는 깨진 본문에도 422가 아니라 404다(존재가 드러나지 않음). 다른 origin 페이지가 켜진 endpoint에 쓰는 문제는 loopback 신뢰 경계 전체의 문제라 #28에서 다룬다. 어떤 실행기(`./raven.sh`, 데스크톱, Docker)도 기본으로 켜지 않는다 — `raven.sh`는 운영 인스턴스도 띄우므로 거기서 켜지 않았다.
  - **기록 형식**: 항목 하나가 JSON 한 줄이다(`ts`, `level`, `source`, `message`, `url`, `vault`, `stack[]`). C0 제어문자는 JSON이 escape한다. JSON이 그대로 두는 보이지 않는 문자 — C1 제어문자(U+0085 줄바꿈, U+009B CSI 등), 서식 문자(bidi override 등), 줄·문단 구분자(U+2028/2029), 짝 없는 surrogate — 도 JSON 방식(`\uXXXX`, U+FFFF 위는 surrogate pair)으로 escape한다. `str.splitlines()` 기준으로도 항상 한 줄이고, `cat`한 터미널에 제어 시퀀스가 전달되지 않는다. 한글·이모지 등 보이는 문자는 그대로다.
  - 짝 없는 surrogate(브라우저가 이모지 중간을 자른 메시지)는 이전에는 UTF-8 인코딩 단계에서 500을 냈다. 이제 escape해서 기록한다(독립 리뷰).
  - **크기**: 필드마다 길이를 자른다(`message` 2000자, `url` 500, `vault` 128, `source` 64, `level` 16, `stack` 10줄 × 300자 — 필요한 만큼만 나눈다). 파일이 1 MiB를 넘게 되면 `.1`로 한 번 회전한다(이전 `.1`은 덮어씀). 디스크 사용은 약 2 MiB를 넘지 않는다. 회전과 기록은 lock 하나 안에서 해 동시 요청이 항목을 섞거나 상한을 넘지 않는다.
  - **경로**: `tmp/dashboard.log`는 `./raven.sh`가 vite 출력을 쓰는 파일이다. 다른 프로세스가 열어 둔 파일은 안전하게 회전할 수 없어 이 로그는 `tmp/dashboard-client.log`로 옮겼다.
  - 응답은 `{"ok": true}`뿐이다(서버 경로를 돌려주지 않음). 쓰기 실패는 기존처럼 200 + `ok: false`다(오류 보고 채널이 5xx를 내지 않는다).
  - 대시보드의 오류 수집 자체는 그대로다. 꺼진 서버에서는 404가 조용히 무시된다.
- **문서**: README 환경 변수 표에 `RAVEN_DEBUG_LOG`를 추가했다. `dashboard/src/main.tsx`·`lib/api.ts` 주석의 로그 위치를 바로잡았다.
- **검증**:
  - `tests/test_debug_log_endpoint.py` 51건 신규: opt-in이 아니면 404이고 파일을 만들지 않음(7가지 값) / 꺼진 상태는 깨진 본문에도 404, 켜진 상태는 깨진 본문에 422·파일 없음 / 켜면 기록·경로 미노출(4가지 값) / 개행·CR·VT/FF·FS/GS/RS·NEL·U+2028/2029·NUL/ESC·C1 CSI·bidi override·짝 없는 surrogate가 모든 필드에서 한 줄로 기록됨(11) / 보이지 않는 문자 14종(U+FFFF 위 서식 문자 포함)이 원문 바이트 없이 escape되고 값은 보존됨 / 잉글랜드 국기(태그 문자) 왕복 보존 / 한글·이모지 유지 / 필드 상한 / 회전 후 두 파일 모두 상한 이하·회전이 항목을 자르지 않음 / 8 스레드 동시 기록에서 항목이 섞이지 않음 / 요청마다 게이트 적용 / sendBeacon 형태 본문. 기존 테스트 2건은 opt-in을 켜고 임시 경로를 쓰도록 바꿨다(이전에는 저장소 `tmp/`에 실제로 썼다).
  - 변형 검사: 게이트 제거, 보이지 않는 문자 escape 제거, surrogate escape만 제거, 본문 파싱 뒤 게이트, JSON 대신 평문, 회전 제거, lock 제거, 필드 상한 제거 — 각각 신규 테스트가 실패한다.
- **독립 리뷰**: blocker 없음. should-fix 2건(짝 없는 surrogate 500, 재검토에서 U+FFFF 위 문자 escape 오류)과 nit 3건(꺼진 endpoint의 422 응답, C1·bidi 문자 원문 기록, 스택 전체 분할)을 반영했다.
- **잔여 위험**: 켜 둔 동안에는 loopback 출처 누구나 항목을 쓸 수 있다(최대 약 2 MiB, 위조 불가). 진단할 때만 켠다. 브라우저 페이지를 통한 loopback 신뢰 문제는 #28에서 다룬다.

## 62. loopback 프록시가 XFF와 다른 출처 헤더를 함께 보내면 토큰 요구 (Issue #29)

launcher 모드(`python -m raven.api`, 데스크톱 API·MCP)의 게이트는 loopback peer가 보낸 `X-Forwarded-For`를 해석한다. `Forwarded`나 `X-Real-IP`만 오면 401이었다. 그러나 **XFF와 함께** 오면 XFF만 보고 판정했다(PR #27 리뷰에서 strict xfail로 기록).

- **수정 전 재현** (실제 소켓, 격리 포트, 임시 vault, master `4e9b0e2`):
  - nginx `proxy_set_header X-Real-IP $remote_addr;`만 쓴 구성을 흉내 낸 scratch 프록시를 LAN 주소에 띄웠다. 이 프록시는 클라이언트 헤더를 그대로 넘기고 X-Real-IP만 덧붙인다.
  - LAN 클라이언트가 헤더 없이 요청하면 401이었다. `X-Forwarded-For: 127.0.0.1`을 넣으면 **토큰 없이 200**이었다.
  - 직접 API에 `X-Forwarded-For: 127.0.0.1`과 `X-Real-IP: 192.168.1.50`을 함께 보내도 200이었다.
- **수정** (`raven/core/access.py::effective_client`):
  - launcher 모드에서 loopback peer라도 XFF 외의 출처 헤더가 하나라도 있으면 출처를 알 수 없음(`None`)으로 보고 토큰을 요구한다. 순서와 값은 무관하다. 둘 다 loopback이라고 해도 마찬가지다 — 서로 다른 관례가 섞인 요청은 사칭과 구분할 수 없다.
  - 출처 헤더 목록을 넓혔다: `Forwarded`, `X-Real-IP`에 더해 `X-Client-IP`, `True-Client-IP`, `CF-Connecting-IP`, `Fastly-Client-IP`, `X-Cluster-Client-IP`. 이 헤더만 오는 경우도 기존 `Forwarded`·`X-Real-IP`와 같이 토큰을 요구한다(strict 모드에서도 같다).
  - Core API(`TokenGate`)와 MCP(`LanTokenAuth`)는 같은 함수를 쓴다.
  - `scripts/spa_server.py`도 새 헤더를 업스트림으로 넘기지 않는다(클라이언트 출처 헤더는 모두 버리고 XFF를 새로 쓴다).
- **호환성** (실제 실행):
  - vite dev 서버(대시보드와 같은 `changeOrigin`·`xfwd` 설정, scratch config로 격리 포트에 연결)가 보내는 헤더는 `X-Forwarded-For`, `X-Forwarded-Port`, `X-Forwarded-Proto`, `X-Forwarded-Host`뿐이다. 클라이언트가 보낸 X-Real-IP는 그대로 넘긴다.
  - vite 경유 loopback 클라이언트는 수정 전후 모두 200, LAN 클라이언트는 401(XFF로 127.0.0.1을 넣어도 vite가 실제 주소를 덧붙여 401).
  - 변경점: loopback 클라이언트가 vite를 거치며 직접 `X-Real-IP` 같은 헤더를 붙이면 이제 토큰이 필요하다. 브라우저와 대시보드는 이런 헤더를 보내지 않는다.
  - `spa_server`: 기존 테스트 통과, 새 헤더도 업스트림에서 빠진다(strip 테스트에 5종 추가).
- **수정 후 재현**: 같은 프록시 경로의 `X-Forwarded-For: 127.0.0.1` 요청이 401, 직접 API 조합 요청도 401.
- **문서**: README 프록시 정책, ADR `adr-2026-10-08-core-api-access-gate`(개정 항목), `adr-2026-10-09-mcp-remote-token`, `raven/core/access.py` 모듈 docstring을 갱신했다.
- **검증**:
  - strict xfail `test_known_gap_xff_with_other_forwarding_header_from_loopback`을 일반 테스트로 바꿨다: 다른 출처 헤더 9종 × XFF 3종 × 두 게이트, 헤더 순서 반대도 401, `effective_client`는 `None`.
  - parity 매트릭스(`HEADER_SETS`)에 조합 7가지를 더했다. 계약을 따로 적은 `_expected`도 새 헤더 목록을 쓴다. Core API와 MCP의 판정은 모든 경우 같다.
  - 토큰이 있으면 어떤 헤더 조합이든 통과한다. vite 형태의 헤더(XFF + X-Forwarded-Port/-Proto/-Host)는 기존 판정 그대로다.
  - `tests/test_mcp_forwarded_parity.py`·`test_core_api_forwarded.py`·`test_spa_server_auth.py` 1100 passed.
- **독립 리뷰**: blocker·should-fix 없음. nit 2건(spa_server strip 테스트에 새 헤더, README·ADR의 strict 모드 헤더 목록)을 반영했다.
- **잔여 위험 (변경 없음)**: 이 기기에서 도는 프록시가 **출처 헤더를 하나도 붙이지 않고** API를 LAN에 중계하면 직접 loopback 접속과 구분할 수 없다(승인된 잔여 위험, README). 목록에 없는 비표준 헤더만 쓰는 프록시도 같다.

## 63. 토큰 없는 loopback 통과에 loopback Host·Origin 요구 — 브라우저가 다른 사이트 대신 보내는 요청 차단 (Issue #28)

Core API와 MCP는 직접 loopback 요청을 토큰 없이 통과시킨다. 이 신뢰는 "이 PC의 프로그램과 이 PC가 서빙하는 대시보드"를 위한 것이다. 그런데 브라우저는 다른 사이트의 페이지를 위해서도 loopback 소켓으로 요청을 보내고, 게이트는 소켓 주소만 봤다.

- **수정 전 확인** (격리 포트, 임시 vault, master `fd1d573`):
  - HTTP 수준: Core API와 standalone MCP 모두, Host `evil.example`(DNS rebinding 때 서버가 받는 조건)이나 Origin `https://evil.example`인 요청을 토큰 없이 200으로 받았다. 다른 origin의 `text/plain` POST도 핸들러까지 도달했다.
  - 실제 브라우저: Chrome 155(headless, 임시 프로필)에서 LAN IP origin(`http://192.168.0.52:48880`)의 페이지가 다음을 했다.
    - `http://127.0.0.1:<port>/api/vaults` 응답 본문을 읽었다. CORS 정규식이 사설망 origin을 허용한다.
    - `no-cors` `text/plain` POST로 `/api/debug-log`(opt-in 켬)에 기록했다.
    - 이 실행에서 Chrome의 Local Network Access는 이를 막지 않았다.
  - 실제 DNS rebinding(제어하는 DNS 필요)은 재현하지 않았다. 서버가 받는 조건만 재현했다.
- **수정** (`raven/core/access.py::is_local_browser_context`, `TokenGate`):
  - 토큰 없는 loopback 통과에는 다음이 더 필요하다.
    - Host가 없거나 loopback 이름(`localhost`, `127.0.0.0/8`, `[::1]`, 포트 무관)이다.
    - Origin이 없거나 loopback 페이지 또는 데스크톱 webview(`tauri://localhost`, `http(s)://tauri.localhost`)다.
  - 형식이 틀린 값, `null` Origin, 경로나 userinfo가 붙은 Origin, Host나 Origin이 여러 개인 요청은 거부한다.
  - Origin 없이 `Sec-Fetch-Site: cross-site`·`same-site`인 요청(다른 사이트의 `<img>`·`<script src>`·링크처럼 Origin 없이 실행되는 로드)도 거부한다. 주소창 입력(`none`)과 같은 origin은 통과한다(독립 리뷰). 단, 다른 사이트의 링크로 Core가 서빙하는 대시보드 페이지(`/api` 밖, 최상위 GET/HEAD 탐색)를 여는 것은 허용한다 — 정적 앱만 돌려준다. `/api`와 MCP에는 이 예외가 없다(재검토).
  - 조건을 못 맞추면 토큰을 요구한다(401, detail에 사유). websocket은 1008로 닫는다.
  - Bearer 토큰 요청과 원격 출처 판정은 바뀌지 않았다. Docker `spa_server`(Host 재작성)와 tailnet·LAN 원격 클라이언트는 그대로다.
  - MCP(`LanTokenAuth`)는 같은 판정을 상속한다. MCP SDK의 DNS rebinding 보호는 원격 Host 때문에 계속 끈다.
  - Core API CORS 정규식은 그대로 둔다. 토큰을 가진 원격 대시보드가 쓰고, 토큰 없는 요청은 이제 게이트가 막는다.
- **수정 후** (같은 조건, 실제 서버):

  | 요청 | 수정 전 | 수정 후 |
  |---|---|---|
  | API, Host `evil.example` | 200 | 401 |
  | API, Origin `https://evil.example` | 200 | 401 |
  | API, 다른 origin의 `text/plain` POST | 핸들러 도달(422) | 401 |
  | MCP initialize, Host `evil.example` | 200 | 401 |
  | API·MCP, Host `127.0.0.1`·`localhost`, Origin 없음 | 200 | 200 |
  | API, Origin `tauri://localhost` | 200 | 200 |
  | vite 대시보드(실제 vite, `http://127.0.0.1:…`·`http://localhost:…` 페이지) | 200 | 200 |
  | vite 경유, 다른 origin | 200 | 401 |

  - 수정 후 실제 브라우저 실행은 headless Chrome이 두 번째 실행부터 페이지를 열지 못해(페이지 서버에 요청 없음) **UNKNOWN**이다. 브라우저가 보내는 것과 같은 Host/Origin 헤더로 HTTP 수준에서 검증했다.
- **기존 동작과 달라진 점**:
  - 새로 토큰이 필요한 로컬 클라이언트: Android 에뮬레이터의 `http://10.0.2.2:8765`(`mobile/` 기본값, 호스트 loopback으로 NAT됨), 기기 이름(예: Debian의 `127.0.1.1` 이름)이나 `0.0.0.0`으로 이 PC에 접속하는 클라이언트. `127.0.0.1`·`localhost`를 쓰거나 토큰을 설정한다.
  - 다른 origin 페이지의 요청은 #15 로컬 전용 guard(403)보다 먼저 게이트에서 401로 거부된다. 토큰을 가진 요청은 여전히 guard가 403으로 막는다(테스트로 두 단계 모두 확인).
  - 테스트 클라이언트 기본 Host를 `testserver`에서 `127.0.0.1`로 바꿨다(`tests/conftest.py`). 여러 테스트의 `base_url="http://raven"`도 `http://127.0.0.1`로 바꿨다. 판정 기대값은 바뀌지 않았다.
- **문서**: ADR `adr-2026-10-12-loopback-browser-context`(신규), `adr-2026-10-09-mcp-remote-token`, README(MCP·Core API 접근 정책), `access.py`·`mcp/auth.py`·`mcp/cli.py` 설명.
- **검증**:
  - `tests/test_loopback_browser_context.py` 110건 신규:
    - 이 PC의 Host 8종 × Origin 8종 통과, Host 없는 클라이언트 통과.
    - 낯선 Host 13종, 낯선 Origin 14종 거부, 중복 헤더 거부.
    - 토큰이 있으면 Host·Origin 무관, 원격 출처 판정 불변, 거부 사유 표시, websocket.
    - Core API와 MCP가 모든 조합(launcher·strict)에서 같은 판정, 실제 MCP 앱이 MCP 처리 전에 거부.
    - Origin 없는 cross-site·same-site 로드 거부, 주소창·같은 origin·데스크톱 webview는 통과.
    - launcher 모드의 vite 형태(XFF 127.0.0.1 + Host 재작성 + 페이지 Origin): 로컬 페이지 통과, 다른 origin·cross-site 거부, LAN 브라우저는 토큰 필요.
    - 실제 API 앱에서 데스크톱 Origin 통과(CORS 헤더 포함), `tauri://evil` 거부.
    - 다른 사이트 링크로 대시보드 페이지 열기는 허용, `/api`·POST·하위 리소스·iframe·MCP는 거부, 섞인 `Sec-Fetch-Site` 값은 거부 쪽.
  - 변형 검사: 게이트에서 이 검사를 빼면 신규 테스트 61건, `Sec-Fetch-Site` 규칙만 빼면 8건이 실패한다.
- **독립 리뷰**: blocker 없음. should-fix 3건(새로 토큰이 필요한 로컬 클라이언트 문서화, launcher 모드 vite 형태 테스트, Origin 없는 cross-site 로드 — `Sec-Fetch-Site` 규칙으로 구현)을 반영했다. 재검토 should-fix 1건(다른 사이트 링크로 Core의 대시보드 페이지를 열면 401 — 페이지 탐색만 예외)도 반영했다.
  - 전체 pytest 2723 passed, 2 failed(기존 실패 `closed_stderr_pipe`·`test_no_candidates_is_not_an_error`).
- **잔여 위험**:
  - loopback 이름으로 서빙되는 다른 로컬 웹 앱의 페이지(같은 PC의 `http://localhost:3000` 등)는 여전히 토큰 없이 호출할 수 있다. loopback 프로세스 신뢰와 같은 부류다.
  - `Sec-Fetch-Site`를 보내지 않는 오래된 브라우저에서는 Origin 없는 cross-site GET이 여전히 실행된다(응답은 읽지 못함). rebinding은 Host로 막힌다.
  - 실제 DNS rebinding 브라우저 재현과 수정 후 브라우저 실측은 **UNKNOWN**이다.

## 64. 데스크톱 webview CSP 도입·ATS 예외 축소·vault 페이지 raw HTML 정화 (Issue #17)

데스크톱 webview에는 CSP가 없었고(`csp: null`), 앱 전체에 ATS 예외(`NSAllowsArbitraryLoads`)가 걸려 있었다. 감사 기록은 "악용 가능한 sink 없음, 마크다운은 `skipHtml` 기본값에 의존"이었다. 이 작업 중 그 전제가 틀렸음을 확인했다.

- **발견 — vault 페이지의 raw HTML이 그대로 렌더링됐다**:
  - `MDEditor.Markdown`(`@uiw/react-md-editor` 4.1.1 → `@uiw/react-markdown-preview` 5.2.1)의 기본 진입점은 `skipHtml`과 무관하게 항상 `rehype-raw`를 넣는다. 거르는 것은 태그 이름 정규식(`/^[A-Za-z0-9]+$/`)뿐이었다.
  - jsdom 렌더링: `<iframe srcdoc>`, `<iframe src>`, `<embed>`, `<object>`, `<form>`, `<base>`, `<style>`, `style=` 속성이 DOM에 남았다. 이벤트 핸들러 속성과 `javascript:` URL은 React가 막았다.
  - **실제 데스크톱 앱**(수정 전 설정으로 만든 격리 빌드): vault 페이지의 `<iframe srcdoc="<script>…</script>">` 스크립트가 **앱 origin으로 실행됐다**(부모 창 변수에 접근). `<embed>`와 화면 전체를 덮는 `style` 오버레이도 렌더링됐다. vault 페이지는 사람·동기화·MCP 에이전트가 쓰므로 신뢰할 수 있는 마크업이 아니다.
- **수정 1 — raw HTML 정화** (`dashboard/src/lib/markdown-safety.ts`, 신규 의존성 없음):
  - 모든 `MDEditor.Markdown`(보기·편집 미리보기 3곳)에 `SAFE_MARKDOWN_PROPS`를 준다.
  - `allowElement`: Markdown/GFM이 만드는 요소, 라이브러리의 복사·앵커 아이콘, 무해한 HTML(`details`, `kbd`, `sub`, `mark`, `br` 등)만 남기고 나머지는 내용째 버린다. `<input>`은 GFM 체크박스만.
  - `rehypeRewrite`와 **마지막 rehype 플러그인**: `on*`, `style`, `srcdoc`, `action`/`formaction`, `target`/`download`/`autoplay` 등을 지우고, URL 속성은 http(s)·mailto·tel·상대 경로만 남긴다(이미지는 래스터 `data:`도). 제어문자를 섞은 `javascript:`도 거른다.
  - 마지막 플러그인이 필요한 이유(독립 리뷰 BLOCKER): 라이브러리는 `rehypeRewrite` **뒤에** `rehype-attr`를 돌린다. 이것은 페이지의 `<!--rehype:style=…&href=…-->` 주석을 앞 요소의 속성으로 옮긴다. 그래서 `rehypeRewrite`만으로는 화면을 덮는 `style`과 `href` 교체가 되살아났다. 사용자 `rehypePlugins`는 그 뒤에 돌므로 여기서 한 번 더 정화한다. 요소 필터(`allowElement`)는 모든 플러그인 뒤에 적용된다.
  - `skipHtml: true`를 명시했다(라이브러리 기본값 변경에 기대지 않음). 위의 이유로 이것만으로는 부족해 정화가 본체다.
- **수정 2 — webview CSP** (`desktop/src-tauri/tauri.conf.json`):
  - `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: http: https:; media-src …; connect-src 'self' ipc: http://ipc.localhost http: https: ws: wss:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'`.
  - `script-src`는 `'self'`만이다. `unsafe-inline`·`unsafe-eval` 없음. `index.html`의 인라인 테마 스크립트는 `public/boot-theme.js`로 옮겼다.
  - `style-src 'unsafe-inline'`은 남겼다: 라이브러리가 실행 중에 `<style>`을 넣고, React 인라인 스타일도 쓴다. Tauri가 style-src에 해시를 더하면 브라우저가 `'unsafe-inline'`을 무시하므로 `dangerousDisableAssetCspModification: ["style-src"]`로 그 수정만 끈다. 스크립트에는 해당하지 않는다.
  - `connect-src`·`img-src`의 `http:`/`https:`: 사용자가 등록하는 다른 Raven 호스트(tailnet·LAN의 임의 주소)와 그 이미지에 필요하다.
  - `devCsp`는 vite 개발 서버(HMR 인라인 스크립트) 때문에 `script-src`만 `'unsafe-inline' 'unsafe-eval'`을 더한다. 배포 빌드에는 쓰이지 않는다.
- **수정 3 — ATS 축소** (`desktop/src-tauri/Info.plist`): `NSAllowsArbitraryLoads` → `NSAllowsLocalNetworking`(loopback, IP 주소, 점 없는 이름, `.local`) + `ts.net` 예외(Tailscale MagicDNS, 평문 HTTP 허용). 그 밖의 호스트는 HTTPS가 필요하다.
  - **호환성 변경**: 점이 있는 사설 이름을 평문 HTTP로 쓰던 호스트 등록 — `nas.lan`, `*.home.arpa`, `*.internal`, 공유기 DNS 접미사, Headscale 등 `ts.net`이 아닌 MagicDNS 도메인 — 은 이제 일반 네트워크 오류로 실패한다. IP 주소나 `.local`·점 없는 이름으로 등록하거나 HTTPS를 쓴다.
- **실제 앱 검증** (scratch에만 둔 별도 identifier `.app` 번들 2개, 실제 셸 + 실제 Core + 격리 HOME·vault, 같은 probe 스크립트):

  | 항목 | 수정 전 설정 | 수정 후 |
  |---|---|---|
  | vault 페이지 `<iframe srcdoc><script>` | 실행됨, iframe 1·embed 1·overlay 1 | iframe·embed·overlay 0, 실행 안 됨 |
  | 리뷰에서 찾은 `<!--rehype:style=…-->` 주석(화면 덮개) | — | 마지막 플러그인 추가 후 다시 만든 앱에서 `style` 속성 0, CSP 위반 0, 내보내기 정상 |
  | 인라인 `<script>` / srcdoc 스크립트 / `eval` (probe가 직접 시도) | 모두 실행 | 모두 차단(CSP 위반 보고) |
  | 대시보드 경로 8곳(홈·검색·그래프·로그·린트·정원·관리·페이지) | — | 앱 자체의 CSP 위반 0, 테마 스크립트 동작, 페이지 렌더링 |
  | 내보내기(공유 → Markdown 저장) | 저장됨 | 저장됨(격리 HOME의 Downloads) |
  | ATS: `127.0.0.1`·`localhost`·LAN IP·`<이름>.local` | 200 | 200 |
  | ATS: 공개 도메인 평문 HTTP(`localtest.me`, 127.0.0.1로 해석) | 200 | 차단 |
- **검증**:
  - dashboard: `src/lib/markdown-safety.test.tsx` 33건 신규(위험 요소 15종 제거, 위험 속성·URL 14종 제거 — rehype-attr 주석 경로 포함, 일반 Markdown·GFM·위키링크·코드 복사 버튼·이미지·`details` 등 유지, 링크 대상 유지, 모든 `MDEditor.Markdown`에 적용됐는지 소스 검사). vitest 568 passed, `tsc -b` 통과. 마지막 플러그인을 빼면 신규 테스트 4건이 실패한다.
  - Rust: `webview_csp_is_set_and_scripts_stay_self_only`(csp가 null이 아님, script-src `'self'`만, `unsafe-eval`·와일드카드 없음, `unsafe-inline`은 style-src에만, object/frame/base/form 제한, `index.html`에 인라인 스크립트 없음), `ats_allows_local_networking_not_arbitrary_loads`. `cargo test` 80 passed.
- **독립 리뷰**: BLOCKER 1건(rehype-attr 주석으로 속성 복원)을 마지막 플러그인으로 고쳤다. should-fix 2건(점 있는 사설 이름의 ATS 실패 문서화, changelog 주장 정정)과 nit 4건(`target`·`download`·`autoplay` 제거, Rust 테스트의 인라인 스크립트 검사 강화·plist 공백 무관 비교)을 반영했고, 재검토에서 blocker·should-fix 없이 확인됐다. 원본 HTML의 `id`·`class`는 남는다(앱 스타일을 빌릴 수 있으나 스크립트는 아님 — 헤딩 앵커·코드 강조가 같은 속성을 쓴다).
- **잔여 위험·UNKNOWN**:
  - `ts.net` 예외 경로(MagicDNS 이름으로 등록한 호스트)는 실제 tailnet을 쓰지 않고는 확인할 수 없어 **UNKNOWN**. 공개 도메인을 평문 HTTP로 등록해 쓰던 구성은 이제 HTTPS가 필요하다.
  - `style-src 'unsafe-inline'`은 남는다(스크립트 실행은 아니고 스타일 주입). `connect-src http:`는 넓다 — 임의의 사용자 호스트 때문이다.
  - Windows·Linux webview의 CSP 동작은 **UNKNOWN**(macOS WKWebView만 실측). 정화는 플랫폼과 무관하다.
  - 업데이트 서명 등 배포 번들 경로는 검증하지 않았다(scratch 번들은 `createUpdaterArtifacts: false`, 미서명).

## 65. loopback에도 Bearer를 요구하는 opt-in 강화 모드 (Issue #67, PR #69)

macOS Docker Desktop은 컨테이너의 `host.docker.internal` 연결을 호스트 loopback으로 넘긴다. Core·MCP에는 peer `127.0.0.1`로 보이고, 컨테이너가 `Host: 127.0.0.1:<port>`를 보내면 #28의 토큰 없는 loopback 통과를 받는다(실측: master `ffe72d2`에서 Core `/api/vaults`·MCP `initialize` 모두 토큰 없이 200, 잘못된 토큰을 보내도 200). Host/Origin과 소켓 주소로는 같은 PC의 프로세스와 컨테이너를 구분할 수 없다.

- **변경** (`raven/core/access.py`):
  - `RAVEN_REQUIRE_LOOPBACK_TOKEN`이 참(`1`·`true`·`yes`·`on`, 대소문자·앞뒤 공백 무시 — `require_loopback_token_from_env`)이면 `TokenGate`가 loopback을 포함한 모든 HTTP·WebSocket 요청에 유효한 Bearer를 요구한다. Core API와 MCP(`LanTokenAuth`)가 같은 게이트를 쓴다. WebSocket은 close 1008. URL query의 토큰은 읽지 않는다.
  - 기본값(미설정·그 밖의 값)은 바뀌지 않는다 — 직접 loopback 연결은 지금처럼 토큰 없이 통과한다. 그래서 **이 변경만으로 #67은 닫히지 않는다**.
  - 401 안내는 출처에 맞춘다: loopback 출처는 "loopback 요청에도 토큰 필요", LAN·tailnet·프록시가 알려 준 원격 출처는 기존 원격 접근 문구, 출처를 알 수 없는 요청(#29의 모호한 프록시 헤더)은 일반 Bearer 문구. (첫 버전은 강화 모드의 모든 401에 loopback 문구를 써서 LAN 요청에도 사실과 다른 안내가 나갔다 — 리뷰에서 고침.)
- **적용 범위와 제약** (README "loopback과 Docker Desktop", `docs/issues/docker-desktop-loopback-토큰-우회.md`):
  - 프로세스 환경에서만 읽는다. `./raven.sh`는 `.env`를 읽으므로 거기에 쓰면 된다. Finder·Dock으로 연 Raven.app은 셸 환경을 받지 않아 적용되지 않는다(`launchctl setenv` 또는 터미널 실행).
  - 대시보드(vite·데스크톱)는 401에서 토큰 입력 창을 띄우고, 입력 후 모든 요청에 토큰을 붙인다. 토큰은 sessionStorage에만 있어 앱·창마다 다시 입력해야 한다.
  - Docker compose healthcheck는 토큰을 보내지 않는다 — 컨테이너에서 강화 모드를 켜면 API healthcheck는 실패하고 MCP healthcheck는 401을 성공으로 친다.
  - Core가 서빙하는 정적 페이지도 토큰이 필요해진다. 토큰 없이 API를 부르는 `scripts/restart-all.sh`·`scripts/smoke-desktop.sh`는 실패로 보고한다.
  - 테스트: `tests/conftest.py`가 이 변수를 지운다(`launchctl setenv`로 넣은 값이 터미널과 pytest에 들어오면 기본 정책 테스트가 깨진다). 강화 모드 테스트는 스스로 켠다.
- **실측** (격리 포트·임시 토큰 저장소, 실제 Docker Desktop 컨테이너 `curlimages/curl` → `host.docker.internal`, 서버 로그의 peer 26건 모두 `127.0.0.1`):

  | 요청 | 기본 Core / MCP | 강화 Core / MCP |
  |---|---|---|
  | 토큰 없음, 기본 Host | 401 / 401 | 401 / 401 |
  | 토큰 없음, `Host: 127.0.0.1:P` | **200 / 200** | 401 / 401 |
  | 토큰 없음, Host·Origin 모두 loopback | 200 / – | 401 / – |
  | 잘못된 토큰, Host 위조 | 200 / 200 | 401 / 401 |
  | 유효 토큰(기본 Host·위조 Host) | 200 / 200 | 200 / 200 |

  강화 모드에서 vite 프록시(토큰 없음 401 + `WWW-Authenticate: Bearer`, 토큰 200), standalone Core·MCP(토큰으로 initialize·tools/list 25개), 격리 빌드한 데스크톱 앱(readiness 통과, 토큰 입력 후 vault 목록·페이지·내보내기·Core 재시작 정상, 입력 후 토큰 없는 `/api` 요청 0건)을 확인했다.
- **검증**: `tests/test_issue67_loopback_token.py` 47건(참값·그 밖의 값 해석, 환경변수의 대소문자·공백, WebSocket 무토큰·잘못된 토큰 1008과 유효 토큰 accept — Core·MCP 게이트, 기본 모드 WebSocket 유지, 잘못된 토큰·Host/Origin 위조 401, query 토큰 401, 출처별 401 문구 5종·launcher 모드 2종과 기본 모드 문구 유지, 실제 소켓 standalone MCP: 무토큰·위조·잘못된·회수된 토큰·query 토큰 401과 SDK initialize·tools/list 성공). 변이 검사: 강화 모드 무시 시 21건, 대소문자 구분 해석 시 4건, 원격에도 loopback 문구 시 2건 실패. 전체 pytest(셸에 `RAVEN_REQUIRE_LOOPBACK_TOKEN=1`을 export한 채로): 2789 passed, 2 failed, 3 skipped — 실패 2건(`closed_stderr_pipe`, `test_no_candidates_is_not_an_error`)은 master에서도 같은 원인으로 실패한다(#68).
- **독립 리뷰**: blocker 없음. should-fix 3건 반영 — conftest가 이 변수를 지우게 함(export된 채로 돌리면 기존 테스트 9건이 깨졌다), changelog의 빠진 전체 테스트 결과, 이슈 문서를 `docs/issues/`(한국어·frontmatter)로 이동. nit 반영 — 모듈·게이트 docstring, 함수 위치, compose 주석·로컬 스크립트 언급, 테스트 import 정리·fixture 이름, launcher 모드(vite xfwd) 401 문구 테스트 2건, 실소켓 테스트의 stderr.

## 66. Core API·MCP는 같은 PC(loopback)에도 토큰을 요구한다 — 데스크톱 세션 자격 증명·`/healthz`·정적 파일 분리 (Issue #67)

§65(PR #69)의 opt-in 강화 모드를 기본 동작으로 바꿨다. 기본 설치는 macOS Docker Desktop의 컨테이너가 `host.docker.internal` → 호스트 loopback으로 들어와 `Host: 127.0.0.1:<port>`만 붙이면 Core API와 admin MCP를 토큰 없이 쓸 수 있었다. 결정: [`_meta/decisions/adr-2026-10-13-loopback-token-required.md`](decisions/adr-2026-10-13-loopback-token-required.md) — [[adr-2026-10-12-loopback-browser-context]]를 대체하고 이전 ADR 3개의 "loopback은 토큰 없이 통과"를 대체한다.

- **게이트** (`raven/core/access.py::TokenGate`, MCP `LanTokenAuth`): 모든 출처에 유효한 Bearer. 토큰 없는 loopback 통과, #28의 Host/Origin 조건(`is_local_browser_context`), `trust_tailnet`, `RAVEN_REQUIRE_LOOPBACK_TOKEN`(§65)을 없앴다. 잘못된·회수된 토큰과 URL query의 토큰은 401, WebSocket은 1008. 출처는 #15 이 PC 전용 API와 401 문구(같은 PC / 원격 / 출처 미상)에만 쓴다.
- **예외 두 가지**:
  - `GET /healthz` — 게이트가 직접 `200 {"ok":true}`(앱 코드에 닿지 않음, Core·MCP 공통). 정확히 그 경로·메서드만.
  - Core가 서빙하는 대시보드 정적 파일(`raven/api/server.py::_is_public_static`): `GET`/`HEAD`, `/api`·`/api/...`·API 문서(`/docs`, `/redoc`, `/openapi.json`) 제외. 경로는 라우터가 매칭하는 경로(`access.route_path` — `root_path`를 뗀 경로)로 판정한다.
  - SPA fallback이 빌드 폴더 밖 파일을 서빙하던 경로 탈출을 막았다(`//etc/passwd` → `full_path` "/etc/passwd", `..`). 정적 경로가 무인증이 되면서 필요해진 수정이다. `/%00` 같은 잘못된 경로는 500 대신 `index.html`.
- **데스크톱 앱 — 실행별 세션 자격 증명** (후보 A: Rust IPC 중개, B: 로컬 인증 프록시, C: 세션 자격 증명 비교 후 C — ADR 참고):
  - 셸(`desktop/src-tauri/src/core.rs::session_token`)이 앱 실행마다 `rvs_` + 32바이트(Unix `/dev/urandom`, 그 밖에는 OS 시드 `RandomState`) 비밀을 만든다. Core에는 stdin 한 줄(`RAVEN_DESKTOP_SESSION_STDIN=1`, `launch_inner`), webview에는 IPC `core_session_token`(앱 `main` 창만, `permissions/default.toml`)으로 준다. argv·환경 변수·파일·로그·readiness 줄·URL에는 넣지 않는다. Core 재시작·포트 이동 때 같은 값을 다시 넘긴다.
  - Core(`raven/desktop/runtime.py::_read_session_token` → `access.set_session_token`)는 SHA-256만 메모리에 둔다. Core API에서만, 실효 출처가 같은 PC일 때만 받는다 — MCP와 LAN/tailnet(vite 중계 포함)에서는 401.
  - 대시보드(`dashboard/src/lib/host-auth.ts::setSessionCredential`, `main.tsx`)는 메모리에만 두고 데스크톱 Core의 정확한 origin에만 붙인다. 거절되면 지우고 토큰 입력창으로 넘어간다.
- **vite 대시보드**: 프록시는 토큰을 대신 붙이지 않는다(붙이면 vite에 닿는 컨테이너·tailnet 기기가 모두 인증된 셈). 같은 PC에서도 첫 401에서 토큰 입력창이 뜬다. `strictPort: true` — 데스크톱 dev webview(`devUrl` 5173)가 다른 프로세스의 페이지를 앱으로 띄워 IPC 자격 증명을 내주지 않게(리뷰 should-fix).
- **compose healthcheck**: API·MCP 모두 `curl -fsS http://127.0.0.1:<port>/healthz`. 예전 MCP 검사(`curl -sS -o /dev/null /mcp`)는 401도 성공으로 쳤다.
- **스크립트·문구**: `scripts/restart-all.sh` 헬스체크 → `/healthz`, `scripts/smoke-desktop.sh`는 `RAVEN_SMOKE_TOKEN`(헤더는 600 임시 파일로, argv에 안 남김). 토큰 입력창·호스트 추가 도움말·CLI 도움말·기동 배너의 "loopback은 토큰 없이" 문구 정정. 대시보드 오류 보고(`/api/debug-log`, #19)는 `sendBeacon`이 토큰을 못 실어 `lib/client-debug-log.ts`로 옮겨 인증 fetch로 보낸다(자기 요청의 실패는 보고하지 않음 — 리뷰가 찾은 무한 반복 방지).
- **호환성 변경**: 토큰 없이 같은 PC에서 `/api`·MCP를 부르던 클라이언트(로컬 MCP 클라이언트 `http://127.0.0.1:8766/mcp`, curl·스크립트, vite 대시보드)는 토큰이 필요하다. 데스크톱 webview, Docker 대시보드(`spa_server` 로그인), 원격 토큰 클라이언트는 그대로다.
- **실측 — Docker Desktop 공격** (실제 `curlimages/curl` 컨테이너 → `host.docker.internal`, 서버 로그의 peer 44건 모두 `127.0.0.1`, 격리 포트·임시 토큰):

  | 요청 | 수정 전 master `f11285f` Core / MCP | 수정 후 Core / MCP |
  |---|---|---|
  | 토큰 없음, 기본 Host | 401 / 401 | 401 / 401 |
  | 토큰 없음, `Host: 127.0.0.1` | **200 / 200** | 401 / 401 |
  | 토큰 없음, Host·Origin loopback(`tauri://` 포함) | **200 / 200** | 401 / 401 |
  | 잘못된 토큰, Host 위조 | **200 / 200** | 401 / 401 |
  | 회수된 토큰 / URL query 토큰만 | 401 / 401 | 401 / 401 |
  | 유효 토큰 | 200 / initialize + tools/list 14개 | 200 / initialize + tools/list 14개 |
  | WebSocket upgrade, 토큰 없음 | 403 / 403 | 403 / 403 |
  | `/healthz` | 401 / 401 | 200 / 200 |

  IPv6 `[::1]`(uvicorn `--host ::1`, MCP `--host ::1`): 토큰 없음·Host/Origin 위조 401, 토큰 200. `uvicorn --root-path /x`: `GET /api/vaults` 401(리뷰 BLOCKER 수정 전에는 정적 경로로 오판될 수 있었다).
- **실측 — 실제 macOS 앱** (격리 빌드, 임시 HOME·vault·포트): 첫 실행에 토큰 입력창 없이 vault 목록·페이지·내보내기, 관리 화면 Core 재시작, 포트 이동 후 자동 리로드까지 인증 유지. 앱 밖(Mac의 curl, Docker 컨테이너)의 토큰 없는 요청 401. 세션 자격 증명은 sessionStorage·localStorage·쿠키·URL·앱 로그 어디에도 없음(`rvs_` 0회). 세션 자격 증명으로 MCP 401, 발급 토큰으로 initialize·tools/list 25개. 일부러 거절시키면 토큰 입력창 → 발급 토큰으로 복구. 앱 코드 CSP 위반 0, 종료 시 Core 3개 모두 정리.
- **실측 — Docker compose** (`docker compose -p audit67`, 격리 포트): api·mcp-http `healthy`(`/healthz`), `/api/vaults`를 healthcheck로 쓰면 `unhealthy`(401 = 실패). 호스트·컨테이너 안 loopback·같은 망의 다른 컨테이너에서 토큰 없이 401(Host/Origin 위조 포함). 발급 토큰으로 API 200, MCP initialize·tools/list. `spa_server` 로그인 → `/api` 200.
- **실측 — vite**: 토큰 없음 401 + `WWW-Authenticate: Bearer`, 토큰 200, 잘못된 토큰 401, 위조 Origin·XFF 401, Docker → vite 403/401(200 없음). vite가 Authorization을 붙이지 않음을 중간 hop 로그로 확인.
- **검증**:
  - pytest 전체: 3191 passed, 2 failed, 3 skipped — 실패 2건(`closed_stderr_pipe`, `test_no_candidates_is_not_an_error`)은 master와 같은 원인(#68). `tests/conftest.py`는 모든 테스트에 테스트용 세션 자격 증명을 주고 TestClient가 보내게 한다(`no_auto_auth` 마커로 끔). 이전 정책을 단언하던 보안 테스트 11개 파일을 새 계약으로 옮겼다(tokenless loopback 401 + 토큰 200, 출처 판정은 `effective_client`·#15 결과로 확인). `tests/test_issue67_loopback_token.py` 신규 계약 테스트(loopback 4종 × 위조 헤더 7종 × Core·MCP, 세션 자격 증명 범위, WebSocket, `/healthz` 정확성, 401 문구, 실제 서버의 정적 파일·경로 탈출 18종·`root_path`, SDK 실소켓 MCP). 데스크톱 runtime 테스트는 셸처럼 stdin으로 자격 증명을 넘긴다(신규: stdin 없으면 읽지 않음, readiness·stderr에 비밀 없음, MCP는 세션 자격 증명 거부).
  - 변이 검사: 토큰 없는 loopback 복원·세션 자격 증명 출처 제한 제거·느슨한 `/healthz`·fallback 경로 검사 제거·느슨한 정적 판정·`root_path` 미적용·대시보드 origin 제한 제거·오류 보고 반복 방지 제거 — 모두 테스트가 실패(또는 멈춤)로 잡았다.
  - Rust: `cargo test` 84 passed(macOS·Linux Docker; 신규 4 — stdin으로 한 줄 뒤 EOF, stdin을 안 읽는 Core도 기동, 토큰 형식·실행 내 고정, `start`가 argv·env에 넣지 않음).
  - dashboard: vitest 579 passed(신규 `DesktopSessionCredential` 8, `ClientDebugLog` 3), `tsc -b` 통과.
  - Linux Docker pytest(보안·데스크톱 5개 파일): Python 3.12에서만 나던 테스트 헬퍼 회귀(`communicate()`가 닫힌 stdin을 flush)를 고친 뒤 614 passed, 1 failed(#68).
- **독립 보안 리뷰**: BLOCKER 1건 — `root_path`가 있으면 정적 판정이 라우터와 다른 경로를 봐 `/api`가 공개로 오판(이 PR이 만든 회귀) → `route_path`로 수정, 실소켓 확인. should-fix 2건 — vite `strictPort`, debug-log 401 → 반영. 재리뷰에서 debug-log 수정이 만든 무한 반복(BLOCKER, 보안 아님)을 고쳤다. nit 반영: NUL 경로 500, `pythonw`의 `stdin=None`, revoke와 세션 자격 증명의 관계 문서화, 테스트 이름.
- **잔여 위험·UNKNOWN**:
  - 토큰을 가진 macOS Docker Desktop 컨테이너는 같은 PC로 보여 #15 이 PC 전용 API도 쓸 수 있다.
  - webview에서 스크립트가 실행되면(XSS) IPC로 세션 자격 증명을 얻어 앱이 켜져 있는 동안 같은 PC에서 Core API를 쓸 수 있다 — webview 스크립트는 원래 Core를 부를 수 있으므로 새 권한은 아니다. 같은 사용자의 다른 프로세스가 값을 얻으면 같은 PC에서 쓸 수 있다(운영체제 사용자 경계 밖은 범위 밖).
  - Windows의 비밀 생성은 `RandomState` 대체 경로다. `getrandom` 직접 의존성은 사용자 승인이 필요해 넣지 않았다.
  - OrbStack·Colima·Podman(이 Mac에 없음), Windows·Linux webview 실측은 UNKNOWN.

## 67. 데스크톱 세션 자격 증명 — OS CSPRNG 직접 사용, Core마다 새로 발급 (Issue #67 후속)

§66의 세션 자격 증명은 Unix에서 `/dev/urandom`을 읽고, 그 밖(Windows)에서는 OS로 시드된 std `RandomState`의 SipHash 출력으로 대신했다. Windows 경로는 OS CSPRNG의 출력이 아니라 키 128비트에서 늘린 값이라 보장이 부족했다. 또 앱 실행 동안 같은 값을 모든 Core 재시작에 재사용했다.

- **생성** (`desktop/src-tauri/src/core.rs::new_session_token`): `getrandom::fill`로 32바이트(macOS `getentropy`, Linux `getrandom(2)`(없으면 `/dev/urandom`), Windows `ProcessPrng`) → `rvs_` + 64 hex(256비트). 실패하면 `None` — 약한 난수로 대신하지 않고, 그 Core는 세션 자격 증명 없이 떠서 대시보드가 발급 토큰을 묻는다(fail closed).
  - 의존성: `getrandom = "0.3"`을 직접 의존성으로 추가(사용자 승인). tauri가 이미 쓰는 0.3.4라 새로 받는 crate는 없다(`Cargo.lock`에는 `raven-desktop` → `getrandom 0.3.4` 한 줄). 추가 feature 없음.
- **수명**: Core를 시작할 때마다(재시작·포트 이동 포함) 새로 만든다. 값은 그 `ManagedCore`에만 있고(`session_token()`), IPC `core_session_token`은 지금 Core의 값을 준다(없으면 `Err`). 재시작한 Core는 이전 값을 거부한다.
- **대시보드** (`dashboard/src/lib/host-auth.ts`, `api-base.ts`, `main.tsx`): 세션 자격 증명이 401을 받으면 셸에서 현재 값을 다시 받아(`setSessionRefresher` → IPC) 다른 값일 때만 한 번 재시도한다. 같거나 없으면 토큰 입력창. 한 번만 읽을 수 있는 본문(stream)은 재시도하지 않는다.
- **검증**:
  - Rust `cargo test` 86 passed(macOS). 신규: 256비트 hex 형식과 2000회 생성 중복 없음, 생성기 실패 시 `None`이고 생성 함수에 비-CSPRNG 소스(`RandomState`·`/dev/urandom`·시간·PID)가 없음, Core가 stdin으로 받은 값과 webview에 주는 값이 같음, 비밀 없이 띄운 Core는 값이 없음, `start`가 Core마다 새로 만들고 재사용 저장소(`OnceLock`)가 없으며 argv·환경 변수에 넣지 않음.
  - pytest: `test_a_restarted_core_refuses_the_previous_credential`(실제 runtime 두 번 — 이전 값 401, 새 값 200).
  - vitest: 회전 후 자동 재시도(입력창 없음), 이전 값을 다시 보내지 않음, 같은 값·IPC 실패 시 입력창, stream 본문 재시도 안 함, 동시 401 3건에 IPC 1회·입력창 없음, 늦게 도착한 이전 값의 401이 새 값을 지우지 않음, 포트가 바뀌었으면 새 값을 옛 포트로 보내지 않음.
  - Rust: IPC가 한 Core의 endpoint와 자격 증명을 함께 준다(`SessionSnapshot`), 자격 증명이 없으면 `Err`.
- **IPC 형태**: `core_session_token`은 `{endpoint, token}`을 준다(같은 Core에서 함께 읽음). 대시보드는 endpoint가 자기 Core일 때만 받는다 — 포트가 옮겨진 사이 옛 포트를 다른 프로세스가 잡아도 새 자격 증명이 그쪽으로 가지 않는다.
- **동시 401**: 재시도 판단은 그 요청이 보낸 값으로 한다. 이미 다른 요청이 새 값을 받았으면 IPC 없이 새 값으로 재시도하고, 이전 값에 대한 401은 새 값을 지우지 않는다. 동시에 들어온 갱신은 IPC 한 번을 나눠 쓴다.
- **CSPRNG 실패 시**: 셸은 `RAVEN_DESKTOP_SESSION_STDIN`을 Core 환경에서 지운다(상속된 값으로 Core가 터미널 등 다른 stdin을 자격 증명으로 읽지 않게).
- **Windows**: 소스와 빌드로 확인 — getrandom 0.3.4 `backends/windows.rs`가 `bcryptprimitives.dll`의 `ProcessPrng`를 raw-dylib로 부른다(Windows 10+에서 실패하지 않음). `cargo check --target x86_64-pc-windows-gnu`(전체 crate) 통과. msvc 타깃 전체 check는 Linux 컨테이너에 MSVC C 툴체인이 없어 `ring` 빌드 스크립트에서 실패했다(이번 변경과 무관). getrandom만 쓰는 최소 crate는 msvc check 통과. **실제 Windows 실행은 UNKNOWN**(Windows 환경 없음).
- **독립 리뷰**: blocker 없음. should-fix 2건(동시 401이 새 자격 증명을 지움, 포트 이동 중 옛 포트로 전송) 반영. nit 반영: 상속된 stdin 플래그 제거, 문구.

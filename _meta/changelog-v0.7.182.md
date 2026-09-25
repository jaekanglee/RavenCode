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

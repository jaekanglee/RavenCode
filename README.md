# Raven — local-first Zettelkasten-inspired markdown PKM

> **markdown SoT + 사람 1차 + 제텔카스텐식 연결 지식 + 에이전트 옵션 + multi-vault.** Obsidian 모티브 + 자유 구조 + 자체 Dashboard. LLM Wiki 패턴은 vault 안에서 +α로 선택적 도입.
>
> 옵시디언의 모티브를 빌려왔지만, **에이전트 옵션 + 프로그래머블 진입점 + LLM Wiki +α**가 차별점. Obsidian clone이 아님.

## North Star (v0.6.37 재정렬)

> **"Raven은 사람을 1차 사용자로 하는 local-first Zettelkasten-inspired markdown PKM이며, 원하는 vault 영역에만 LLM Wiki 패턴을 +α로 켜 AI 에이전트가 이해하고 재사용하기 좋은 compounding knowledge를 누적한다."**
>
> — **Zettelkasten 원칙 (작은 생각 단위 + 링크 + 누적) + Obsidian 모티브 (자유 vault) + Karpathy LLM Wiki (2026) 영감 + 자체 구현체.** 분업: 사람은 source curate + 방향 결정, **원하면** vault의 특정 영역에서 LLM Wiki 패턴(raw/, log.md, _meta/agents/)을 켜서 에이전트가 compile / cross-reference / lint / consistency를 도울 수 있음. **컴파일 후 reuse, 매번 재구성 ❌.**

---

## 무엇인가

raven는 **사람 1차 Zettelkasten-inspired 마크다운 PKM 도구**. Obsidian-style 자유 vault와 자체 Dashboard를 제공하고, Karpathy LLM Wiki (2026) 패턴을 영감으로 받아 vault 안에서 선택적 +α로 도입 가능하다. **local-first 마크다운 지식 vault**.

| 계층 | 구현 | 위치 |
|---|---|---|
| **Vault** (데이터) | 마크다운 폴더 (Obsidian식 자유 계층) | `~/Raven/<name>/` (v0.6.3+) |
| **Index** (쿼리) | SQLite (FTS5 + backlinks view) | `<vault>/wiki.db` |
| **Engine** (Python) | raven.core (db/lint/export/link) | `raven/core/` |
| **CLI** (사람/자동화) | Typer 6 top-level commands + 11 subcommand groups | `raven/cli/` |
| **API** (HTTP) | FastAPI 65 endpoints | `raven/api/` |
| **GUI** (웹) | React 19 + Vite + PWA | `dashboard/` |
| **MCP** (LLM 표준) | MCPServer 23 tools + 4 resources | `raven/mcp/` |

**SoT = 마크다운**. DB/API/GUI/MCP는 **모두 재생성 가능**한 파생 산출물.

> **LLM 의존 기능 = Layer 2 (옵션)** — AI 조언(`/ai-advice`), RAG(`/rag/query`), 태그 추천(`/suggest-tags`), 초안 생성(`/drafts/generate`), 그리고 의미 검색의 **벡터 절반**은 외부 API 키 또는 `sentence-transformers` 설치가 있어야 제대로 동작한다. 없으면 규칙 기반 fallback으로 축소되고, 검색/RAG 응답의 `embedding.degraded`가 그 사실을 알린다.
> **Layer 1(사람용 PKM: 페이지 CRUD, wikilink/backlink, BM25 검색, lint, 그래프)은 이 중 아무것도 없이 완전히 동작한다.**

---

## 누가 쓰는가 (사용자 3종 — 정직한 표현)

| 사용자 | 상태 | 진입점 |
|---|---|---|
| **사람 (개발자 1인)** | ✅ 안정 — CLI/Dashboard/API | 직접 |
| **단일 에이전트** | ⚠️ MCP가 표준 (Python adapter는 사람/스크립트 보조) | MCP :8766 |
| **멀티 에이전트 (MCP 다중)** | ⚠️ **experimental** — 동시 쓰기 충돌 보호 없음 (locks/queue/review 미구현) | MCP |

> 멀티 에이전트 write는 **scope 명시 + 동시성은 사용자 책임**. "안정 지원"이라고 표현하지 않음.

---

## 왜 만들었나 (vs Obsidian)

| Obsidian | raven |
|---|---|
| vault = 사용자가 폴더 지정 ✅ | 동일 ✅ |
| GUI만 있음 | **CLI + HTTP API + Dashboard + MCP 4개 진입점** |
| 사람이 1차 사용자 | **사람 1차, 에이전트 옵션** (LLM Wiki +α로 켤 수 있음) |
| 플러그인 = UI 확장 | **에이전트 = vault 옵션 시민** (scope/provenance 강제는 opt-in) |
| 단일 앱 | **multi-vault, multi-user 가능 (단, ACL은 non-goal)** |

**대체하지 않는 범위** (정직):
- Obsidian의 모바일 UX, sync 서비스, 플러그인 생태계 → 비목표
- 단일 사용자 가정 (auth 없음, 127.0.0.1 기본 바인딩) → 명시
- 대규모 팀 (Notion/Confluence 영역) → Anti-persona

사용자 인용 (2026-06-25):
> "옵시디언 안 사고, 모티브만 빌려서 내가 직접 만들 거야"
> "안정적이고, 심플한걸로 기준. 도전적인건 지양"

→ Obsidian의 **사용성 + 안정성**을 닮되, **에이전트 협업 + 프로그래머블 진입점**을 1급 시민으로 추가.

---

## 빠른 시작 (이미 셋업된 로컬)

```bash
# 0. 환경
cd ~/Desktop/Dev/Project/Raven
source scripts/.venv/bin/activate   # venv

# 1. vault 확인
raven where                       # 현재 설정 + vault 목록

# 2. (선택) 새 vault 만들기
raven vault create personal ~/Raven/personal
raven vault use personal

# 3. 빌드 (DB + lint)
raven build

# 4. GUI 띄우기 (다른 터미널)
python -m raven.api               # → http://127.0.0.1:8765
cd dashboard && npm run dev         # → http://localhost:5173

# 5. CLI로 페이지 작업
raven page new content/hello --title "Hello" --type concept --tags "demo"
raven page ls
raven page get content/hello
raven link check
raven export                      # GUI 정적 JSON 재생성
```

### Plain vault creation

`raven vault create <name> <path>` creates only `content/` and the vault metadata required for Raven to register the folder. It never adds `_meta/`, `log.md`, onboarding pages, agent instructions, or Git state. Existing vault files are never removed or migrated automatically.

---

## 로컬 스택 운영 (v0.7.55+: Docker deprecated, 기본은 local host stack)

Raven은 `raven.sh`(API + Dashboard dev server를 PID로 관리)가 기본 운영 방식입니다. **Docker는 deprecated** — production에서 컨테이너가 필요한 경우에만 호환성 목적으로 남겨둡니다.

```bash
cd ~/Desktop/Dev/Project/Raven

# 시작 / 중지 / 재시작 / 상태 확인
make up            # = ./raven.sh start
make down          # = ./raven.sh stop
make restart       # = ./raven.sh restart (PID만 재시작)
make status        # = ./raven.sh status

# 토큰/CSS/의존성 변경 후 UI가 stale하게 갱신 안 될 때 (캐시 완전 초기화)
make restart-all   # = scripts/restart-all.sh — Vite pre-bundle / __pycache__ / pytest cache / 구 로그 전부 wipe 후 재시작
```

`make restart-all`은 `wiki.db`, `node_modules/`, `scripts/.venv/`, 사용자 vault 데이터는 건드리지 않습니다. `wiki.db`까지 지우고 bootstrap을 재생성하려면 `scripts/restart-all.sh --wipe-db`.

### Docker (deprecated, 호환성 유지용)

`docker-compose.yml` / `Dockerfile`은 저장소에 남아있지만 **신규 사용자는 사용하지 마세요**. production에서 컨테이너가 필요한 경우에만:

```bash
GIT_SHA=$(git rev-parse --short HEAD)
docker compose build --build-arg "GIT_SHA=$GIT_SHA" api mcp-http dashboard   # 서비스 explicit 나열 필수 (병렬 빌드 충돌 회피)
docker compose down && docker compose up -d
docker exec raven-api cat /app/.git_sha   # 이미지에 박힌 SHA 확인
```

Makefile 단축: `make docker-build`, `make docker-up`, `make docker-down`, `make docker-restart`.

---

## 데스크톱 앱 (Raven.app, macOS)

Tauri 셸 + 번들된 Python 인터프리터로 API/MCP Core를 관리하는 네이티브 macOS 앱. 소스: `desktop/src-tauri/` (Rust), 아키텍처 배경은 [`_meta/decisions/adr-2026-07-23-raven-desktop-runtime-architecture.md`](_meta/decisions/adr-2026-07-23-raven-desktop-runtime-architecture.md), 트레이 아이콘은 [`adr-2026-07-26-desktop-system-tray.md`](_meta/decisions/adr-2026-07-26-desktop-system-tray.md) 참고.

### 빌드 + 설치 (권장)

```bash
make desktop-install   # = scripts/install-desktop.sh
```

현재 체크아웃된 소스 그대로 빌드해서 `/Applications/Raven.app`에 설치합니다 (git clone/pull은 하지 않음 — 저장소 최신화는 직접 관리). 처음 실행 시 없는 빌드 도구는 자동으로 설치합니다:

- **cargo/rustc** 없으면 → `rustup`으로 stable 툴체인 설치
- **npm/node** 없으면 → Homebrew로 설치
- **Xcode Command Line Tools** 없으면 → 안내 후 중단 (`xcode-select --install`은 대화형이라 자동화 불가, 직접 실행 필요)

이후: 실행 중인 Raven 종료 → `make desktop-dmg` 빌드 → `/Applications/Raven.app` 교체.

### 개별 빌드 단계 (디버깅용)

```bash
make desktop-bundle    # 번들용 Python(python-build-standalone) 다운로드 + raven 소스 복사 → desktop/src-tauri/resources/
make desktop-build     # Dashboard 빌드 + cargo build --release
make desktop-dmg       # .app 조립 + 코드사인 + .dmg 생성 (desktop-build 포함)
make desktop-release   # .dmg를 현재 git tag의 GitHub Release에 업로드 (requires gh CLI)
```

`desktop-dmg` (`scripts/make-dmg.sh`)는 `.app` 조립 후 번들된 실행파일/`.dylib`/`.so`들을 ad-hoc 서명합니다 — macOS의 provenance 정책상 부모 앱과 자식 프로세스(번들된 python3) 모두 유효한 서명이 있어야 하기 때문입니다.

### 동작 방식 요약

- `desktop/src-tauri/src/core.rs`: 번들 모드에서는 `Contents/Resources/resources/python/bin/python3`를, 개발 모드에서는 `scripts/.venv/bin/python`을 찾아 `raven.desktop.runtime`을 자식 프로세스로 기동하고 stdout의 첫 JSON 라인(`{"host", "port", "mcp_port"}`)으로 준비 완료를 확인합니다.
- `desktop/src-tauri/src/lib.rs`: Python Core 기동은 `tauri::async_runtime::spawn`으로 `.setup()` 훅 밖에서 비동기 실행됩니다 — `.setup()` 안에서 실패를 `Err`로 반환하면 Tauri 내부가 복구 불가능한 패닉(FFI 경계라 unwind 불가 → SIGABRT)을 내기 때문에, 실패 시 여기서 직접 흡수해 `osascript` 네이티브 다이얼로그를 띄우고 종료합니다.
- 메뉴바 트레이 아이콘에서 Open Dashboard / Restart Backend / Quit 가능. 창 닫기(X)는 종료가 아니라 숨김 — 완전 종료는 트레이의 Quit만.

### 트러블슈팅

앱 실행 시 다이얼로그 없이 바로 죽는다면 (드물게, 서명/빌드가 깨진 경우) 터미널에서 직접 실행해 패닉 메시지를 확인하세요:

```bash
/Applications/Raven.app/Contents/MacOS/raven-desktop
```

`Python Core 시작 실패 (...): No such file or directory (os error 2)`가 뜨면 번들된 python3 바이너리 자체보다는 (이미 서명/경로 문제는 아님을 확인함) macOS 앱 launch 타이밍과 관련된 `posix_spawn` 실패일 가능성이 높습니다 — 위 `lib.rs`의 비동기 처리 덕분에 크래시 대신 다이얼로그로 안내됩니다.

---

## 환경 변수 (선택)

| 변수 | 기본 | 효과 |
|---|---|---|
| `WIKI_VAULTS_DIR` | `~/Raven` | vaults 루트 전체 변경 |
| `WIKI_VAULT` | (registry default) | active vault 일시 변경 |

```bash
# 예: 다른 위치 vault 사용
WIKI_VAULTS_DIR=~/Documents/vaults raven vault list
WIKI_VAULT=agent-output raven page ls
```

---

## 핵심 명령 (CLI — 6 top-level + 11 서브커맨드 그룹)

```bash
raven where                                 # 환경 표시
raven vault list                            # 등록된 vault 목록
raven vault use <name>                      # 기본 vault 전환
raven vault info [name]                     # 메타 + 통계
raven vault create <name> <path>            # 새 vault 생성 + 등록
raven vault register <name> <path>          # 기존 폴더를 vault로 등록
raven vault remove <name> --force           # 등록 해제 (파일은 유지)

raven page ls [--type T] [--tag T] [--vault N] [--json]
raven page get <slug> [--vault N]
raven page new <slug> --title T --type T --tags "a,b" [--vault N]
raven page delete <slug> [--vault N] [--force]

raven search <검색어> [--vault N] [--top-k N] [--json]   # FTS5 BM25 검색 (v0.7.66+)

raven link check [--vault N] [--json]       # broken/missing wikilink
raven build [--vault N] [--db PATH] [--lint]   # wiki.db 빌드
raven export [--vault N] [--out DIR]          # GUI 정적 JSON

raven garden [--vault N] [--stale] [--orphan]   # stale/orphan 문서 정리
raven ingest <source_path> [--vault N]          # 외부 소스 파일/디렉토리 ingest

raven meta sync [--vault N]                     # Lite bootstrap 문서 최신화

raven archive list|clean|restore [--vault N]    # 삭제된 페이지 조회/정리/복원

raven log list|show|append|rotate|status [--vault N]   # log.md 조회/회전 (사람 수동; 자동 append는 4개 진입점 모두 raven.core.log.append)

raven lint run|summary|check [--vault N]        # lint 22개 실행/요약/체크

raven migrate plan|apply|categories [--vault N] # 스키마/구조 마이그레이션 (dry-run 기본)

raven note decision|concept|lesson|journal|rule|issue|gate <slug> ...   # type별 새 노트 shortcut

raven collection sync|validate|add [--vault N]  # 컬렉션 동기화/검증/추가

raven curator run|stats <collection_id>         # collection 기반 큐레이션 (git diff change set)

raven docs list                                 # Tier 1 내부 문서 목록
raven docs show <topic>                         # Tier 1 문서 조회 (OPERATIONS.md 등)
```

---

## HTTP API (65 endpoints)

```bash
# vault 관리
GET    /api/vaults
GET    /api/vaults/{name}
POST   /api/vaults/{name}/select

# 페이지 CRUD
GET    /api/vaults/{name}/pages[?type=T&tag=T]
GET    /api/vaults/{name}/pages/{slug}
POST   /api/vaults/{name}/pages                  # body: {slug, title, content, type, tags}
PUT    /api/vaults/{name}/pages/{slug}           # body: {content, title?, type?, tags?}
DELETE /api/vaults/{name}/pages/{slug}           # → _archive/

# 쿼리
GET    /api/vaults/{name}/search?q=X&top_k=N
GET    /api/vaults/{name}/link-check[?slug=X]

# 엔진
POST   /api/vaults/{name}/build                  # wiki.db 재빌드 + lint
POST   /api/vaults/{name}/export                 # GUI 정적 JSON
```

전부 `{ok: true, ...}` 또는 `{ok: false, error: "..."}` 형식.

---

## 에이전트 인터페이스 (MCP, v0.7.83+ HTTP only)

> **포트 매트릭스 (v0.7.83+)**: API `8765` · MCP `8766` · Dashboard `5173`.
> 운영자가 `make restart-all` 또는 `./raven.sh restart`로 3개 자동 관리.
> MCP는 별도 띄울 필요 없음 — silent stale 방지 (AGENTS.md §9).

> **에이전트(LLM client) ↔ Raven = MCP 단일 표준**.
> Python adapter(`raven.agents`)는 v0.7.9+ 제거됨.
> v0.7.81+: **HTTP localhost 방식만** — 단일 흐름으로 단순화.

### 흐름 (1-2-3)

```bash
# 1단계: 운영자가 서버 띄우기 (1회)
python -m raven.mcp.cli --transport http --host 127.0.0.1 --port 8766 --mode read
```

```json
// 2단계: 외부 MCP 클라이언트에 URL 등록 (어떤 클라이언트든 동일)
{
  "mcpServers": {
    "raven": {
      "url": "http://localhost:8765/mcp"
    }
  }
}
```

```bash
# 3단계: 표준 흐름
# - tools/list → 23개 도구 schema 자동 discovery
# - wiki_search(vault="<basename>", query="...", top_k=10)
```

### 왜 HTTP only (v0.7.81+)

- **의존성 0**: 파이썬 경로 / raven 패키지 위치 / vault 디렉토리 — 클라이언트는 URL만 알면 됨
- **sandbox 우회**: 일부 MCP 클라이언트는 stdio spawn을 보안상 차단 — HTTP는 영향 없음
- **lifecycle 단순**: 서버 lifecycle은 운영자가 관리 (직접 띄우거나 launchd/systemd 등록)

### 권한 모드 3종 (서버 시작 시 argv로 고정)

- `read` (기본) — 6종 도구: wiki_search / get_page / lint / graph / log / stale_detect
- `write` — + wiki_update / ingest / archive
- `admin` (사람 운영자 전용) — + wiki_delete / rename

### vault 이름

다중 vault 지원 — `vault=<이름>` 인자 필수. 이름은 보통 *디렉토리 basename*과 동일
(예: `~/Raven/my-vault/` → `my-vault`). 모르면 vault 운영자에게 직접 요청.

### stdio 패턴 (보조, v0.7.81+ 권장 ❌)

일부 환경에서 stdio spawn이 강제되면 (드묾):

```json
{
  "mcpServers": {
    "raven": {
      "command": "python",
      "args": ["-m", "raven.mcp.cli", "--mode", "read"]
    }
  }
}
```

→ 클라이언트가 python/패키지 위치 의존. **HTTP 방식이 단순**하므로 가급적 권장하지 않음.

### 자세한 안내

- vault 진입 가이드 (외부 에이전트가 받는 문서): `_meta/agents/SCHEMA.md` (데이터 계약) + `_meta/agents/TOOLS.md` (도구 surface)
- 정책: AGENTS.md §5.5 "MCP = 에이전트 표준 프로토콜"
- 다이어그램: `_meta/diagrams/three-flows.png`

---

## vault 구조

```
~/Raven/
├── .registry.json              # vault 인덱스 (default + 목록)
└── <vault-name>/
    ├── .vault.json             # per-vault 메타 (name, path)
    ├── content/                # 사용자 마크다운 (Obsidian식 자유)
    │   ├── _template.md
    │   ├── llm-wiki.md
    │   └── projects/harumoa/_overview.md
    ├── _meta/                  # 시스템 문서 (SCHEMA, RULES, ...)
    ├── _archive/               # 삭제된 페이지 백업
    ├── wiki.db                 # SQLite (gitignore)
    └── wiki.db.backup          # 자동 백업
```

`.registry.json` 예시:
```json
{
  "version": 1,
  "default": "default",
  "vaults": {
    "default":      {"path": "/Users/jaekanglee/Raven/default",       "mode": "personal", "owner": "user"},
    "agent-output": {"path": "/Users/jaekanglee/Raven/agent-output",  "mode": "agent",    "owner": "hermes"}
  }
}
```

### Tier 1 ↔ Tier 2 경계

Raven은 vault 데이터에 들어가는 문서를 두 계층으로 나눕니다:

| Tier | 위치 | 접근 | 용도 |
|---|---|---|---|
| **Tier 1** (raven 패키지 내부) | `raven/agent/`, `raven-policy.md`, `OPERATIONS.md` | `raven docs show <topic>` | raven CLI/API 운영 매뉴얼 |
| **Tier 2** (사용자 vault) | `<vault>/_meta/agents/` | vault 직접 read | vault 데이터 운영 규칙 |

- `vault clone` 기본 = **content only** (Tier 1 leak 방지)
- Tier 2 Lite = **2종 고정** (`SCHEMA.md` / `TOOLS.md`) — `log.md`는 vault owner 선택
- Tier 1 ↔ Tier 2 혼동 시 `raven vault verify <name>`로 진단

---

## vault frontmatter 스키마

```yaml
---
title: 페이지 제목
type: concept | person | comparison | project | tool | rule | query | journal | issue
tags: [core-tag, custom-tag]
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [content/source-page]              # 인용한 페이지 (선택)
confidence: high | medium | low              # 신뢰도 (선택)
agents:                                      # 에이전트가 쓴 경우 (자동)
  - name: hermes-writer
    timestamp: 2026-06-25T13:12:35
    run_id: run-2026-06-25-001
    intent: 사용자 요청 정리
---
```

wikilink: `[[content/llm-wiki]]` (auto), `[[link]]!` (broken), `[[link]]?` (placeholder).

---

## GUI 사용

```
http://localhost:5173                     # vite dev server

좌측 헤더:
  📁 <vault>       ← vault picker (클릭 → 다른 vault 전환)
  🔍 검색          ← vault별 실시간 BM25
  🕸 Graph         ← vault 링크 그래프
  🔍 Search        ← 전체 검색

좌측 사이드바:
  📚 Wiki          ← 홈
  ➕ 새 페이지     ← 새 페이지 생성 (현재 vault에)
  트리             ← vault 페이지 계층

페이지 헤더:
  ✏️ 편집          ← textarea 편집 → raven API PUT
  🗑 삭제          ← slug 재입력 확인 → _archive로 백업
```

vault 전환 시 페이지 자동 새로고침. localStorage `raven:active_vault`에 저장.

---

## 빌드 / 검증

```bash
# Python 타입/린트
python -m py_compile raven/**/*.py
scripts/.venv/bin/python -c "from raven.cli import app; print('OK')"

# TypeScript
cd dashboard && npx tsc -b --noEmit
cd dashboard && npm run build     # PWA 자동 생성 (dist/sw.js)

# E2E
raven build && raven link check
```

---

## 파일 트리 (코드베이스)

```
~/Desktop/Dev/Project/Raven/         ← 이 저장소 (개발 코드)
├── raven/                          ← 핵심 패키지
│   ├── core/
│   │   ├── registry.py              ← vault 발견 (.registry.json + env)
│   │   ├── vault.py                 ← vault 핸들 (load/create/resolve_active)
│   │   ├── db.py                    ← wiki.db 빌드 wrapper
│   │   ├── lint.py                  ← lint runner
│   │   ├── export.py                ← GUI 정적 JSON
│   │   └── link.py                  ← wikilink 파싱/감사
│   ├── cli/
│   │   └── __main__.py              ← Typer 6 top-level + 11 서브커맨드 그룹
│   └── api/
│       ├── server.py                ← FastAPI app
│       ├── main.py                  ← uvicorn entry
│       └── __main__.py
├── dashboard/                        ← React 19 SPA
│   ├── src/
│   │   ├── components/              ← Sidebar, VaultPicker, EditButton, ...
│   │   ├── routes/                  ← PageView, SearchPage, GraphPage
│   │   └── lib/api.ts               ← fetch 헬퍼
│   └── public/api/                  ← (legacy) 정적 JSON
├── scripts/                          ← legacy 빌드/lint 스크립트 (subprocess로 호출됨)
│   ├── build_db.py
│   ├── lint.py
│   ├── export_static.py
│   └── backup_db.py
├── _meta/                            ← 시스템 문서 (이 프로젝트 자기 자신에 대한 wiki)
├── raven/mcp/                      ← MCP 서버 (v0.6.0+ namespace)
├── mcp/                              ← (deprecated, v0.6.0에서 raven/mcp/로 이동)
└── log.md                            ← 작업 로그
```

---

## 의존성

```
# Python (scripts/.venv)
typer              # CLI
fastapi            # API
uvicorn[standard]  # ASGI server
pydantic           # 데이터 모델
python-frontmatter # .md 파싱
watchfiles         # FS watcher (테스트 스위트 필수)
sqlite3 (stdlib)

# Node (dashboard/)
react@^19
react-router-dom@^7
@xyflow/react      # 그래프
minisearch         # (legacy) 클라이언트 BM25
zustand            # 상태관리
react-markdown + remark-gfm + remark-math + rehype-katex + rehype-highlight
mermaid            # 다이어그램
vite-plugin-pwa    # PWA
```

설치:
```bash
uv pip install --python scripts/.venv/bin/python typer fastapi 'uvicorn[standard]' pydantic python-frontmatter watchfiles
cd dashboard && npm install
```

---

## 결정 사항 (요약)

자세한 결정 내역은 `_meta/decisions-d1-d6.md` + 후속 결정(D7-D9 multi-vault).

| # | 결정 | 이유 |
|---|---|---|
| D1 | Obsidian-free, 자체 빌드 | 사용자 인용: "옵시디언 안 사고" |
| D2 | SQLite (단일 DB) | 단순, 충분, git 추적 불필요 |
| D3 | React SPA (정적 빌드) | PWA, 오프라인 |
| D4 | Tailscale 원격 | VPS 비용 절감 |
| D5 | wikilink 표준 `[[...]]` | Obsidian 호환 |
| D6 | SCHEMA v2.4 | type taxonomy + intent suffix |
| **D7** | **vault 분리 (코드 ≠ 데이터)** | **사용자 제약 A: "런타임 데이터를 개발 폴더에 두지 않음"** |
| **D8** | **multi-vault + 중앙 레지스트리** | **사용자 비전: 여러 vault 동시 운영** |
| **D9** | **에이전트 1급 시민 + scope** | **사용자 제약 B: "에이전트가 vault에 쓰고 관리"** |

---

## 관련 문서

- `AGENTS.md` — AI 에이전트 운영 규칙 (이 Raven 코드베이스를 다룰 때)
- `~/Raven/<vault>/_meta/agents/SCHEMA.md` — vault 데이터 계약 (Lite bootstrap 자동 복사)
- `~/Raven/<vault>/_meta/agents/TOOLS.md` — MCP 도구 surface (Lite bootstrap 자동 복사)
- `docs/vault-patterns.md` — **Karpathy LLM Wiki +α 가이드** (v0.7.0+) — raw/ log.md _meta/agents/ opt-in 패턴, 사용자 자유
- `_meta/decisions/adr-2026-06-30-llm-wiki-plus-alpha.md` — **+α 결정 ADR** (v0.7.0+)
- `_meta/changelog-v0.5*.md` — 변경 이력
- `_meta/decisions-d1-d6.md` + `decisions-d7-d9-multivault.md` — 결정 내역
- `_meta/SCHEMA-v0.2-multivault.md` — vault frontmatter 스키마
- `_meta/architecture-5layer.md` — 시스템 아키텍처
- `_meta/deployment.md` — VPS + Tailscale 배포
- `_meta/dr-runbook.md` — 재해 복구

---

## 진입점 추가 / 변경 의사결정

> **진입점(entry point) vs 클라이언트(client)** — 진입점은 `raven.core`의 write/read contract를 **직접** 호출하는 표면이다(CLI / HTTP API / Dashboard / MCP, 4개 고정). 데스크톱 앱(Tauri)과 모바일 앱(CMP)은 위 HTTP API를 **소비하는 클라이언트**이며 자체 contract 경로가 없으므로 진입점이 아니다. 즉 "5번째 진입점 금지"는 새 표면이 core를 직접 호출하기 시작할 때 걸리는 규칙이다.

진입점 구조 변경은 **큰 결정**. 다음 절차 따르세요:

1. **ADR 작성**: `_meta/decisions/adr-YYYY-MM-DD-<topic>.md`
2. **write contract 단일화 검증**: 모든 write가 `raven.core`의 같은 create/update/delete/log/rebuild contract를 타는지 확인
3. **테스트 추가**: 새 진입점의 회귀 가드
4. **README + AGENTS.md 동기화**
5. **사용자 승인** → 머지

→ 5번째 진입점 (Telegram, Slack 등) 추가 ❌ — 외부 오케스트레이터의 영역.

---

## 라이선스 / 상태

- v0.7.182 (모바일 저장이 PC 편집을 덮지 않게 precondition 전속 + 충돌 사용자 알림)
- v0.7.181 (모바일 보관소 전체 검색 + 대시보드 전역 탭 5칸 + 홈 작업대 전환)
- v0.7.180 (precondition 토큰 내용 해시화 + 테스트 baseline 전면 green)
- v0.7.179 (REST 관례 정리 + 에러 envelope 분류 + link 스캔 중복 제거)
- v0.7.178 (동시 편집 precondition + 열화 정직화 + 선언-실제 재정합)
- **전제 = 신뢰된 단일 사용자 네트워크(localhost 또는 본인 tailnet)**. auth/ACL은 여전히 non-goal이므로, 이 API에 도달할 수 있는 사람은 vault를 읽고 쓰고 지울 수 있다 — tailnet을 남과 공유하지 말 것.
- v0.7.175+ 데스크톱/원격 기본값은 `0.0.0.0` 바인딩 + Tailscale·사설망 CORS 허용이다 (`raven/desktop/runtime.py`). 실제 태세는 `GET /api/system/info`의 `bind_host` / `allow_all_cors`로 확인.
- 동시 편집은 precondition 토큰으로 lost update를 거부한다 (v0.7.178). 자동 merge는 non-goal.
- 멀티 에이전트 write는 **experimental** (scope 명시 + 동시성 사용자 책임)
- Not production-ready for multi-tenant (no auth, no ACL)

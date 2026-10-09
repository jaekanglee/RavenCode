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
| **CLI** (사람/자동화) | Typer 7 top-level commands + 12 subcommand groups | `raven/cli/` |
| **API** (HTTP) | FastAPI 70 endpoints | `raven/api/` |
| **GUI** (웹) | React 19 + Vite + PWA | `dashboard/` |
| **MCP** (LLM 표준) | MCPServer 25 tools + 4 resources | `raven/mcp/` |

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
make desktop-release   # 새 버전을 물어 범프·커밋·태그·푸시 → .dmg와 업데이트 파일을 GitHub Release에 업로드 (requires gh CLI)
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

## 핵심 명령 (CLI — 7 top-level + 12 서브커맨드 그룹)

```bash
raven where                                 # 환경 표시
raven vault list                            # 등록된 vault 목록
raven vault use <name>                      # 기본 vault 전환
raven vault info [name]                     # 메타 + 통계
raven vault create <name> <path>            # 새 vault 생성 + 등록
raven vault register <name> <path>          # 기존 폴더를 vault로 등록
raven vault remove <name> --force           # 등록 해제 (파일은 유지)
raven vault export [-o FILE] [--vault N]    # 모든 vault를 zip 한 파일로 백업
raven vault import-backup <FILE>            # 백업 가져오기 (다른 PC 복원, 이름 충돌 시 name-2)

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

raven lint run|summary|check [--vault N]        # lint 23개 실행/요약/체크

raven migrate plan|apply|categories [--vault N] # 스키마/구조 마이그레이션 (dry-run 기본)

raven note decision|concept|lesson|journal|rule|issue|gate <slug> ...   # type별 새 노트 shortcut

raven collection sync|validate|add [--vault N]  # 컬렉션 동기화/검증/추가

raven curator run|stats <collection_id>         # collection 기반 큐레이션 (git diff change set)

raven docs list                                 # Tier 1 내부 문서 목록
raven docs show <topic>                         # Tier 1 문서 조회 (OPERATIONS.md 등)

raven mcp token add|list|revoke <name>          # 원격(tailnet·내부망) MCP·Core API 접근 토큰 발급/목록/회수
```

---

## HTTP API (70 endpoints)

```bash
# vault 관리
GET    /api/vaults
GET    /api/vaults/{name}
POST   /api/vaults/{name}/select
POST   /api/backup/export                        # body: {dest_path, vaults?} — 전체 vault zip 백업 (loopback 전용)
POST   /api/backup/import                        # body: {src_path} — 백업 가져오기, 이름 충돌 시 name-2 (loopback 전용)

# 페이지 CRUD
GET    /api/vaults/{name}/pages[?type=T&tag=T]
GET    /api/vaults/{name}/pages/{slug}
GET    /api/vaults/{name}/pages/{slug}/export.md # 문서 .md 내보내기 (attachment)
POST   /api/vaults/{name}/pages                  # body: {slug, title, content, type, tags}
PUT    /api/vaults/{name}/pages/{slug}           # body: {content, title?, type?, tags?}
DELETE /api/vaults/{name}/pages/{slug}           # → _archive/

# 운영 지침 (_meta/policy/VAULT-POLICY.md, 사용자 소유)
GET    /api/vaults/{name}/policy                 # 없으면 content null + 빈 양식 template
PUT    /api/vaults/{name}/policy                 # body: {content, precondition?} — 본문 그대로 저장, 낡은 토큰은 409

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
# - tools/list → 25개 도구 schema 자동 discovery
# - wiki_search(vault="<basename>", query="...", top_k=10)
```

### 왜 HTTP only (v0.7.81+)

- **의존성 0**: 파이썬 경로 / raven 패키지 위치 / vault 디렉토리 — 클라이언트는 URL만 알면 됨
- **sandbox 우회**: 일부 MCP 클라이언트는 stdio spawn을 보안상 차단 — HTTP는 영향 없음
- **lifecycle 단순**: 서버 lifecycle은 운영자가 관리 (직접 띄우거나 launchd/systemd 등록)

### 원격 접근 — 토큰 (v0.7.182+, ⚠️ #26부터 tailnet도 토큰 필요)

MCP HTTP 리스너는 **같은 PC(loopback) 직접 연결만** 토큰 없이 받는다. tailnet을 포함한 다른 모든 출처는 vault owner가 발급한 Bearer 토큰이 있어야 한다. 데스크톱 앱(Raven.app), `./raven.sh start`, team launchd 인스턴스, Docker `mcp-http`가 모두 같은 게이트(`raven/mcp/auth.py::LanTokenAuth`)를 쓴다. 인증을 끄는 옵션은 없다.

| 출처 (소켓 주소) | 처리 |
|---|---|
| loopback `127.0.0.0/8`, `::1` | 토큰 없이 통과 |
| tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), 내부망, Docker 게이트웨이·CGNAT, 그 외 | `Authorization: Bearer <token>`이 맞아야 통과, 아니면 401 (`WWW-Authenticate: Bearer realm="raven-mcp"`). 발급된 토큰이 없으면 전부 401 |

`initialize`, `tools/list`, `tools/call`, GET 스트림, 세션 DELETE 모두 게이트를 먼저 지난다. 출처는 소켓 주소로 본다. X-Forwarded-For·Host·Origin을 위조해도 통과하지 못한다(Core API와 같은 프록시 정책). stdio 전송은 네트워크 리스너가 아니라 해당하지 않는다.

```bash
raven mcp token add 민수-노트북    # 토큰은 지금 한 번만 출력 (파일엔 해시만)
raven mcp token list
raven mcp token revoke 민수-노트북 # 재시작 없이 즉시 401
# Docker: docker compose exec api python -m raven.cli mcp token add <이름>
```

**클라이언트에 토큰 넣기**: URL로 붙는 클라이언트는 헤더 설정에 넣는다. 토큰을 URL·쿼리스트링에 넣지 않는다.

```json
{ "mcpServers": { "raven": {
  "type": "http",
  "url": "http://<호스트 tailnet 또는 내부망 IP>:8766/mcp",
  "headers": { "Authorization": "Bearer rvn_..." }
} } }
```

```bash
# Claude Code
claude mcp add --transport http raven http://<호스트>:8766/mcp --header "Authorization: Bearer rvn_..."
```

- **⚠️ Breaking change (#26)**: 이전에는 tailnet 기기, team 인스턴스(`0.0.0.0:8767`), Docker `mcp-http`, `./raven.sh start` MCP를 비-loopback 주소로 연 경우 토큰 없이 붙을 수 있었다. 이제는 모두 401이다. 호스트 PC에서 사람이나 기기마다 토큰을 발급해 위 설정에 넣는다. 같은 PC의 에이전트(`http://127.0.0.1:8766/mcp`)는 바꿀 것이 없다.
- **증상과 복구**: 클라이언트가 연결 실패를 보고한다. MCP Python SDK 2.x는 401을 상태 코드 없이 `initialize` 실패(`MCPError -32603 "Server returned an error response"`)로 보여준다. `curl -i -X POST http://<호스트>:8766/mcp`가 `401`과 `WWW-Authenticate: Bearer realm="raven-mcp"`를 주면 토큰이 없거나 틀린 것이다. `raven mcp token list`로 이름을 확인하고, 잃어버렸으면 `revoke` 후 다시 `add`한다. 헤더를 넣은 뒤 다시 연결하면 된다(서버 재시작 불필요).
- 데스크톱 앱은 API가 `0.0.0.0`일 때 MCP도 `0.0.0.0`에 바인딩한다. 좁히려면 `RAVEN_MCP_HOST=<주소>`를 쓰고, 끄려면 `RAVEN_DESKTOP_MCP=0`, 읽기 전용으로 두려면 `RAVEN_DESKTOP_MCP_MODE=read`를 쓴다. Core API도 같은 판정과 같은 토큰을 쓴다(아래 "라이선스 / 상태"의 Core API 접근 게이트).
- 평문 HTTP라 같은 망에서 트래픽을 엿보면 토큰이 보인다(tailnet 구간은 WireGuard로 암호화된다). 신뢰할 수 있는 망에서만 쓰고, 유출이 의심되면 revoke한다.
- 근거: [`_meta/decisions/adr-2026-10-09-mcp-remote-token.md`](_meta/decisions/adr-2026-10-09-mcp-remote-token.md) (ADR 2026-09-30을 대체)

### 권한 모드 3종 (서버 시작 시 argv로 고정)

- `read` (기본) — 7종 도구: wiki_search / get_page / lint / graph / log / stale_detect / get_policy
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
│   │   └── __main__.py              ← Typer 7 top-level + 12 서브커맨드 그룹
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
- **⚠️ Breaking change (Issue #24) — tailnet도 토큰 필요**: Core API는 이제 **같은 PC(loopback) 직접 연결만** 토큰 없이 받는다. tailnet을 포함한 다른 모든 출처는 Bearer 토큰이 필요하다. MCP도 #26부터 같은 정책이다(아래 "MCP"). 결정: [`_meta/decisions/adr-2026-10-08-core-api-tailnet-token.md`](_meta/decisions/adr-2026-10-08-core-api-tailnet-token.md).
  - **토큰 발급** (API가 도는 PC에서): `raven mcp token add <이름>` — 평문은 한 번만 출력된다. Docker는 `docker compose exec api python -m raven.cli mcp token add <이름>`.
  - **마이그레이션**: 대시보드 멀티호스트는 호스트 추가 화면의 **접근 토큰** 칸에 입력하거나, 401이 뜨면 열리는 토큰 입력창에 넣는다(창을 닫으면 지워짐 — sessionStorage). 모바일 앱은 설정의 API Key에, 스크립트·MCP 외 HTTP 클라이언트는 `Authorization: Bearer <token>` 헤더에 넣는다. API가 직접 서빙하는 대시보드(`http://<tailnet-IP>:8765/`)는 원격 브라우저로 열리지 않는다(HTML부터 401, 의도된 변경이고 인증 예외 없음). 대신 다음 중 하나를 쓴다.
    - **데스크톱 앱 멀티호스트**: 사이드바 호스트 선택 → 호스트 추가 → `http://<tailnet-IP>:8765`와 토큰 입력
    - **Docker 대시보드**: `http://<호스트>:5173` 로그인 화면에 토큰을 한 번 입력
    - **vite 개발 대시보드** (`./raven.sh start`, 개발용): `http://<호스트>:5173`에서 401이 뜨면 토큰 입력창에 넣는다
  - **진단**: 응답이 `401`이고 `WWW-Authenticate: Bearer realm="raven"`이면 토큰이 없거나 틀린 것이다 — `raven mcp token list`로 이름을 확인하고, 잃어버렸으면 `revoke` 후 다시 `add`. `curl -H "Authorization: Bearer <token>" http://<host>:8765/api/vaults`로 확인한다. 대시보드는 거절된 저장 토큰을 지우고 다시 묻는다. 브라우저가 저장을 거부하면(사생활 보호 모드 등) 성공으로 표시하지 않는다.
  - **대시보드 토큰 경계**: 저장된 토큰은 `/api/*` 요청에만, 요청이 실제로 가는 origin(스킴·호스트·포트가 정확히 같은 곳)의 것만 붙는다. `fetch(Request)`도 같다. 자동으로 붙인 토큰이 실린 요청은 **redirect를 따라가지 않는다**(`redirect: "error"`) — Core API는 `/api` 응답에서 redirect하지 않으므로, redirect가 오면 연결 오류로 보인다. 엔드포인트를 HTTPS로 redirect하는 프록시 뒤에 두었다면 호스트 주소를 처음부터 `https://`로 넣는다. Docker 대시보드에서 세션의 토큰이 폐기되면 토큰 입력창이 아니라 로그인 화면으로 돌아간다.
  - **MCP**: #26부터 MCP HTTP도 loopback만 토큰 없이 받는다. 데스크톱 앱, `./raven.sh start`, team 인스턴스, Docker `mcp-http` 모두 같다. #24 시점에는 데스크톱 원격 모드에서 tailnet 기기가 토큰 없이 MCP `wiki_delete`를 호출할 수 있었고, standalone `raven.mcp.cli`에는 게이트가 없었다. 설정 방법은 위 "에이전트 인터페이스 (MCP) → 원격 접근 — 토큰"에 있다.
- **Core API 접근 게이트 (Issue #14)** — 게이트는 실행기가 아니라 앱(`raven.api.app`)에 붙어 있어, 데스크톱 앱 · `python -m raven.api` · `uvicorn raven.api:app` 어느 경로든 판정이 같다 (`raven/core/access.py`, MCP와 같은 구현):
  - loopback 출처 → 통과. tailnet 출처 → **토큰 필수** (Core API #24, MCP #26). 아래 라우트 판정은 코드에 남아 있지만, 어느 게이트도 이 판정으로 토큰을 면제하지 않는다 — 판정 내용: 주소가 `100.64.0.0/10`·`fd7a:115c:a1e0::/48` 안에 있고, 그 주소로 가는 응답이 이 기기의 Tailscale 주소(`tailscale ip`)에서 나가야 한다. 대역 소속만으로는 신뢰하지 않는다 — CGNAT은 통신사 LAN·다른 VPN·Docker 망도 쓴다. Tailscale CLI/daemon이 없거나(Docker 컨테이너 포함) 라우트가 다른 인터페이스로 나가면 토큰이 필요하다. 본인 tailnet = 신뢰 네트워크라는 위 전제를 따른다 — **이렇게 판정된 tailnet 기기는 vault를 읽고 쓰고 지울 수 있다.** 이 판정은 요청 시점의 송신 라우트를 보는 추론이다. 수락된 연결의 WireGuard 인증을 직접 증명하지 않으며, 비대칭·정책 라우팅 등 라우팅을 바꿀 수 있는 쪽에는 맞지 않는다 — Core API는 #24, MCP는 #26으로 이 신뢰를 걷어냈다.
  - 그 외 출처(LAN, Docker 게이트웨이 등) → `raven mcp token add`로 발급한 `Authorization: Bearer <token>` 필수. 발급 0개면 전부 401. health 등 예외 경로 없음.
  - 출처는 소켓 주소로 판단한다. Host/Origin은 보지 않는다. 프록시 헤더(X-Forwarded-For/Forwarded/X-Real-IP)가 붙은 요청은 `uvicorn raven.api:app` 직접 실행에서는 출처 신뢰를 받지 못하고(토큰 필수 — `--forwarded-allow-ips '*'`여도 사칭 불가), Raven 실행기(`python -m raven.api`, 데스크톱)에서는 이 기기의 프록시(예: vite `xfwd`)가 붙인 X-Forwarded-For만 해석한다. **이 기기에서 도는 프록시가 X-Forwarded-For 없이 API를 LAN에 중계하면, 그 요청은 직접 loopback 접속과 구분할 수 없어 인증 없이 통과한다** — 지원하는 프록시(대시보드 vite `xfwd: true`, Docker `spa_server`, 문서의 Caddy → dashboard)는 모두 XFF를 붙이거나 자체 로그인을 요구한다. 그 밖의 프록시(socat, nginx 기본 설정 등)로 API를 노출하는 구성은 공식 지원하지 않는다 — loopback 프로세스 신뢰와 함께 승인된 잔여 위험이다.
- **bind** — 기본은 loopback. 비루프백·와일드카드는 `RAVEN_ALLOW_REMOTE=1`(또는 `--host tailscale`)일 때만. opt-in 없이 `python -m raven.api --host 0.0.0.0` / `RAVEN_HOST=0.0.0.0`을 주면 **exit 2로 거부**, 데스크톱 앱은 창이 안 뜨는 일이 없게 loopback으로 낮춘다. 우선순위는 `--host` > `RAVEN_HOST`. Docker `api` 서비스는 compose가 `RAVEN_ALLOW_REMOTE=1`을 명시해 컨테이너 안 `0.0.0.0`에 바인딩한다. 컨테이너에서는 호스트·dashboard·같은 망의 다른 컨테이너가 모두 bridge IP로 보이므로 **Docker 대역은 신뢰하지 않고 전부 토큰을 요구**한다 — `docker compose exec api python -m raven.cli mcp token add <이름>`으로 발급하고, 브라우저는 dashboard(`:5173`)의 로그인 화면에 한 번 입력한다. 쿠키에는 API 토큰이 아니라 메모리 세션 id만 담긴다(HttpOnly·SameSite=Strict, 로그아웃·토큰 revoke·재시작 시 즉시 무효, 쿠키로 인증된 쓰기 요청은 같은 Origin만). TLS 뒤에 두면 `RAVEN_DASHBOARD_SECURE_COOKIE=1`로 Secure를 붙인다 — 평문 HTTP로 tailnet 밖에 열면 세션 쿠키가 노출된다. 실제 태세는 `GET /api/system/info`의 `bind_host`로 확인.
- 동시 편집은 precondition 토큰으로 lost update를 거부한다 (v0.7.178). 자동 merge는 non-goal.
- 멀티 에이전트 write는 **experimental** (scope 명시 + 동시성 사용자 책임)
- Not production-ready for multi-tenant (no auth, no ACL)

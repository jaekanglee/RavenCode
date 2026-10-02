---
title: Raven Agent Tools — 인터페이스 사용법
created: 2026-06-30
updated: 2026-06-30
type: rule
tags: [system, meta, raven, agent, tools, mcp]
audience: agent
confidence: high
---

# Raven Agent Tools — 인터페이스 사용법

> Raven Vault를 조작하는 에이전트(LLM Client)의 표준 인터페이스 및 Scope 규칙.
> **에이전트는 반드시 MCP(Model Context Protocol) 툴을 통해서만 Vault를 조작해야 합니다.**

---

## 1. 인터페이스 정의 (에이전트 단일 표준)

| 인터페이스 | 형태 | 상태 | 용도 |
|---|---|---|---|
| **MCP** | JSON-RPC (stdio/http) | ✅ **표준 (Canonical)** | 당신(에이전트)이 Vault를 조작할 때 사용하는 유일한 수단 |
| **CLI** | shell subprocess | ⚠️ 보조 | 사람이 수동 검증하거나 디버깅 시점에만 사용 |
| **HTTP API** | FastAPI (:8765) | ❌ 에이전트 사용 금지 | Dashboard 프론트엔드 전용 |
| **Python (raven.agents)** | in-process | ❌ **제거됨 (v0.7.9+)** | 사용 금지 (MCP로 통합) |

→ **에이전트는 오직 MCP 툴 호출만 사용해야 하며, 파일 시스템 직접 쓰기나 HTTP API 직접 호출은 금지됩니다.**

---

## 2. 9대 핵심 MCP 툴 규격

Raven MCP 서버는 권한 모드(`--mode read/write/admin`)에 따라 아래 툴들을 제공합니다.

### 2.1 Read 툴 (기본 제공)
* **`wiki_search(query: str, top_k: int = 10)`**: Vault 내 페이지를 FTS5 BM25로 전체 검색합니다.
* **`wiki_get_page(slug: str)`**: 특정 페이지의 내용, frontmatter, backlinks, outbound links, 그리고 `precondition`(현재 파일 상태 토큰)을 조회합니다. 이 문서를 고쳐 쓸 계획이면 이 토큰을 `wiki_update`에 되돌려 보내세요 — 그 사이 남이 저장했으면 write가 거부됩니다(lost update 방지).
* **`wiki_lint()`**: 현재 active vault의 14가지 린트 오류 및 이슈 목록을 반환합니다.
* **`wiki_graph(project: Optional[str] = None)`**: Vault 내 페이지 간 링크 그래프 데이터를 반환합니다.
* **`wiki_log(tail_n: int = 20, action: str = None, contains: str = None)`**: `log.md` 파일의 최근 N개 이력을 구조화된 JSON으로 반환합니다. `action`(예: `update`)·`contains`(부분 문자열, 예: `gardening:`)를 주면 log.md 전체에서 항목 단위로 걸러 최근 N개 항목을 돌려줍니다.
* **`wiki_get_policy()`**: vault 소유자가 쓴 운영 지침(`_meta/policy/VAULT-POLICY.md`) 원문을 반환합니다. vault를 큐레이션하기 전에 읽고 따르세요. 소유자가 아직 쓰지 않았으면 `content`가 `null`이며, 그때는 사용자의 명시적 지시만 수행합니다.

### 2.2 Write 툴 (MCP `--mode write` 이상 활성화 시 제공)
* **`wiki_update(slug: str, content: str, frontmatter: Optional[dict] = None, actor: Optional[str] = None, idempotency_key: Optional[str] = None, precondition: Optional[str] = None)`**
  * 마크다운 페이지를 생성하거나 덮어씁니다.
  * `frontmatter`를 지정해 YAML 메타데이터를 함께 기록할 수 있습니다.
  * M4/F1 규약에 따라 `actor`와 `idempotency_key`를 포함해야 안전한 재시도가 가능합니다.
* **`wiki_ingest(source: str, project: Optional[str] = None, mode: str = "auto", actor: Optional[str] = None, idempotency_key: Optional[str] = None)`**
  * 외부 원시 문서를 읽어 `<vault>/raw/<project>/` 하위로 가져옵니다.
* **`wiki_gardening_record(summary: str, deferred: Optional[list[str]] = None, proposed: Optional[list[str]] = None, actor: Optional[str] = None)`**
  * 가드닝 회차 결과를 `log.md`에 `gardening` 항목 하나로 남깁니다. 변경이 없던 회차도 기록해 다음 회차가 이어받게 합니다.
  * `deferred`·`proposed`는 `"<slug> — <사유>"` 한 줄씩. 줄바꿈이 든 값은 거부됩니다. 지난 기록은 `wiki_log(action="gardening")`으로 찾습니다.
  * 에이전트가 `log.md`에 쓰는 유일한 경로이며, 형식이 고정된 항목만 씁니다.

### 2.3 Admin 툴 (MCP `--mode admin` 활성화 시 제공)
* **`wiki_delete(slug: str, actor: Optional[str] = None, idempotency_key: Optional[str] = None)`**: 페이지를 `_archive/` 폴더로 아카이브(삭제) 처리합니다.
* **`wiki_rename(old_slug: str, new_slug: str, actor: Optional[str] = None, idempotency_key: Optional[str] = None)`**: 페이지 슬러그를 변경하고 인바운드 위키링크들을 일괄 업데이트합니다.

---

## 3. Scope 및 권한 규칙 (가장 중요)

* **MCP 권한 모드**: 에이전트는 자신에게 허용된 MCP 서버 권한 모드(`read`, `write`, `admin`)를 인지하고 작동해야 합니다. 쓰기 작업은 반드시 `--mode write` 이상일 때만 가능합니다.
* **Path Scope 가드**:
  * 에이전트의 쓰기는 `content/compiled/` 등 허용된 하위 경로로 샌드박싱될 수 있습니다.
  * `raw/**` 및 `_meta/system/**` 경로에 대한 무단 쓰기는 서버 수준에서 권한 거부(`PermissionError`) 처리됩니다.

### 절대 금지 패턴 (우회 금지)
* ❌ `open()`, `Path.write_text()` 등 Python 파일 조작 코드를 사용하여 직접 `.md` 파일 수정
* ❌ shell `echo "..." > content/foo.md` 등으로 직접 파일 쓰기
* ❌ `..` 이나 `~` 등을 포함하여 Vault 경계 밖의 파일(Path Traversal)을 조회하거나 조작하려 시도

---

## 4. MCP 결과 처리 및 보고 패턴

툴 호출 완료 후 에이전트는 사용자에게 다음 4가지 핵심 항목을 반드시 보고해야 합니다.

1. **무엇을 했는가 (wrote)**: 생성/수정된 마크다운 페이지의 슬러그 및 경로
2. **참조한 자료 (references)**: 작성을 위해 읽은 `raw/` 원시 소스나 다른 위키 페이지
3. **건너뛴 것 (skipped)**: 불필요하다고 판단되어 저장하지 않은 정보와 그 이유 (저장 신호 필터 4항목 위반 등)
4. **다음에 해야 할 작업 (next)**: 후속 에이전트나 사용자가 이어서 해야 할 권장 액션

---

## 5. 관련 문서

* [SCHEMA.md](SCHEMA.md) — 데이터 계약 (frontmatter / type / tag / wikilink)
* `_meta/system/SCHEMA.md` — 프론트매터 및 린트 규약 참조 (vault에 부착된 버전)

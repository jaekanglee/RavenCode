# 초안 검토 대기열 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** frontmatter `status: draft` 문서를 대시보드에서 알아보고(사이드바·홈·문서 배너) 운영자가 하나씩 또는 일괄로 승인(`current` + `draft` 태그 제거)할 수 있게 한다.

**Architecture:** 판정·쓰기는 `raven/core/review.py` 한 곳에 두고 기존 쓰기 계약(`contracts.write_page`)을 탄다. HTTP는 `raven/api/review_api.py`가 `guest_api`처럼 `install(app)`로 두 라우트를 등록하고, 두 라우트는 `guest_routes.ROUTES`에서 `owner`다. 대시보드는 트리 응답의 `status`로 사이드바를 그리고, 새 화면 `/review/:vault`와 문서 배너가 같은 승인 API를 쓴다.

**Tech Stack:** Python 3 / FastAPI / pytest, React + TypeScript / vitest + Testing Library

**Spec:** `docs/superpowers/specs/2026-10-20-draft-review-queue-design.md`

**커밋 규칙 (AGENTS.md §6):** 태스크마다 커밋하지 않는다. 모든 태스크와 검증이 끝난 뒤 사용자에게 "commit할까요?"로 확인하고, 승인되면 Task 9의 묶음대로 커밋한다.

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `raven/core/review.py` (신규) | `list_drafts(vault)`, `approve(vault, items)`. HTTP를 모른다. |
| `raven/api/review_api.py` (신규) | `install(app, vault_or_404)` — `GET /review`, `POST /review/approve`. 요청 검증(1~200건)만. |
| `raven/api/server.py` | `review_api.install` 호출, 트리 page 노드에 `status`. |
| `raven/api/guest_routes.py` | 새 라우트 둘 = `owner`. |
| `dashboard/src/types.ts` | `TreeNode.status?` |
| `dashboard/src/lib/api.ts` | `ReviewDraft`, `ApproveResult`, `fetchReviewQueue`, `approveDrafts` |
| `dashboard/src/lib/review.ts` (신규) | `isDraftStatus`, `countDrafts`, `summarizeApproval` |
| `dashboard/src/components/Sidebar.tsx` | 검토 대기 줄, 문서 점, 폴더 개수 |
| `dashboard/src/routes/ReviewPage.tsx` (신규) | 검토 대기 화면 |
| `dashboard/src/App.tsx` | `/review/:vault` |
| `dashboard/src/components/DraftReviewBanner.tsx` (신규) | 문서 상단 배너 + 승인 |
| `dashboard/src/routes/PageView.tsx` | `status` 파싱, 배너 |
| `dashboard/src/routes/HomePage.tsx` | 손볼 문서에 draft |
| `dashboard/src/styles/globals.css` | 점·개수·배너·목록 스타일 (기존 `--color-warning-*` 토큰) |
| `_meta/changelog-v0.7.183.md` | §12 추가 |

---

### Task 1: core — 초안 목록과 승인

**Files:**
- Create: `raven/core/review.py`
- Test: `tests/test_review.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/test_review.py`:

```python
"""초안 검토 대기열 core (spec 2026-10-20-draft-review-queue-design).

에이전트가 status: draft로 쓴 문서를 운영자가 승인한다. 승인은 status를 current로 바꾸고
tags에서 draft만 뺀다 — 본문과 나머지 frontmatter는 그대로여야 한다.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from raven.core import frontmatter
from raven.core.contracts import precondition_for_path
from raven.core.registry import VaultMeta
from raven.core.review import approve, list_drafts
from raven.core.vault import Vault

DRAFT_PAGE = """---
title: 결제 정산
type: concept
tags: [draft, concept, payment]
status: draft
created: 2026-07-08
updated: 2026-10-16
confidence: medium
agents:
  - name: codex
    timestamp: 2026-10-15T10:00:00
  - name: claude
    timestamp: 2026-10-16T16:52:54
---

# 결제 정산

> [BLUF] 배달 건별 결제 처리.

## 내용
본문 그대로.
"""


@pytest.fixture
def vault(tmp_path: Path) -> Vault:
    (tmp_path / "content").mkdir()
    meta = VaultMeta(name="test", path=tmp_path, mode="personal", owner="user")
    return Vault.load(meta)


def _write(vault: Vault, rel: str, text: str) -> Path:
    fp = vault.root / f"{rel}.md"
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(text, encoding="utf-8")
    return fp


def _page(title: str, status: str | None = None, updated: str = "2026-10-01", tags: str = "[concept]") -> str:
    lines = ["---", f"title: {title}", "type: concept", f"tags: {tags}"]
    if status:
        lines.append(f"status: {status}")
    lines += [f"updated: {updated}", "---", "", f"# {title}", ""]
    return "\n".join(lines)


# ─── 목록 ─────────────────────────────────────────────────────


def test_list_drafts_returns_only_status_draft(vault):
    _write(vault, "content/결제-정산", DRAFT_PAGE)
    _write(vault, "content/확정", _page("확정", status="current"))
    _write(vault, "content/상태없음", _page("상태없음"))
    _write(vault, "content/낡음", _page("낡음", status="stale"))
    _write(vault, "content/태그만", _page("태그만", tags="[draft]"))

    rows = list_drafts(vault)

    assert rows == [{
        "slug": "content/결제-정산",
        "title": "결제 정산",
        "type": "concept",
        "created": "2026-07-08",
        "updated": "2026-10-16",
        "last_agent": "claude",
    }]


def test_list_drafts_sorted_by_updated_desc_then_title(vault):
    _write(vault, "content/g", _page("Gamma", status="draft", updated="2026-10-01"))
    _write(vault, "content/b", _page("Beta", status="draft", updated="2026-10-05"))
    _write(vault, "content/a", _page("Alpha", status="draft", updated="2026-10-05"))

    assert [r["title"] for r in list_drafts(vault)] == ["Alpha", "Beta", "Gamma"]


def test_list_drafts_includes_nested_folders(vault):
    _write(vault, "content/issues/깊은-초안", _page("깊은 초안", status="draft"))

    assert [r["slug"] for r in list_drafts(vault)] == ["content/issues/깊은-초안"]


def test_last_agent_handles_string_entries_and_absence(vault):
    _write(vault, "content/s", _page("S", status="draft").replace("updated:", "agents: [hermes, claude]\nupdated:"))
    _write(vault, "content/n", _page("N", status="draft"))

    agents = {r["title"]: r["last_agent"] for r in list_drafts(vault)}
    assert agents == {"S": "claude", "N": None}


# ─── 승인 ─────────────────────────────────────────────────────


def test_approve_sets_current_and_drops_only_the_draft_tag(vault):
    fp = _write(vault, "content/결제-정산", DRAFT_PAGE)
    before_meta, before_body = frontmatter.parse(fp.read_text(encoding="utf-8"))

    assert approve(vault, [{"slug": "content/결제-정산"}]) == [
        {"slug": "content/결제-정산", "result": "approved"},
    ]

    meta, body = frontmatter.parse(fp.read_text(encoding="utf-8"))
    assert meta["status"] == "current"
    assert meta["tags"] == ["concept", "payment"]
    for key in ("title", "type", "created", "confidence"):
        assert meta[key] == before_meta[key]
    assert [a["name"] for a in meta["agents"]] == ["codex", "claude"]
    assert body == before_body


def test_approve_accepts_a_short_slug(vault):
    fp = _write(vault, "content/결제-정산", DRAFT_PAGE)

    assert approve(vault, [{"slug": "결제-정산"}])[0]["result"] == "approved"
    assert frontmatter.parse(fp.read_text(encoding="utf-8"))[0]["status"] == "current"


def test_approve_does_not_add_tags_when_page_had_none(vault):
    fp = _write(vault, "content/무태그", "---\ntitle: 무태그\ntype: concept\nstatus: draft\n---\n\n# 무태그\n")

    assert approve(vault, [{"slug": "content/무태그"}])[0]["result"] == "approved"
    assert "tags" not in frontmatter.parse(fp.read_text(encoding="utf-8"))[0]


def test_approve_skips_a_page_that_is_not_draft(vault):
    fp = _write(vault, "content/확정", _page("확정", status="current"))
    before = fp.read_bytes()

    assert approve(vault, [{"slug": "content/확정"}])[0]["result"] == "not_draft"
    assert fp.read_bytes() == before


@pytest.mark.parametrize("slug", ["content/없는-문서", "../../etc/passwd"])
def test_approve_reports_missing_or_invalid_slugs(vault, slug):
    assert approve(vault, [{"slug": slug}])[0]["result"] == "not_found"


def test_approve_rejects_a_stale_precondition(vault):
    fp = _write(vault, "content/결제-정산", DRAFT_PAGE)
    before = fp.read_bytes()

    result = approve(vault, [{"slug": "content/결제-정산", "precondition": "sha256-old"}])

    assert result[0]["result"] == "stale_precondition"
    assert fp.read_bytes() == before


def test_approve_accepts_the_current_precondition(vault):
    fp = _write(vault, "content/결제-정산", DRAFT_PAGE)

    result = approve(vault, [{"slug": "content/결제-정산", "precondition": precondition_for_path(fp)}])

    assert result[0]["result"] == "approved"


def test_approve_applies_the_rest_when_some_items_fail(vault):
    a = _write(vault, "content/a", _page("A", status="draft"))
    _write(vault, "content/b", _page("B", status="current"))
    c = _write(vault, "content/c", _page("C", status="draft"))

    results = approve(vault, [
        {"slug": "content/a"}, {"slug": "content/b"}, {"slug": "content/없음"}, {"slug": "content/c"},
    ])

    assert [r["result"] for r in results] == ["approved", "not_draft", "not_found", "approved"]
    for fp in (a, c):
        assert frontmatter.parse(fp.read_text(encoding="utf-8"))[0]["status"] == "current"


def test_approve_writes_a_log_record(vault):
    _write(vault, "content/결제-정산", DRAFT_PAGE)

    approve(vault, [{"slug": "content/결제-정산"}])

    log_text = (vault.root / "log.md").read_text(encoding="utf-8")
    assert "update | content/결제-정산" in log_text
    assert "검토 승인: draft → current" in log_text
```

- [ ] **Step 2: 실패 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_review.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'raven.core.review'`

- [ ] **Step 3: 구현**

`raven/core/review.py`:

```python
"""raven.core.review — 에이전트가 쓴 초안(status: draft)의 검토 대기열과 승인.

spec: docs/superpowers/specs/2026-10-20-draft-review-queue-design.md

승인은 status를 current로 바꾸고 tags에서 draft만 뺀다. 본문과 나머지 frontmatter는 그대로 두고,
쓰기는 contracts.write_page를 탄다. 누가 승인할 수 있는지(운영자 전용)는 API 게이트가 정한다.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

from raven.core import frontmatter as frontmatter_module
from raven.core import log as log_module
from raven.core import slug as slug_module
from raven.core.contracts import precondition_for_path, write_page
from raven.core.vault import Vault

DRAFT = "draft"
APPROVED = "approved"
NOT_FOUND = "not_found"
NOT_DRAFT = "not_draft"
STALE = "stale_precondition"
ERROR = "error"


def _status(meta: dict) -> str:
    value = meta.get("status")
    return value.strip() if isinstance(value, str) else ""


def _last_agent(meta: dict) -> Optional[str]:
    agents = meta.get("agents")
    if not isinstance(agents, list) or not agents:
        return None
    last = agents[-1]
    if isinstance(last, dict):
        name = last.get("name")
        return str(name) if name else None
    return str(last) if last else None


def _tags_without_draft(meta: dict) -> Optional[list[str]]:
    """draft를 뺀 tags. 원래 tags 키가 없으면 None (write_page가 그대로 둔다)."""
    if "tags" not in meta:
        return None
    raw = meta["tags"]
    if isinstance(raw, str):
        items = raw.split(",")
    elif isinstance(raw, (list, tuple)):
        items = list(raw)
    else:
        items = []
    return [t for t in (str(x).strip() for x in items) if t and t != DRAFT]


def list_drafts(vault: Vault) -> list[dict]:
    """content/ 아래 status: draft 문서. updated 내림차순, 같으면 제목순."""
    rows: list[dict] = []
    for fp in vault.content_root.rglob("*.md"):
        try:
            meta, _ = frontmatter_module.parse(fp.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if _status(meta) != DRAFT:
            continue
        slug = fp.relative_to(vault.root).as_posix()[:-3]
        rows.append({
            "slug": slug,
            "title": str(meta.get("title") or slug),
            "type": str(meta.get("type") or "?"),
            "created": str(meta.get("created") or ""),
            "updated": str(meta.get("updated") or ""),
            "last_agent": _last_agent(meta),
        })
    rows.sort(key=lambda r: r["title"])
    rows.sort(key=lambda r: r["updated"], reverse=True)
    return rows


def _resolve(vault: Vault, slug: str) -> Optional[Path]:
    try:
        safe = slug_module.validate(slug_module.normalize_prefix(slug), vault_root=vault.root)
    except slug_module.SlugError:
        return None
    fp = safe.with_suffix(".md")
    return fp if fp.is_file() else None


def _approve_one(vault: Vault, slug: str, precondition: Optional[str]) -> str:
    fp = _resolve(vault, slug)
    if fp is None:
        return NOT_FOUND
    # 읽는 시점의 토큰을 write_page에 넘겨, 읽기와 쓰기 사이에 바뀐 문서를 덮어쓰지 않는다.
    token = precondition_for_path(fp)
    if precondition is not None and precondition != token:
        return STALE
    meta, body = frontmatter_module.parse(fp.read_text(encoding="utf-8"))
    if _status(meta) != DRAFT:
        return NOT_DRAFT
    result = write_page(
        vault,
        slug,
        body,
        tags=_tags_without_draft(meta),
        extra_meta={"status": "current"},
        overwrite=True,
        enforce_protected_paths=True,
        append_log=False,
        precondition=token,
    )
    if not result.ok:
        return STALE if result.error == "stale_precondition" else ERROR
    try:
        log_module.append(
            vault,
            action="update",
            subject=result.slug,
            files=[result.slug],
            note="검토 승인: draft → current",
        )
    except Exception:
        pass  # write_page와 같이 로그는 best-effort
    return APPROVED


def approve(vault: Vault, items: Iterable[dict]) -> list[dict]:
    """items: [{"slug", "precondition"?}]. 건별로 처리하고 실패해도 나머지는 반영한다."""
    return [
        {"slug": item["slug"], "result": _approve_one(vault, item["slug"], item.get("precondition"))}
        for item in items
    ]
```

- [ ] **Step 4: 통과 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_review.py -q`
Expected: 14 passed

---

### Task 2: API — 두 라우트, 운영자 전용, 트리 status

**Files:**
- Create: `raven/api/review_api.py`
- Modify: `raven/api/server.py` (`_vault_or_404` 정의 바로 뒤, `_build_tree_node`의 page 노드)
- Modify: `raven/api/guest_routes.py` (ROUTES의 owner 묶음)
- Test: `tests/test_review_api.py`, `tests/test_guest_gate.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/test_review_api.py`:

```python
"""초안 검토 대기열 HTTP (spec 2026-10-20-draft-review-queue-design).

두 라우트는 운영자 전용이다. 트리 응답의 page 노드는 status를 싣는다(사이드바 표시용).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from raven.api.guest_routes import ROUTES
from raven.api.server import app
from raven.core import frontmatter
from raven.core.vault import Vault

DRAFT = "---\ntitle: 초안\ntype: concept\ntags: [draft, concept]\nstatus: draft\nupdated: 2026-10-16\n---\n\n# 초안\n\n본문\n"
CURRENT = "---\ntitle: 확정\ntype: concept\ntags: [concept]\nupdated: 2026-10-10\n---\n\n# 확정\n"


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vaults"
    root.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(root))
    v = Vault.create("alpha", root / "alpha")
    v.content_root.mkdir(parents=True, exist_ok=True)
    (v.content_root / "초안.md").write_text(DRAFT, encoding="utf-8")
    (v.content_root / "확정.md").write_text(CURRENT, encoding="utf-8")
    return v


@pytest.fixture
def client(vault):
    return TestClient(app)


def test_review_lists_only_drafts(client):
    r = client.get("/api/vaults/alpha/review")

    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["vault"] == "alpha"
    assert [d["slug"] for d in body["drafts"]] == ["content/초안"]
    assert body["drafts"][0]["last_agent"] is None


def test_approve_flips_status_and_empties_the_queue(client, vault):
    r = client.post("/api/vaults/alpha/review/approve", json={"items": [{"slug": "content/초안"}]})

    assert r.status_code == 200
    assert r.json() == {"ok": True, "results": [{"slug": "content/초안", "result": "approved"}]}
    meta, _ = frontmatter.parse((vault.content_root / "초안.md").read_text(encoding="utf-8"))
    assert meta["status"] == "current" and meta["tags"] == ["concept"]
    assert client.get("/api/vaults/alpha/review").json()["drafts"] == []


@pytest.mark.parametrize("count", [0, 201])
def test_approve_rejects_empty_or_oversized_requests(client, count):
    items = [{"slug": f"content/p{i}"} for i in range(count)]

    assert client.post("/api/vaults/alpha/review/approve", json={"items": items}).status_code == 400


def test_unknown_vault_is_404(client):
    assert client.get("/api/vaults/nope/review").status_code == 404
    assert client.post("/api/vaults/nope/review/approve", json={"items": [{"slug": "a"}]}).status_code == 404


def test_review_routes_are_owner_only():
    assert ROUTES[("GET", "/api/vaults/{name}/review")] == "owner"
    assert ROUTES[("POST", "/api/vaults/{name}/review/approve")] == "owner"


def test_tree_page_nodes_carry_status(client):
    tree = client.get("/api/vaults/alpha/tree").json()["tree"]
    status = {n["slug"]: n["status"] for n in tree["children"] if n["type"] == "page"}

    assert status["content/초안"] == "draft"
    assert status["content/확정"] == "current"
```

`tests/test_guest_gate.py` — `test_no_delete_route_is_open_to_guests` 바로 위에 추가:

```python
def test_guest_cannot_use_the_review_queue(root):
    g = _guest(_pair({"alpha": ["read", "create", "update"]}))

    assert g.get("/api/vaults/alpha/review").status_code == 403
    r = g.post("/api/vaults/alpha/review/approve", json={"items": [{"slug": "content/hello"}]})
    assert r.status_code == 403
```

- [ ] **Step 2: 실패 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_review_api.py tests/test_guest_gate.py -q`
Expected: FAIL — 라우트가 없어 404/KeyError, `test_tree_page_nodes_carry_status`는 `KeyError: 'status'`

- [ ] **Step 3: 구현**

`raven/api/review_api.py`:

```python
"""초안 검토 대기열 HTTP API (spec 2026-10-20-draft-review-queue-design).

두 라우트 모두 운영자 전용이다 — ``guest_routes.ROUTES``에서 ``owner``로 분류한다.
라우트는 ``install(app, vault_or_404)``이 앱에 직접 등록한다. ``guest_api``와 같은 이유로
``include_router``를 쓰지 않는다(묶음 라우트는 경로 템플릿을 게이트에 드러내지 않는다).
"""
from __future__ import annotations

from typing import Callable, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from raven.core import review
from raven.core.vault import Vault

MAX_ITEMS = 200


class ApproveItem(BaseModel):
    slug: str
    precondition: Optional[str] = None


class ApprovePayload(BaseModel):
    items: list[ApproveItem]


def install(app: FastAPI, vault_or_404: Callable[[str], Vault]) -> None:
    """SPA fallback(``GET /{full_path:path}``)보다 먼저 불러야 한다."""

    def review_queue(name: str):
        v = vault_or_404(name)
        return {"ok": True, "vault": name, "drafts": review.list_drafts(v)}

    def approve_drafts(name: str, payload: ApprovePayload):
        v = vault_or_404(name)
        if not payload.items or len(payload.items) > MAX_ITEMS:
            raise HTTPException(status_code=400, detail=f"items는 1~{MAX_ITEMS}건이어야 합니다")
        return {"ok": True, "results": review.approve(v, [i.model_dump() for i in payload.items])}

    app.add_api_route("/api/vaults/{name}/review", review_queue, methods=["GET"])
    app.add_api_route("/api/vaults/{name}/review/approve", approve_drafts, methods=["POST"])
```

`raven/api/server.py`:

1. import 줄 `from raven.api import guest_api, guest_routes`를 다음으로 바꾼다:

```python
from raven.api import guest_api, guest_routes, review_api
```

2. `def _vault_or_404(name: str) -> Vault:` 함수 정의가 끝난 바로 다음 줄에 추가:

```python


review_api.install(app, _vault_or_404)  # SPA fallback보다 먼저
```

3. `_build_tree_node`의 page 노드 dict에 `status`를 추가:

```python
                children.append({
                    "type": "page",
                    "path": slug,
                    "slug": slug,
                    "title": meta.get("title", slug),
                    "pageType": meta.get("type", "?"),
                    "status": normalize_status(meta.get("status")),
                })
```

`raven/api/guest_routes.py` — `("POST", f"{V}/drafts/generate"): "owner",  # LLM 비용` 줄 바로 아래에 추가:

```python
    ("GET", f"{V}/review"): "owner",            # 초안 검토 대기열 — 승인은 운영자 일
    ("POST", f"{V}/review/approve"): "owner",
```

- [ ] **Step 4: 통과 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_review_api.py tests/test_guest_gate.py tests/test_review.py -q`
Expected: 모두 PASS (`test_every_route_is_classified` 포함)

---

### Task 3: 대시보드 — API 클라이언트와 순수 함수

**Files:**
- Modify: `dashboard/src/types.ts` (`TreeNode`)
- Modify: `dashboard/src/lib/api.ts` (`commitDraft` 함수 근처, 파일 끝의 drafts 묶음 뒤)
- Create: `dashboard/src/lib/review.ts`
- Test: `dashboard/tests/review.lib.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`dashboard/tests/review.lib.test.ts`:

```ts
/* 초안 검토 대기열 순수 함수 (spec 2026-10-20-draft-review-queue-design). */
import { describe, expect, it } from "vitest";

import { countDrafts, isDraftStatus, summarizeApproval } from "../src/lib/review";
import type { TreeNode } from "../src/types";

const TREE: TreeNode = {
  type: "dir",
  path: "content",
  children: [
    { type: "page", path: "content/a", slug: "content/a", title: "A", pageType: "concept", status: "draft" },
    { type: "page", path: "content/b", slug: "content/b", title: "B", pageType: "concept", status: "current" },
    {
      type: "dir",
      path: "content/issues",
      children: [
        { type: "page", path: "content/issues/c", slug: "content/issues/c", title: "C", pageType: "issue", status: "draft" },
        { type: "dir", path: "content/issues/empty", children: [] },
      ],
    },
  ],
};

describe("isDraftStatus", () => {
  it("draft만 참이다", () => {
    expect(isDraftStatus("draft")).toBe(true);
    expect(isDraftStatus(" draft ")).toBe(true);
    expect(isDraftStatus("current")).toBe(false);
    expect(isDraftStatus(undefined)).toBe(false);
  });
});

describe("countDrafts", () => {
  it("중첩 폴더까지 draft 문서를 센다", () => {
    expect(countDrafts(TREE)).toBe(2);
    expect(countDrafts(TREE.children![2])).toBe(1);
  });

  it("트리가 없으면 0", () => {
    expect(countDrafts(null)).toBe(0);
  });
});

describe("summarizeApproval", () => {
  it("모두 승인되면 승인 수만 말한다", () => {
    expect(summarizeApproval([{ result: "approved" }, { result: "approved" }])).toBe("✅ 2건 승인");
  });

  it("건너뛴 이유를 종류별로 센다", () => {
    expect(
      summarizeApproval([
        { result: "approved" },
        { result: "not_draft" },
        { result: "not_draft" },
        { result: "stale_precondition" },
      ]),
    ).toBe("✅ 1건 승인 · 3건 건너뜀(이미 승인됨 2, 내용 변경됨 1)");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard && npx vitest run tests/review.lib.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/review"`

- [ ] **Step 3: 구현**

`dashboard/src/types.ts` — `TreeNode`의 `pageType?` 아래에 추가:

```ts
  /** page only — frontmatter status (없으면 "current"). 사이드바 초안 표시용. */
  status?: string;
```

`dashboard/src/lib/api.ts` — 파일 끝에 추가:

```ts
// ─── 초안 검토 대기열 (spec 2026-10-20-draft-review-queue-design) ───
// 운영자 전용 API. status: draft 문서를 모아 보고 승인한다(→ current, draft 태그 제거).

export interface ReviewDraft {
  slug: string;
  title: string;
  type: string;
  created: string;
  updated: string;
  last_agent: string | null;
}

export type ApproveResult = "approved" | "not_found" | "not_draft" | "stale_precondition" | "error";

export async function fetchReviewQueue(vault: string): Promise<ReviewDraft[]> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/review`);
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail;
    throw new Error(detail ? String(detail) : `review queue failed: ${r.status}`);
  }
  return (await r.json()).drafts || [];
}

export async function approveDrafts(
  vault: string,
  items: { slug: string; precondition?: string }[],
): Promise<{ slug: string; result: ApproveResult }[]> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/review/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail;
    throw new Error(detail ? String(detail) : `approve failed: ${r.status}`);
  }
  // 승인은 status·tags를 바꾼다 — 목록·트리 캐시를 문서 수정과 같은 범위로 무효화한다.
  invalidateCache(`pages:${vault}`);
  invalidateCache(`tree:${vault}`);
  return (await r.json()).results || [];
}
```

`dashboard/src/lib/review.ts`:

```ts
// 초안 검토 대기열 — 사이드바·검토 화면이 함께 쓰는 순수 함수
// (spec 2026-10-20-draft-review-queue-design).
import type { ApproveResult } from "./api";
import type { TreeNode } from "../types";

export function isDraftStatus(status: string | null | undefined): boolean {
  return (status ?? "").trim() === "draft";
}

/** 노드 아래(자신 포함)의 draft 문서 수. 트리가 없으면 0. */
export function countDrafts(node: TreeNode | null | undefined): number {
  if (!node) return 0;
  if (node.type === "page") return isDraftStatus(node.status) ? 1 : 0;
  return (node.children ?? []).reduce((n, child) => n + countDrafts(child), 0);
}

const SKIP_LABEL: Record<Exclude<ApproveResult, "approved">, string> = {
  not_draft: "이미 승인됨",
  stale_precondition: "내용 변경됨",
  not_found: "문서 없음",
  error: "쓰기 실패",
};

/** 일괄 승인 결과 한 줄. 예: "✅ 1건 승인 · 2건 건너뜀(이미 승인됨 2)" */
export function summarizeApproval(results: { result: ApproveResult }[]): string {
  const approved = results.filter((r) => r.result === "approved").length;
  const head = `✅ ${approved}건 승인`;
  const skipped = new Map<string, number>();
  for (const r of results) {
    if (r.result === "approved") continue;
    const label = SKIP_LABEL[r.result];
    skipped.set(label, (skipped.get(label) ?? 0) + 1);
  }
  if (skipped.size === 0) return head;
  const detail = [...skipped].map(([label, n]) => `${label} ${n}`).join(", ");
  return `${head} · ${results.length - approved}건 건너뜀(${detail})`;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd dashboard && npx vitest run tests/review.lib.test.ts`
Expected: 5 passed

---

### Task 4: 사이드바 — 검토 대기 줄, 문서 점, 폴더 개수

**Files:**
- Modify: `dashboard/src/components/Sidebar.tsx` (import, `VaultTreeGroup`, `TreeLeaf`, 새 `ReviewQueueRow`)
- Modify: `dashboard/src/styles/globals.css` (`.sidebar-tree-page-label` 블록 뒤)
- Test: `dashboard/tests/Sidebar.review-queue.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

`dashboard/tests/Sidebar.review-queue.test.tsx`:

```tsx
/* 사이드바 초안 표시 (spec 2026-10-20-draft-review-queue-design).
 *
 *  1) draft가 있으면 vault 섹션 맨 위에 "검토 대기 N" 줄이 생기고 /review/<vault>로 간다
 *  2) draft 문서 행에는 점, 폴더 행에는 하위 draft 개수
 *  3) draft가 없거나 손님 탭이면 검토 대기 줄이 없다
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import type { TreeNode } from "../src/types";

const guest = vi.hoisted(() => ({ on: false }));
vi.mock("../src/lib/guest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/guest")>()),
  isGuestTab: () => guest.on,
}));

import { Sidebar } from "../src/components/Sidebar";

const VAULTS = [{ name: "test", path: "/tmp/test", mode: "personal", owner: "user", default: true }];

const TREE: TreeNode = {
  type: "dir",
  path: "content",
  children: [
    {
      type: "dir",
      path: "content/issues",
      children: [
        { type: "page", path: "content/issues/a", slug: "content/issues/a", title: "A", pageType: "issue", status: "draft" },
        { type: "page", path: "content/issues/b", slug: "content/issues/b", title: "B", pageType: "issue", status: "draft" },
      ],
    },
    { type: "page", path: "content/c", slug: "content/c", title: "C", pageType: "concept", status: "draft" },
    { type: "page", path: "content/d", slug: "content/d", title: "D", pageType: "concept", status: "current" },
  ],
};

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderSidebar(tree: TreeNode) {
  localStorage.clear();
  render(
    <MemoryRouter>
      <Sidebar
        vaults={VAULTS}
        trees={{ test: tree }}
        activeVault="test"
        activeSlug={null}
        onSelectVault={() => {}}
        onRefresh={() => {}}
        open={true}
        onClose={() => {}}
        rawItems={{ test: [] }}
      />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  // vault 섹션은 접힌 채로 시작한다 — 펼친다.
  fireEvent.click(screen.getByText("test", { selector: ".sidebar-vault-name" }));
}

afterEach(() => {
  guest.on = false;
});

describe("사이드바 초안 표시", () => {
  it("검토 대기 줄이 개수를 보이고 검토 화면으로 간다", () => {
    renderSidebar(TREE);

    fireEvent.click(screen.getByRole("button", { name: "검토 대기 3건" }));

    expect(screen.getByTestId("where").textContent).toBe("/review/test");
  });

  it("draft 문서 행에 점, 그룹 행에 하위 draft 개수를 붙인다", () => {
    renderSidebar(TREE);

    // 사이드바는 문서를 type 그룹으로 묶는다(normalizeSidebarTree): issue 그룹에 A·B, concept 그룹에 C·D.
    expect(screen.getByRole("img", { name: "초안 2개" })).toBeTruthy();
    const concept = screen.getByRole("img", { name: "초안 1개" }).closest("button")!;
    expect(screen.queryAllByRole("img", { name: "검토 대기" })).toHaveLength(0); // 그룹은 접힌 채로 시작

    fireEvent.click(concept);

    expect(screen.getAllByRole("img", { name: "검토 대기" })).toHaveLength(1); // C만 draft
  });

  it("draft가 없으면 검토 대기 줄이 없다", () => {
    renderSidebar({ type: "dir", path: "content", children: [TREE.children![3]] });

    expect(screen.queryByRole("button", { name: /검토 대기/ })).toBeNull();
  });

  it("손님 탭에서는 검토 대기 줄을 숨긴다", () => {
    guest.on = true;
    renderSidebar(TREE);

    expect(screen.queryByRole("button", { name: /검토 대기/ })).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard && npx vitest run tests/Sidebar.review-queue.test.tsx`
Expected: FAIL — `Unable to find an accessible element with the role "button" and name "검토 대기 3건"`

- [ ] **Step 3: 구현**

`dashboard/src/components/Sidebar.tsx`:

1. import 추가 (기존 `import { useIsDrawerMobile } ...` 위):

```tsx
import { isGuestTab } from "../lib/guest";
import { countDrafts, isDraftStatus } from "../lib/review";
```

2. `VaultTreeGroup` 안, `const open = openFolders.has(VAULT_OPEN_KEY);` 바로 아래:

```tsx
  const draftCount = useMemo(() => countDrafts(tree), [tree]);
```

3. `VaultTreeGroup`의 반환 JSX에서 `{open && tree && (` 바로 앞에 추가:

```tsx
      {open && draftCount > 0 && !isGuestTab() && (
        <ReviewQueueRow vault={vault.name} count={draftCount} onClose={onClose} />
      )}
```

4. `function DraftSection(` 바로 앞에 새 컴포넌트 추가:

```tsx
// 초안 검토 대기열 진입점 (spec 2026-10-20-draft-review-queue-design).
// 개수는 트리 응답의 status에서 센다 — 추가 요청 없음. 손님 탭에서는 그리지 않는다(승인은 운영자 일).
function ReviewQueueRow({ vault, count, onClose }: { vault: string; count: number; onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="sidebar-tree-page-row"
      onClick={() => {
        navigate(`/review/${vault}`);
        onClose();
      }}
      style={{ paddingLeft: 18 }}
      aria-label={`검토 대기 ${count}건`}
      title="에이전트가 쓴 초안 중 승인을 기다리는 문서"
    >
      <span aria-hidden className="sidebar-draft-dot" />
      <span className="sidebar-tree-page-label">검토 대기</span>
      <span aria-hidden className="sidebar-draft-count">{count}</span>
    </button>
  );
}
```

5. `TreeLeaf`의 dir 분기: `<span className="sidebar-tree-dir-label">{displayTitle(node)}</span>` 바로 뒤에 추가 (dir 분기 안 `if (node.type === "dir") {` 다음 줄에 `const folderDrafts = countDrafts(node);` 선언):

```tsx
            {folderDrafts > 0 && (
              <span className="sidebar-draft-count" role="img" aria-label={`초안 ${folderDrafts}개`}>
                {folderDrafts}
              </span>
            )}
```

6. `TreeLeaf`의 page 행: `<span className="sidebar-tree-page-label">{displayTitle(node)}</span>` 바로 뒤에 추가:

```tsx
      {isDraftStatus(node.status) && (
        <span className="sidebar-draft-dot" role="img" aria-label="검토 대기" title="검토 대기 초안" />
      )}
```

`dashboard/src/styles/globals.css` — `.sidebar-tree-page-label { ... }` 블록 바로 뒤에 추가:

```css
/* 초안 검토 대기열 (spec 2026-10-20-draft-review-queue-design) — 경고 토큰이 라이트·다크를 맡는다 */
.sidebar-draft-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-warning-text);
}
.sidebar-draft-count {
  flex-shrink: 0;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
  border: 1px solid var(--color-warning-border);
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd dashboard && npx vitest run tests/Sidebar.review-queue.test.tsx tests/Sidebar.stats-widget.test.tsx tests/Sidebar.canonical-tree.test.ts`
Expected: 모두 PASS

---

### Task 5: 검토 대기 화면

**Files:**
- Create: `dashboard/src/routes/ReviewPage.tsx`
- Modify: `dashboard/src/App.tsx` (lazy import + `/vault/policy/:vault` 라우트 아래)
- Modify: `dashboard/src/styles/globals.css` (Task 4 블록 뒤)
- Test: `dashboard/tests/ReviewPage.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

`dashboard/tests/ReviewPage.test.tsx`:

```tsx
/* 초안 검토 대기 화면 (spec 2026-10-20-draft-review-queue-design).
 *
 *  1) 목록을 보이고, 고른 것만 precondition 없이 승인한다
 *  2) 승인 뒤 결과를 알리고 목록을 다시 불러온다
 *  3) 비면 빈 상태, 손님 탭이면 안내만 (API를 부르지 않는다)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const guest = vi.hoisted(() => ({ on: false }));
vi.mock("../src/lib/guest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/guest")>()),
  isGuestTab: () => guest.on,
}));

import { ReviewPage } from "../src/routes/ReviewPage";

type Reply = { status: number; body: unknown };

function stubFetch(replies: Reply[]) {
  const queue = [...replies];
  const spy = vi.fn().mockImplementation(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/review/v1"]}>
      <Routes>
        <Route path="/review/:vault" element={<ReviewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const A = { slug: "content/a", title: "결제 정산", type: "concept", created: "", updated: "2026-10-16", last_agent: "claude" };
const B = { slug: "content/b", title: "실시간 통신", type: "concept", created: "", updated: "2026-10-15", last_agent: null };

afterEach(() => {
  guest.on = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReviewPage", () => {
  it("고른 초안만 승인하고 결과를 알린 뒤 목록을 다시 불러온다", async () => {
    const spy = stubFetch([
      { status: 200, body: { ok: true, vault: "v1", drafts: [A, B] } },
      { status: 200, body: { ok: true, results: [{ slug: "content/a", result: "approved" }] } },
      { status: 200, body: { ok: true, vault: "v1", drafts: [B] } },
    ]);
    renderPage();

    expect(await screen.findByRole("heading", { name: "검토 대기 2" })).toBeTruthy();
    expect(screen.getByText("claude")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "결제 정산 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "선택 승인 (1)" }));

    expect(await screen.findByText("✅ 1건 승인")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("heading", { name: "검토 대기 1" })).toBeTruthy());
    const [url, init] = spy.mock.calls[1];
    expect(String(url)).toContain("/api/vaults/v1/review/approve");
    expect(JSON.parse(String(init?.body))).toEqual({ items: [{ slug: "content/a" }] });
  });

  it("전체 선택은 모든 초안을 고른다", async () => {
    stubFetch([{ status: 200, body: { ok: true, vault: "v1", drafts: [A, B] } }]);
    renderPage();

    fireEvent.click(await screen.findByRole("checkbox", { name: "전체 선택" }));

    expect(screen.getByRole("button", { name: "선택 승인 (2)" })).toBeTruthy();
  });

  it("아무것도 고르지 않으면 승인 버튼이 꺼져 있다", async () => {
    stubFetch([{ status: 200, body: { ok: true, vault: "v1", drafts: [A] } }]);
    renderPage();

    const button = (await screen.findByRole("button", { name: "선택 승인 (0)" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("초안이 없으면 빈 상태를 보인다", async () => {
    stubFetch([{ status: 200, body: { ok: true, vault: "v1", drafts: [] } }]);
    renderPage();

    expect(await screen.findByText("검토할 초안이 없습니다")).toBeTruthy();
  });

  it("손님 탭이면 안내만 보이고 API를 부르지 않는다", () => {
    guest.on = true;
    const spy = stubFetch([]);
    renderPage();

    expect(screen.getByText("검토와 승인은 운영자만 할 수 있습니다")).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard && npx vitest run tests/ReviewPage.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/routes/ReviewPage"`

- [ ] **Step 3: 구현**

`dashboard/src/routes/ReviewPage.tsx`:

```tsx
// 초안 검토 대기 화면 (spec 2026-10-20-draft-review-queue-design).
//
// status: draft 문서를 모아 보고 골라서 승인한다(→ current, draft 태그 제거).
// 일괄 승인은 precondition 없이 보낸다 — 본문을 보지 않고 승인하겠다는 운영자의 선택이다.
// 승인은 운영자 전용이라 손님 탭에서는 안내만 보이고 API를 부르지 않는다.
import { useEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";

import { typeLabel } from "../components/GraphCanvas";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { PageHeader } from "../components/ui/PageHeader";
import { Toast } from "../components/ui/Toast";
import { approveDrafts, fetchReviewQueue, formatApiError, type ReviewDraft } from "../lib/api";
import { isGuestTab } from "../lib/guest";
import { summarizeApproval } from "../lib/review";

export function ReviewPage() {
  const { vault = "" } = useParams();
  const ctx = useOutletContext<{ refresh?: () => void } | undefined>();
  const guest = isGuestTab();
  const [drafts, setDrafts] = useState<ReviewDraft[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const load = async () => {
    setError(null);
    try {
      setDrafts(await fetchReviewQueue(vault));
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  useEffect(() => {
    setDrafts(null);
    setSelected(new Set());
    if (!guest) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, guest]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (guest) {
    return (
      <EmptyState
        title="검토와 승인은 운영자만 할 수 있습니다"
        description="초안 문서는 사이드바에서 열어 볼 수 있습니다."
      />
    );
  }

  const allSelected = !!drafts && drafts.length > 0 && selected.size === drafts.length;

  const toggle = (slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected || !drafts ? new Set() : new Set(drafts.map((d) => d.slug)));
  };

  const approveSelected = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const results = await approveDrafts(vault, [...selected].map((slug) => ({ slug })));
      const anyApproved = results.some((r) => r.result === "approved");
      setToast({ message: summarizeApproval(results), type: anyApproved ? "success" : "error" });
      setSelected(new Set());
      ctx?.refresh?.();
      await load();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={drafts ? `검토 대기 ${drafts.length}` : "검토 대기"}
        contextLabel={`in ${vault}`}
        subtitle="에이전트가 status: draft로 쓴 문서입니다. 승인하면 current가 되고 draft 태그가 빠집니다."
        actions={
          <Button onClick={approveSelected} disabled={busy || selected.size === 0}>
            {`선택 승인 (${selected.size})`}
          </Button>
        }
      />
      {error && (
        <p role="alert" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      )}
      {drafts === null && !error && <p className="text-muted">불러오는 중…</p>}
      {drafts && drafts.length === 0 && (
        <EmptyState
          title="검토할 초안이 없습니다"
          description="에이전트가 status: draft로 쓴 문서가 여기에 모입니다."
        />
      )}
      {drafts && drafts.length > 0 && (
        <div className="review-list">
          <div className="review-row review-row-head">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="전체 선택" />
            <span>전체 선택</span>
          </div>
          {drafts.map((d) => (
            <div key={d.slug} className="review-row">
              <input
                type="checkbox"
                checked={selected.has(d.slug)}
                onChange={() => toggle(d.slug)}
                aria-label={`${d.title} 선택`}
              />
              <Link className="review-row-title" to={`/page/${vault}/${d.slug.replace(/^content\//, "")}`}>
                {d.title}
              </Link>
              <span className="sidebar-tree-page-pill" data-type={d.type}>
                {typeLabel(d.type) || d.type}
              </span>
              <span className="review-row-meta">{d.last_agent ?? "—"}</span>
              <span className="review-row-meta">{d.updated || "—"}</span>
            </div>
          ))}
        </div>
      )}
      <Toast open={!!toast} message={toast?.message ?? ""} type={toast?.type} />
    </div>
  );
}
```

`dashboard/src/App.tsx`:

1. `const VaultPolicyPage = lazyRoute(...)` 줄 아래에 추가:

```tsx
const ReviewPage = lazyRoute(() => import("./routes/ReviewPage").then((m) => ({ default: m.ReviewPage })));
```

2. `<Route path="/vault/policy/:vault" .../>` 줄 아래에 추가:

```tsx
              <Route path="/review/:vault" element={<RouteSlot><ReviewPage /></RouteSlot>} />
```

`dashboard/src/styles/globals.css` — Task 4 블록 뒤에 추가:

```css
.review-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-hairline);
  border-radius: var(--radius-md);
}
.review-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-top: 1px solid var(--color-hairline);
  font-size: 14px;
}
.review-row:first-child {
  border-top: none;
}
.review-row-head {
  grid-template-columns: 20px 1fr;
  font-size: 12px;
  color: var(--color-muted);
}
.review-row-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-ink);
}
.review-row-meta {
  font-size: 12px;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
@media (max-width: 744px) {
  .review-row {
    grid-template-columns: 20px minmax(0, 1fr) auto;
  }
  .review-row .review-row-meta {
    display: none;
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd dashboard && npx vitest run tests/ReviewPage.test.tsx tests/App.unknown-route.test.tsx`
Expected: 모두 PASS

---

### Task 6: 문서 상단 배너

**Files:**
- Create: `dashboard/src/components/DraftReviewBanner.tsx`
- Modify: `dashboard/src/routes/PageView.tsx` (import, `setPage`, 배너 삽입)
- Modify: `dashboard/src/styles/globals.css` (Task 5 블록 뒤)
- Test: `dashboard/tests/DraftReviewBanner.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

`dashboard/tests/DraftReviewBanner.test.tsx`:

```tsx
/* 문서 상단 초안 배너 (spec 2026-10-20-draft-review-queue-design).
 *
 *  1) 승인은 읽을 때 받은 precondition을 싣는다
 *  2) 승인되면 onApproved — 부모가 문서를 다시 불러온다
 *  3) 읽은 뒤 바뀌었으면 승인하지 않고 다시 확인하라고 말한다
 *  4) 운영자가 아니면 승인 버튼이 없다
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DraftReviewBanner } from "../src/components/DraftReviewBanner";

function stubFetch(body: unknown, status = 200) {
  const spy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DraftReviewBanner", () => {
  it("precondition을 실어 승인하고 onApproved를 부른다", async () => {
    const spy = stubFetch({ ok: true, results: [{ slug: "결제-정산", result: "approved" }] });
    const onApproved = vi.fn();
    render(<DraftReviewBanner vault="v1" slug="결제-정산" precondition="sha256-x" canApprove onApproved={onApproved} />);

    fireEvent.click(screen.getByRole("button", { name: "승인" }));

    await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/api/vaults/v1/review/approve");
    expect(JSON.parse(String(init?.body))).toEqual({ items: [{ slug: "결제-정산", precondition: "sha256-x" }] });
  });

  it("읽은 뒤 바뀌었으면 승인하지 않고 다시 확인하라고 말한다", async () => {
    stubFetch({ ok: true, results: [{ slug: "결제-정산", result: "stale_precondition" }] });
    const onApproved = vi.fn();
    render(<DraftReviewBanner vault="v1" slug="결제-정산" precondition="sha256-old" canApprove onApproved={onApproved} />);

    fireEvent.click(screen.getByRole("button", { name: "승인" }));

    expect(await screen.findByText(/읽은 뒤 내용이 바뀌었습니다/)).toBeTruthy();
    expect(onApproved).not.toHaveBeenCalled();
  });

  it("운영자가 아니면 안내만 있고 승인 버튼이 없다", () => {
    render(<DraftReviewBanner vault="v1" slug="결제-정산" canApprove={false} onApproved={() => {}} />);

    expect(screen.getByText("에이전트가 쓴 초안입니다 · 검토 대기")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "승인" })).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard && npx vitest run tests/DraftReviewBanner.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/components/DraftReviewBanner"`

- [ ] **Step 3: 구현**

`dashboard/src/components/DraftReviewBanner.tsx`:

```tsx
// 문서 상단 초안 배너 (spec 2026-10-20-draft-review-queue-design).
//
// status: draft 문서에서만 붙는다. 승인은 운영자만 — 읽을 때 받은 precondition을 실어 보내
// 그 뒤 에이전트가 내용을 바꿨으면 승인하지 않고 다시 확인하라고 알린다.
import { useState } from "react";

import { Button } from "./ui/Button";
import { approveDrafts, formatApiError, type ApproveResult } from "../lib/api";

const FAILURE_MESSAGE: Record<Exclude<ApproveResult, "approved">, string> = {
  stale_precondition: "읽은 뒤 내용이 바뀌었습니다. 새로고침해서 다시 확인한 뒤 승인하세요.",
  not_draft: "이미 승인된 문서입니다. 새로고침하세요.",
  not_found: "문서를 찾을 수 없습니다.",
  error: "승인하지 못했습니다. 잠시 뒤 다시 시도하세요.",
};

interface DraftReviewBannerProps {
  vault: string;
  slug: string;
  precondition?: string;
  canApprove: boolean;
  onApproved: () => void;
}

export function DraftReviewBanner({ vault, slug, precondition, canApprove, onApproved }: DraftReviewBannerProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const approve = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const [r] = await approveDrafts(vault, [{ slug, precondition }]);
      const result = r?.result ?? "error";
      if (result === "approved") {
        onApproved();
        return;
      }
      setMessage(FAILURE_MESSAGE[result]);
    } catch (e) {
      setMessage(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="draft-review-banner">
      <span className="draft-review-banner-text">에이전트가 쓴 초안입니다 · 검토 대기</span>
      {message && (
        <span className="draft-review-banner-message" role="alert">
          {message}
        </span>
      )}
      {canApprove && (
        <Button size="sm" onClick={approve} disabled={busy}>
          승인
        </Button>
      )}
    </div>
  );
}
```

`dashboard/src/routes/PageView.tsx`:

1. import 추가 (`import { PropertiesPanel } ...` 아래):

```tsx
import { DraftReviewBanner } from "../components/DraftReviewBanner";
import { isDraftStatus } from "../lib/review";
```

2. `setPage({ ... })` 안 `issueStatus: fm.issue_status || "",` 위에 추가:

```tsx
          status: fm.status || "",
```

3. `{/* Properties Panel — type/tags 편집 + 문서 연결 */}` 주석 바로 앞(= `isDraft` 배너 블록 `)}` 다음)에 추가:

```tsx
        {/* status: draft 배너 — 에이전트가 쓴 초안의 검토·승인 (spec 2026-10-20) */}
        {isDraftStatus(page.status) && (
          <DraftReviewBanner
            vault={vault}
            slug={page.slug}
            precondition={page.precondition}
            canApprove={guestMe === null}
            onApproved={() => {
              setReloadKey((k) => k + 1);
              ctx?.refresh?.();
            }}
          />
        )}
```

`dashboard/src/styles/globals.css` — Task 5 블록 뒤에 추가:

```css
.draft-review-banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 16px;
  margin-bottom: 16px;
  border-radius: var(--radius-md);
  background: var(--color-warning-bg);
  border: 1px solid var(--color-warning-border);
  color: var(--color-warning-text);
  font-size: 13px;
}
.draft-review-banner-text {
  flex: 1;
  font-weight: 600;
}
.draft-review-banner-message {
  font-size: 12px;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd dashboard && npx vitest run tests/DraftReviewBanner.test.tsx tests/PageView.vault-sot.test.tsx tests/PageView.graph-scope.test.tsx`
Expected: 모두 PASS

---

### Task 7: 홈 "손볼 문서"에 draft

**Files:**
- Modify: `dashboard/src/routes/HomePage.tsx` (`pickUnfinishedPages`, emptyText)
- Test: `dashboard/tests/HomePage.workbench.test.tsx`

- [ ] **Step 1: 테스트 수정 (실패하게)**

`PAGES`에 한 줄 추가 (`{ slug: "e", ... }` 위):

```ts
  { slug: "f", title: "F", status: "draft", updated: "2026-02-01" },
```

기존 테스트를 바꾼다:

```ts
  it("손볼 문서는 stale·contested·draft를 담고 archived는 제외한다", () => {
    expect(pickUnfinishedPages(PAGES).map((p) => p.slug)).toEqual(["b", "c", "f"]);
  });
```

(`pickRecentPages(PAGES, 3)`은 그대로 `["d", "b", "c"]` — f는 c보다 오래됐다.)

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard && npx vitest run tests/HomePage.workbench.test.tsx`
Expected: FAIL — `expected [ 'b', 'c' ] to deeply equal [ 'b', 'c', 'f' ]`

- [ ] **Step 3: 구현**

`dashboard/src/routes/HomePage.tsx`:

```ts
// 사람이 손봐야 하는 status: stale·contested(사실 재확인)와 draft(승인 대기). archived는 넣지 않는다.
export function pickUnfinishedPages<T extends HomePageSummary>(pages: T[], limit = 6): T[] {
  return pickRecentPages(
    pages.filter((p) => p.status === "stale" || p.status === "contested" || p.status === "draft"),
    limit,
  );
}
```

"손볼 문서" `PageQueue`의 emptyText:

```tsx
              emptyText={pagesLoading ? "불러오는 중…" : "stale·contested·draft 문서가 없습니다."}
```

- [ ] **Step 4: 통과 확인**

Run: `cd dashboard && npx vitest run tests/HomePage.workbench.test.tsx`
Expected: PASS

---

### Task 8: 전체 검증과 실제 동작 확인

- [ ] **Step 1: 백엔드 전체**

Run: `scripts/.venv/bin/python -m pytest tests/ -q`
Expected: 전부 PASS. `tests/test_v0_7_178_doc_count_guards.py`가 README의 API 개수를 런타임과 비교하므로, README 두 곳(`FastAPI N endpoints`, `## HTTP API (N endpoints)`)을 78 → 80으로 고치고 HTTP API 목록에 `# 초안 검토` 두 줄을 추가한다.

- [ ] **Step 2: 대시보드 전체 + 타입**

Run: `cd dashboard && npx vitest run` 그리고 `make typecheck`
Expected: 전부 PASS, 타입 오류 0

- [ ] **Step 3: 임시 vault로 API 왕복 확인 (사용자 vault는 건드리지 않는다)**

스크래치 디렉터리에 `WIKI_VAULTS_DIR`를 두고 vault를 만든 뒤, status: draft 문서 하나를 넣고 API를 띄워 `GET /review` → `POST /review/approve` → 파일 frontmatter와 `log.md`를 확인한다. 데스크톱 앱이 8765를 쓰고 있으면 다른 포트를 쓴다.

- [ ] **Step 4: 대시보드 화면 확인**

같은 임시 vault로 `npm run dev`를 띄워 사이드바 "검토 대기 N", 문서 점·폴더 개수, `/review/<vault>` 선택 승인, 문서 배너 승인을 확인한다. 브라우저 자동화가 없으면 사용자에게 확인을 요청한다.

---

### Task 9: changelog와 커밋 (사용자 승인 후)

- [ ] **Step 1: changelog**

`_meta/changelog-v0.7.183.md`의 `## 12. 다음`을 `## 13. 다음`으로 바꾸고, 그 앞에 `## 12. 초안 검토 대기열` 섹션을 추가한다(배경 한 문단, 변경 bullet, 검증 결과 숫자). `## 13. 다음`에 범위 밖 후보(stale·contested 헤더 경고, issue draft 7일 자동 승격 불일치, 정본 SCHEMA status 표, CLI `raven review`)를 더한다.

- [ ] **Step 2: 사용자에게 "commit할까요?" 확인**

- [ ] **Step 3: 승인되면 커밋 (세 묶음)**

```bash
git add raven/core/review.py raven/api/review_api.py raven/api/server.py raven/api/guest_routes.py tests/test_review.py tests/test_review_api.py tests/test_guest_gate.py README.md
git commit -m "feat(api): operator-only review queue and approval for status: draft pages"

git add dashboard/src dashboard/tests
git commit -m "feat(dashboard): show drafts in the sidebar, review queue screen, and page approve banner"

git add _meta/changelog-v0.7.183.md docs/superpowers/specs/2026-10-20-draft-review-queue-design.md docs/superpowers/plans/2026-10-20-draft-review-queue.md
git commit -m "docs: changelog and plan for the draft review queue"
```

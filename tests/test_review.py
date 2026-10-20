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

"""Tests for related page recommendation system (Phase 6)."""
from __future__ import annotations

from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from raven.api.server import app
from raven.core.vault import Vault
from raven.core.recommend import get_recommendations
from raven.core import db as db_module


@pytest.fixture
def isolated_vault(tmp_path: Path, monkeypatch):
    reg_root = tmp_path / "registry"
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(reg_root))
    vault = Vault.create("rec-test", tmp_path / "vault")
    content_dir = vault.root / "content"
    content_dir.mkdir(parents=True, exist_ok=True)
    return vault


@pytest.fixture
def client():
    return TestClient(app)


def test_recommendation_logic(isolated_vault: Vault) -> None:
    content_dir = isolated_vault.root / "content"

    # Target page A
    (content_dir / "page-a.md").write_text(
        "---\ntitle: Page A\ntype: concept\ntags: [tag1, tag2]\n---\nTarget A\n", encoding="utf-8"
    )
    # Rec candidate B (Co-cited by Y and Y2)
    (content_dir / "page-b.md").write_text(
        "---\ntitle: Page B\ntype: concept\ntags: []\n---\nTarget B\n", encoding="utf-8"
    )
    # Rec candidate C (Tag overlap = 2)
    (content_dir / "page-c.md").write_text(
        "---\ntitle: Page C\ntype: concept\ntags: [tag1, tag2, tag3]\n---\nTarget C\n", encoding="utf-8"
    )
    # Rec candidate D (Tag overlap = 1)
    (content_dir / "page-d.md").write_text(
        "---\ntitle: Page D\ntype: concept\ntags: [tag1]\n---\nTarget D\n", encoding="utf-8"
    )
    # Rec candidate E (Rejected - should be filtered out)
    (content_dir / "page-e.md").write_text(
        "---\ntitle: Page E\ntype: concept\nstatus: rejected\ntags: [tag1, tag2]\n---\nTarget E\n", encoding="utf-8"
    )

    # Source page Y linking to A and B
    (content_dir / "page-y.md").write_text(
        """---
title: Page Y
type: concept
relations:
  - type: uses
    target: page-a
    evidence:
      - test fixture
    reason: Page Y uses Page A in this recommendation fixture.
  - type: depends_on
    target: page-b
    evidence:
      - test fixture
    reason: Page Y depends on Page B in this recommendation fixture.
---
Y content
""", encoding="utf-8"
    )

    # Source page Y2 linking to A and B
    (content_dir / "page-y2.md").write_text(
        """---
title: Page Y2
type: concept
relations:
  - type: implements
    target: page-a
    evidence:
      - test fixture
    reason: Page Y2 implements Page A in this recommendation fixture.
  - type: uses
    target: page-b
    evidence:
      - test fixture
    reason: Page Y2 uses Page B in this recommendation fixture.
---
Y2 content
""", encoding="utf-8"
    )

    # Build DB
    db_module.build_db(isolated_vault, run_lint=False)

    # Test Recommendation function directly
    recs = get_recommendations(isolated_vault, "content/page-a", top_k=5)

    # Page B: co_citation = 2, tag_overlap = 0. Score = 2 * 2.0 = 4.0
    # Page C: co_citation = 0, tag_overlap = 2. Score = 2 * 1.0 = 2.0
    # Page D: co_citation = 0, tag_overlap = 1. Score = 1 * 1.0 = 1.0
    # Page E (rejected): excluded.
    assert len(recs) == 3
    assert recs[0]["slug"] == "content/page-b"
    assert recs[0]["score"] == 4.0
    assert recs[0]["co_citation_score"] == 2
    assert recs[0]["tag_overlap_score"] == 0
    assert isinstance(recs[0]["importance"], float)
    assert isinstance(recs[0]["centrality"], float)

    assert recs[1]["slug"] == "content/page-c"
    assert recs[1]["score"] == 2.0
    assert recs[1]["co_citation_score"] == 0
    assert recs[1]["tag_overlap_score"] == 2

    assert recs[2]["slug"] == "content/page-d"
    assert recs[2]["score"] == 1.0
    assert recs[2]["co_citation_score"] == 0
    assert recs[2]["tag_overlap_score"] == 1


def test_recommendation_api(client, isolated_vault: Vault) -> None:
    content_dir = isolated_vault.root / "content"
    (content_dir / "page-a.md").write_text(
        "---\ntitle: Page A\ntype: concept\ntags: [tag1]\n---\nTarget A\n", encoding="utf-8"
    )
    (content_dir / "page-b.md").write_text(
        "---\ntitle: Page B\ntype: concept\ntags: [tag1]\n---\nTarget B\n", encoding="utf-8"
    )

    db_module.build_db(isolated_vault, run_lint=False)

    resp = client.get("/api/vaults/rec-test/pages/content/page-a/recommendations")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["ok"] is True
    assert len(data["recommendations"]) == 1
    assert data["recommendations"][0]["slug"] == "content/page-b"
    assert data["recommendations"][0]["score"] == 1.0
    assert data["recommendations"][0]["tag_overlap_score"] == 1
    assert isinstance(data["recommendations"][0]["importance"], float)
    assert isinstance(data["recommendations"][0]["centrality"], float)


def test_recommendations_build_missing_db_without_lint(isolated_vault: Vault, monkeypatch) -> None:
    """DB가 없을 때 추천 경로가 lint 포함 빌드를 돌리고 결과를 버리지 않는다."""
    from raven.core import lint as lint_module

    calls: list[str] = []
    monkeypatch.setattr(lint_module, "run_all", lambda v: calls.append(v.meta.name) or {})
    if isolated_vault.db_path.exists():
        isolated_vault.db_path.unlink()

    get_recommendations(isolated_vault, "content/any", top_k=3)

    assert calls == []

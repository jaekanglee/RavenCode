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

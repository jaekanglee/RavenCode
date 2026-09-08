"""Baseline contract tests for API endpoints that had no test coverage.

Each endpoint here was absent from every test until 2026-09-08. These pin the
happy path (200 + response shape) so a regression in any of them is caught by
the in-process suite instead of by a user in the desktop app.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from raven.api.server import app
from raven.core import db as db_module
from raven.core import log as log_module
from raven.core.registry import registry
from raven.core.vault import Vault


@pytest.fixture
def isolated_vault(tmp_path: Path, monkeypatch) -> Vault:
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "registry"))
    vault = Vault.create("uncovered-test", tmp_path / "vault")
    content = vault.root / "content"
    content.mkdir(parents=True, exist_ok=True)
    (content / "linked.md").write_text(
        "---\ntitle: Linked Page\ntype: concept\ntags: [a]\n---\n"
        "Points to [[content/orphan]] and to [[content/does-not-exist]].\n",
        encoding="utf-8",
    )
    (content / "orphan.md").write_text(
        "---\ntitle: Orphan Page\ntype: concept\ntags: [b]\n"
        "created: 2020-01-01\nupdated: 2020-01-01\n---\nNobody links here.\n",
        encoding="utf-8",
    )
    db_module.build_db(vault, run_lint=False)
    return vault


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_stats_counts_pages_and_broken_links(client, isolated_vault):
    resp = client.get(f"/api/vaults/{isolated_vault.meta.name}/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    on_disk = len(list((isolated_vault.root / "content").rglob("*.md")))
    assert data["pages"] == on_disk >= 2  # includes build_db's auto index pages
    assert data["size_bytes"] > 0
    assert data["broken_links"] >= 1  # [[content/does-not-exist]]
    assert isinstance(data["log_entries"], int)


def test_link_check_reports_broken_target(client, isolated_vault):
    resp = client.get(f"/api/vaults/{isolated_vault.meta.name}/link-check")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert isinstance(data["broken"], list)
    assert isinstance(data["missing"], list)
    assert any("does-not-exist" in json.dumps(item) for item in data["broken"])


def test_garden_lists_orphan_pages(client, isolated_vault):
    resp = client.get(f"/api/vaults/{isolated_vault.meta.name}/garden")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    stale_slugs = {s["slug"] for s in data["stale"]}
    assert "content/orphan" in stale_slugs  # updated: 2020-01-01 → well past 90 days
    assert "content/linked" not in stale_slugs  # updated today by build_db
    for s in data["stale"]:
        assert s["age_days"] > 90
    assert isinstance(data["orphan"], list)
    for o in data["orphan"]:
        assert isinstance(o["link_candidates"], list)


def test_log_status_before_and_after_append(client, isolated_vault):
    name = isolated_vault.meta.name
    before = client.get(f"/api/vaults/{name}/log/status").json()
    assert before["ok"] is True
    assert isinstance(before["total_entries"], int)

    log_module.append(isolated_vault, action="create", subject="smoke entry for log/status")

    after = client.get(f"/api/vaults/{name}/log/status").json()
    assert after["exists"] is True
    assert after["total_entries"] == before["total_entries"] + 1
    assert after["last_entry"] is not None
    assert "smoke entry" in json.dumps(after["last_entry"], ensure_ascii=False)


def test_select_sets_registry_default_and_404s_unknown(client, isolated_vault):
    name = isolated_vault.meta.name
    resp = client.post(f"/api/vaults/{name}/select")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "active": name}
    assert registry().default().name == name

    missing = client.post("/api/vaults/no-such-vault/select")
    assert missing.status_code == 404


def test_graph_positions_roundtrip_and_reset(client, isolated_vault):
    name = isolated_vault.meta.name
    positions_file = isolated_vault.root / ".graph_positions.json"

    saved = client.post(
        f"/api/vaults/{name}/graph/positions",
        json={"positions": {"content/linked": {"x": 1.5, "y": -2.0}}},
    )
    assert saved.status_code == 200
    assert positions_file.exists()
    stored = json.loads(positions_file.read_text())["positions"]
    assert stored["content/linked"] == {"x": 1.5, "y": -2.0}

    # Merge semantics: a second POST keeps the first node.
    client.post(
        f"/api/vaults/{name}/graph/positions",
        json={"positions": {"content/orphan": {"x": 0.0, "y": 0.0}}},
    )
    stored = json.loads(positions_file.read_text())["positions"]
    assert set(stored) == {"content/linked", "content/orphan"}

    reset = client.delete(f"/api/vaults/{name}/graph/positions")
    assert reset.status_code == 200
    assert not positions_file.exists() or json.loads(positions_file.read_text())["positions"] == {}


def test_export_writes_static_json_to_out_dir(client, isolated_vault, tmp_path):
    out_dir = tmp_path / "export-out"
    resp = client.post(
        f"/api/vaults/{isolated_vault.meta.name}/export",
        params={"out_dir": str(out_dir)},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True, data["export"].get("stderr_tail")
    assert data["export"]["out_dir"] == str(out_dir)
    assert any(out_dir.glob("*.json")), "export produced no JSON files"

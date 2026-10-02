"""그래프 API와 DB 빌더는 외부 `python-frontmatter` 없이 동작해야 한다.

데스크톱 v0.3.1 번들에 이 패키지가 빠져 있어 GET /graph가 500, 앱의 wiki.db
재빌드가 매번 실패했다. 두 경로는 repo의 `raven.core.frontmatter`로 충분하다.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from raven.api.server import app
from raven.core import db as db_module
from raven.core.vault import Vault


def _shadow_dir(tmp_path: Path) -> Path:
    """import하면 ImportError를 내는 가짜 `frontmatter` 패키지 — 번들 누락 상황 재현."""
    shadow = tmp_path / "shadow"
    (shadow / "frontmatter").mkdir(parents=True)
    (shadow / "frontmatter" / "__init__.py").write_text(
        'raise ImportError("No module named \'frontmatter\'")\n', encoding="utf-8"
    )
    return shadow


@pytest.fixture
def isolated_env(monkeypatch):
    reg_root = Path(tempfile.mkdtemp(prefix="raven-fm-reg-"))
    target_root = Path(tempfile.mkdtemp(prefix="raven-fm-target-"))
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(reg_root))
    yield target_root
    shutil.rmtree(reg_root, ignore_errors=True)
    shutil.rmtree(target_root, ignore_errors=True)


def test_graph_api_works_without_python_frontmatter(isolated_env, tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "frontmatter", None)  # import frontmatter → ImportError
    client = TestClient(app)
    client.post("/api/vaults", json={"name": "fm1", "path": str(isolated_env / "fm1"), "bootstrap": False})
    client.post("/api/vaults/fm1/pages", json={"slug": "content/a", "title": "A", "body": "[[content/b]]"})
    client.post("/api/vaults/fm1/pages", json={"slug": "content/b", "title": "B"})

    resp = client.get("/api/vaults/fm1/graph")

    assert resp.status_code == 200, resp.text
    assert {n["slug"] for n in resp.json()["nodes"]} >= {"content/a", "content/b"}


def test_build_db_works_without_python_frontmatter(isolated_env, tmp_path, monkeypatch):
    shadow = _shadow_dir(tmp_path)
    monkeypatch.setenv("PYTHONPATH", os.pathsep.join([str(shadow), os.environ.get("PYTHONPATH", "")]))
    vault = Vault.create("fm2", isolated_env / "fm2")
    (vault.root / "content").mkdir(parents=True, exist_ok=True)
    (vault.root / "content" / "page.md").write_text(
        "---\ntitle: Page\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-02\ntags: [a, b]\n---\n\nbody\n",
        encoding="utf-8",
    )

    result = db_module.build_db(vault, run_lint=False)

    assert result["ok"] is True, result
    assert result["pages"] >= 1

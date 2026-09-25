"""wiki.db 증분 재빌드 — 기존 문서의 내용만 바뀌면 그 페이지만 다시 색인한다.

핵심 계약: 증분 결과는 같은 파일 상태로 처음부터 빌드한 DB와 같아야 한다 (parity).
링크 대상 보정(resolve_short_slug)은 slug 집합에만 의존하므로, 문서 추가·삭제·slug
변경이 없으면 다른 페이지의 링크 해석이 바뀌지 않는다. 그 전제가 깨지는 경우는
증분을 포기하고 전체 빌드로 돌아가야 한다.
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import time
from pathlib import Path

import pytest

from raven.core import db as db_module
from raven.core.vault import Vault

ROOT = Path(__file__).resolve().parents[1]


def _load_script():
    spec = importlib.util.spec_from_file_location("build_db_script", ROOT / "scripts" / "build_db.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


script = _load_script()


def _page(title: str, body: str, *, tags: str = "[]", relations: str = "") -> str:
    return (
        f"---\ntitle: {title}\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\n"
        f"tags: {tags}\n{relations}---\n\n{body}\n"
    )


def _touch_later(path: Path) -> None:
    future = time.time() + 5
    os.utime(path, (future, future))


def _dump(db_path: Path) -> dict:
    con = sqlite3.connect(db_path)
    try:
        def rows(sql: str) -> list:
            return sorted(tuple(r) for r in con.execute(sql).fetchall())

        return {
            "pages": rows(
                "SELECT slug, title, type, created, updated, path, confidence, contested, content,"
                " raw_content, collection, status, aliases, importance, centrality, community,"
                " layer, freshness FROM pages"
            ),
            "tags": rows("SELECT page_slug, tag FROM tags"),
            "links": rows("SELECT source_slug, target_slug, context, intent FROM links"),
            "relations": rows(
                "SELECT source_slug, target_slug, relation_type, confidence_semantic, evidence, reason"
                " FROM relations"
            ),
            "fts": {
                q: rows(f"SELECT slug FROM pages_fts WHERE pages_fts MATCH '{q}'")
                for q in ("alpha", "bravo", "charlie", "newtag", "edited")
            },
        }
    finally:
        con.close()


@pytest.fixture
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Vault:
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "registry"))
    v = Vault.create("incr", tmp_path / "vault")
    content = v.root / "content"
    content.mkdir(parents=True, exist_ok=True)
    (content / "a.md").write_text(
        _page(
            "Alpha",
            "alpha links [[b]] and [[content/c]].",
            tags="[one, two]",
            relations=(
                "relations:\n  - type: uses\n    target: c\n"
                "    evidence: [doc]\n    reason: alpha uses charlie\n"
            ),
        ),
        encoding="utf-8",
    )
    (content / "b.md").write_text(_page("Bravo", "bravo body [[a]]."), encoding="utf-8")
    (content / "c.md").write_text(_page("Charlie", "charlie body."), encoding="utf-8")
    (content / "nested").mkdir()
    (content / "nested" / "d.md").write_text(_page("Delta", "delta [[c]] [[missing]]."), encoding="utf-8")
    return v


def _full(vault: Vault, db_path: Path) -> None:
    script.build_db(vault.root, db_path)


def test_incremental_matches_full_build_after_content_edit(vault: Vault, tmp_path: Path):
    db = tmp_path / "incr.db"
    _full(vault, db)

    a = vault.root / "content" / "a.md"
    a.write_text(
        _page(
            "Alpha edited",
            "edited alpha now links [[nested/d]] and [[missing]] only.",
            tags="[two, newtag]",
            relations=(
                "relations:\n  - type: related\n    target: b\n"
                "    evidence: [doc2]\n    reason: alpha relates to bravo\n"
            ),
        ),
        encoding="utf-8",
    )
    _touch_later(a)

    assert script.update_db(vault.root, db) == 1

    fresh = tmp_path / "fresh.db"
    _full(vault, fresh)
    assert _dump(db) == _dump(fresh)


def test_incremental_is_noop_when_nothing_changed(vault: Vault, tmp_path: Path):
    db = tmp_path / "incr.db"
    _full(vault, db)
    before = _dump(db)
    assert script.update_db(vault.root, db) == 0
    assert _dump(db) == before


@pytest.mark.parametrize("change", ["add", "remove", "slug"])
def test_incremental_falls_back_when_slug_set_changes(vault: Vault, tmp_path: Path, change: str):
    """문서 추가·삭제·slug 변경은 다른 페이지의 짧은 링크 해석을 바꿀 수 있다 → 전체 빌드."""
    db = tmp_path / "incr.db"
    _full(vault, db)
    before = _dump(db)
    content = vault.root / "content"
    if change == "add":
        (content / "e.md").write_text(_page("Echo", "echo."), encoding="utf-8")
    elif change == "remove":
        (content / "c.md").unlink()
    else:
        c = content / "c.md"
        c.write_text(c.read_text(encoding="utf-8").replace("title: Charlie", "title: Charlie\nslug: other/c"), encoding="utf-8")
        _touch_later(c)

    assert script.update_db(vault.root, db) is None
    assert _dump(db) == before, "증분을 포기할 때 DB를 건드리면 안 된다"


def test_incremental_falls_back_for_db_without_snapshot(vault: Vault, tmp_path: Path):
    """스냅샷 테이블이 없는 예전 DB는 무엇이 바뀌었는지 알 수 없다 → 전체 빌드."""
    db = tmp_path / "incr.db"
    _full(vault, db)
    con = sqlite3.connect(db)
    con.execute("DROP TABLE build_files")
    con.commit()
    con.close()
    assert script.update_db(vault.root, db) is None


def test_build_db_reports_incremental_mode(vault: Vault):
    first = db_module.build_db(vault, run_lint=False, incremental=True)
    assert first["ok"] and first["mode"] == "full"  # DB 없음

    b = vault.root / "content" / "b.md"
    b.write_text(_page("Bravo", "bravo edited body [[a]]."), encoding="utf-8")
    _touch_later(b)
    second = db_module.build_db(vault, run_lint=False, incremental=True)
    assert second["ok"] and second["mode"] == "incremental"


def test_connect_rebuilds_stale_db_incrementally(vault: Vault, monkeypatch: pytest.MonkeyPatch):
    db_module.connect(vault).close()
    b = vault.root / "content" / "b.md"
    b.write_text(_page("Bravo", "bravo edited again."), encoding="utf-8")
    _touch_later(b)

    calls: list[dict] = []
    real = db_module.build_db
    monkeypatch.setattr(db_module, "build_db", lambda v, **kw: calls.append(kw) or real(v, **kw))
    db_module.connect(vault).close()

    assert calls and calls[0].get("incremental") is True


def test_analytics_do_not_depend_on_row_order(tmp_path: Path):
    """증분 빌드는 바뀐 페이지를 지웠다 다시 넣어 rowid 순서가 바뀐다. 분석(특히 Louvain
    community)이 SELECT 순서에 의존하면 같은 파일 상태에서 전체 빌드와 결과가 달라진다
    (실 vault 169문서에서 community 169건 전부 불일치로 발견)."""
    from raven.core.analytics import update_analytics_properties

    # 서로 떨어진 두 군집 — 번호(0/1)가 "처음 등장한 순서"로 매겨지므로 행 순서를
    # 뒤집으면 번호가 뒤바뀐다 (군집 구성 자체는 같다).
    slugs = [f"n{i:02d}" for i in range(30)]
    edges = [(slugs[i], slugs[i + 1 if i != 14 else 0]) for i in range(15)]
    edges += [(slugs[i], slugs[i + 1 if i != 29 else 15]) for i in range(15, 30)]

    def build(order: list[str]) -> dict:
        db = tmp_path / f"order-{order[0]}.db"
        con = sqlite3.connect(db)
        con.executescript(script.SCHEMA_SQL)
        for s in order:
            con.execute(
                "INSERT INTO pages (slug, title, type, created, updated, path, content, raw_content)"
                " VALUES (?, ?, 'concept', '2026-01-01', '2026-01-01', ?, '', '')",
                (s, s, s),
            )
        for src, tgt in (edges if order[0] == slugs[0] else list(reversed(edges))):
            con.execute("INSERT OR IGNORE INTO links (source_slug, target_slug) VALUES (?, ?)", (src, tgt))
        update_analytics_properties(con)
        con.commit()
        out = dict(con.execute("SELECT slug, community FROM pages").fetchall())
        con.close()
        return out

    assert build(slugs) == build(list(reversed(slugs)))

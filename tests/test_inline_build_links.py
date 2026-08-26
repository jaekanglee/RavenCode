"""_inline_build()가 [[wikilink]]를 links 테이블에 채우는지 검증.

배경: 데스크톱 앱 번들에는 scripts/build_db.py가 없어 build_db()가
_inline_build() 폴백으로 떨어진다. 이 폴백은 pages/tags/relations는
채우면서 links는 스키마만 만들고 INSERT를 누락해, wiki_graph edges /
wiki_get_page backlinks·outbound_links / 가드닝 고립 문서 판정이 전부
빈 값으로 보이는 버그를 낳는다 (Raven Product Feedback Brief 참조).
"""
from __future__ import annotations

from pathlib import Path
import sqlite3

from raven.core import db as db_module
from raven.core.vault import Vault


def test_inline_build_extracts_wikilinks_into_links_table(tmp_path: Path, monkeypatch) -> None:
    reg_root = tmp_path / "registry"
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(reg_root))
    vault = Vault.create("inline-build-links", tmp_path / "vault")
    content_dir = vault.root / "content"
    content_dir.mkdir(parents=True, exist_ok=True)

    (content_dir / "target-page.md").write_text(
        "---\ntitle: Target\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nTarget content\n",
        encoding="utf-8",
    )
    (content_dir / "source-page.md").write_text(
        "---\ntitle: Source\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n"
        "See [[content/target-page]] for details.\n",
        encoding="utf-8",
    )

    db_path = vault.db_path
    result = db_module._inline_build(vault, db_path)
    assert result["ok"] is True

    conn = sqlite3.connect(str(db_path))
    try:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT source_slug, target_slug, intent FROM links "
            "WHERE source_slug = 'content/source-page'"
        ).fetchone()
        assert row is not None, "links table should contain the [[wikilink]] extracted from body content"
        assert row["target_slug"] == "content/target-page"
        assert row["intent"] == "auto"
    finally:
        conn.close()

from __future__ import annotations

from pathlib import Path
import pytest
import sqlite3

from raven.core.vault import Vault
from raven.core import db as db_module
from raven.core.hybrid_search import LocalEmbeddingEngine, hybrid_search, load_vector_extension

@pytest.fixture
def isolated_vault(tmp_path: Path, monkeypatch) -> Vault:
    reg_root = tmp_path / "registry"
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(reg_root))
    vault = Vault.create("hybrid-test", tmp_path / "vault")
    content_dir = vault.root / "content"
    content_dir.mkdir(parents=True, exist_ok=True)
    return vault


def test_embedding_engine_mock_fallback() -> None:
    """sentence-transformers가 설치되지 않았더라도 mock 임베딩이 768차원 단위 벡터를 반환하는지 검증합니다."""
    engine = LocalEmbeddingEngine()
    emb1 = engine.get_embedding("hello world")
    emb2 = engine.get_embedding("hello world")
    emb3 = engine.get_embedding("different query")
    
    assert len(emb1) == 768
    assert len(emb2) == 768
    assert len(emb3) == 768
    
    # 동일한 입력은 동일한 임베딩 값을 리턴하는지 (deterministic)
    assert emb1 == emb2
    # 다른 입력은 다른 임베딩 값을 리턴하는지 (확률적 다름 검증)
    assert emb1 != emb3
    
    # 정규화된 단위 벡터인지 확인 (오차 범위 내)
    norm = sum(x*x for x in emb1) ** 0.5
    assert abs(norm - 1.0) < 1e-5


def test_hybrid_search_fallback_flow(isolated_vault: Vault) -> None:
    """sqlite-vec가 로드되거나 로드되지 않더라도 hybrid_search API가 정상적으로 Fallback하여 결과를 반환하는지 검증합니다."""
    content_dir = isolated_vault.root / "content"
    
    # 2개 페이지 생성
    (content_dir / "doc-a.md").write_text(
        "---\ntitle: Authentication Guide\ntype: concept\ntags: [auth]\n---\nExplain JWT tokens and cookies\n", encoding="utf-8"
    )
    (content_dir / "doc-b.md").write_text(
        "---\ntitle: Database Setup\ntype: concept\ntags: [db]\n---\nMySQL and PostgreSQL database replication\n", encoding="utf-8"
    )
    
    db_module.build_db(isolated_vault, run_lint=False)
    
    # 1. hybrid_search 함수 호출 검증
    # "JWT"로 검색하면 doc-a.md가 매칭되어야 함
    results = hybrid_search(isolated_vault, "JWT", limit=5)
    
    # sqlite-vec extension 로드 성공 여부에 따라 method가 "hybrid" 또는 "bm25_fallback"이어야 함
    assert len(results) >= 1
    best_hit = results[0]
    assert best_hit["slug"] == "content/doc-a"
    assert "Authentication" in best_hit["title"]
    assert best_hit["method"] in ("hybrid", "bm25_fallback")
    assert "score" in best_hit
    assert "bm25_score" in best_hit
    assert "distance" in best_hit

    # 2. 매칭되지 않는 검색어 테스트 시 빈 목록이 오는지 확인
    no_results = hybrid_search(isolated_vault, "NonExistingSearchTermRandom", limit=5)
    assert len(no_results) == 0


def test_hybrid_search_api(isolated_vault: Vault) -> None:
    """FastAPI hybrid-search API가 정상적으로 호출되고 결과를 반환하는지 테스트합니다."""
    from fastapi.testclient import TestClient
    from raven.api.server import app
    
    content_dir = isolated_vault.root / "content"
    (content_dir / "doc-a.md").write_text(
        "---\ntitle: Authentication Guide\ntype: concept\ntags: [auth]\n---\nExplain JWT tokens and cookies\n", encoding="utf-8"
    )
    db_module.build_db(isolated_vault, run_lint=False)
    
    client = TestClient(app)
    resp = client.get(f"/api/vaults/{isolated_vault.meta.name}/hybrid-search?query=JWT&limit=5")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert len(data["results"]) >= 1
    assert data["results"][0]["slug"] == "content/doc-a"
    assert "score" in data["results"][0]


def test_mcp_hybrid_search_registered() -> None:
    """MCP 진입점에서 wiki_hybrid_search 도구가 등록되어 있는지 검증합니다."""
    from raven.mcp import cli as cli_module
    import inspect
    assert hasattr(cli_module, "register_tools")
    source = inspect.getsource(cli_module.register_tools)
    assert "wiki_hybrid_search" in source


def test_hybrid_search_matches_alias(isolated_vault: Vault) -> None:
    """title/본문에는 없는 검색어라도 aliases frontmatter에 있으면 검색되어야 한다 (FTS5 aliases 컬럼)."""
    content_dir = isolated_vault.root / "content"
    (content_dir / "doc-c.md").write_text(
        "---\ntitle: 인증 가이드\ntype: concept\ntags: [auth]\naliases: [ZanzibarAuthZ]\n---\n"
        "권한 부여 흐름을 설명한다.\n",
        encoding="utf-8",
    )
    db_module.build_db(isolated_vault, run_lint=False)

    results = hybrid_search(isolated_vault, "ZanzibarAuthZ", limit=5)
    assert len(results) >= 1
    assert results[0]["slug"] == "content/doc-c"


def test_hybrid_search_matches_partial_words_case_insensitively(
    isolated_vault: Vault, monkeypatch: pytest.MonkeyPatch
) -> None:
    """대시보드 입력 중인 ``system ope``도 ``System Operations``를 찾아야 한다."""
    content_dir = isolated_vault.root / "content"
    (content_dir / "system-operations.md").write_text(
        "---\ntitle: System Operations\ntype: concept\ntags: [operations]\n---\n"
        "Runbook for the production system.\n",
        encoding="utf-8",
    )
    db_module.build_db(isolated_vault, run_lint=False)
    monkeypatch.setattr("raven.core.hybrid_search.load_vector_extension", lambda conn: False)

    results = hybrid_search(isolated_vault, "  SYSTEM   ope  ", limit=5)

    assert results[0]["slug"] == "content/system-operations"


def test_inline_build_fts_includes_alias(tmp_path, monkeypatch) -> None:
    """설치 패키지 fallback 빌더(_inline_build)도 pages_fts에 aliases를 포함해야
    한다 — 두 빌더 간 스키마 drift는 과거 실제 버그였다 (db.py 상단 문서 참고)."""
    import sqlite3
    from raven.core.vault import Vault
    from raven.core.db import _inline_build

    # 임시 레지스트리 — 없으면 사용자의 실제 vault 레지스트리에 등록된다.
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "registry"))
    vault = Vault.create("inline-test", tmp_path / "vault")
    content_dir = vault.root / "content"
    content_dir.mkdir(parents=True, exist_ok=True)
    (content_dir / "doc-d.md").write_text(
        "---\ntitle: 결제 가이드\ntype: concept\ntags: [pay]\naliases: [PayGateway]\n---\n"
        "결제 처리 흐름.\n",
        encoding="utf-8",
    )

    db_path = tmp_path / "wiki.db"
    _inline_build(vault, db_path)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT slug FROM pages_fts WHERE pages_fts MATCH ?", ("PayGateway",)
    ).fetchall()
    conn.close()
    assert [r["slug"] for r in rows] == ["content/doc-d"]


def test_inline_build_fts_rowid_integrity_with_multiple_tags(tmp_path, monkeypatch) -> None:
    """_inline_build이 페이지에 2개 이상의 태그가 있어도 pages_fts의 rowid가 올바른
    페이지 rowid를 가리키는지 검증한다.

    이 테스트는 과거 버그를 포착한다: last_insert_rowid()는 tag INSERT loop에서
    tag 테이블의 rowid를 반환하기 때문에, 태그가 1개 이상 있으면 pages_fts가
    잘못된 rowid(마지막 tag의 rowid)를 가지게 된다. 올바른 수정은 subquery로
    pages 테이블의 rowid를 직접 가져오는 것이다."""
    import sqlite3
    from raven.core.vault import Vault
    from raven.core.db import _inline_build

    # 임시 레지스트리 — 없으면 사용자의 실제 vault 레지스트리에 등록된다.
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "registry"))
    vault = Vault.create("rowid-test", tmp_path / "vault")
    content_dir = vault.root / "content"
    content_dir.mkdir(parents=True, exist_ok=True)

    # 2개 이상의 태그를 가진 페이지 생성
    (content_dir / "doc-multi-tag.md").write_text(
        "---\ntitle: Multi-tag Document\ntype: concept\ntags: [tag1, tag2, tag3]\n---\n"
        "This document has multiple tags.\n",
        encoding="utf-8",
    )

    db_path = tmp_path / "wiki.db"
    _inline_build(vault, db_path)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # pages 테이블에서 페이지의 rowid 가져오기
    page_row = conn.execute(
        "SELECT rowid, slug FROM pages WHERE slug = ?", ("content/doc-multi-tag",)
    ).fetchone()
    assert page_row is not None, "Document not found in pages table"
    expected_rowid = page_row["rowid"]

    # pages_fts 테이블에서 FTS rowid 가져오기
    fts_row = conn.execute(
        "SELECT rowid, slug FROM pages_fts WHERE slug = ?", ("content/doc-multi-tag",)
    ).fetchone()
    assert fts_row is not None, "Document not found in pages_fts table"
    actual_rowid = fts_row["rowid"]

    conn.close()

    # 핵심 검증: pages_fts의 rowid는 pages 테이블의 rowid와 일치해야 함
    # (bug: last_insert_rowid() 사용 시 마지막 tag의 rowid를 가짐)
    assert actual_rowid == expected_rowid, (
        f"FTS rowid mismatch: pages.rowid={expected_rowid}, "
        f"pages_fts.rowid={actual_rowid}. This indicates the page was indexed "
        f"with the wrong rowid (likely a tag's rowid from the tag insert loop)."
    )

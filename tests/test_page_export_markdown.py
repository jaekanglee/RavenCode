"""v0.7.184+ — 페이지 .md 내보내기 엔드포인트 (문서 공유/내보내기).

Dashboard 공유 팝오버의 "Markdown 파일로 저장"이 호출하는 표면.
PDF는 클라이언트 인쇄 대화상자(의존성 0)로 처리하므로 서버 표면이 없다.

Contract:
 1. 원본 파일 그대로 (frontmatter 포함) + text/markdown
 2. Content-Disposition attachment + 한글 파일명 RFC 5987 인코딩
 3. ?frontmatter=false → 본문만
 4. 옛 빌드 짧은 slug도 fuzzy fallback으로 해석
 5. 없는 slug → 404, 경로 탈출 시도 → 400
 6. `{slug:path}` catch-all이 export.md를 삼키지 않는다 (등록 순서 회귀 가드)
"""
from __future__ import annotations

import urllib.parse
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from raven.api.server import app
from raven.core import db as db_module
from raven.core.vault import Vault

BODY = "# 제목\n\n본문 한 줄.\n\n- 항목 1\n- 항목 2\n"
FRONTMATTER = "---\ntitle: 내보내기 시험 문서\ntype: concept\ntags: [export]\n---\n"


@pytest.fixture
def vault(tmp_path: Path, monkeypatch) -> Vault:
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "registry"))
    v = Vault.create("export-test", tmp_path / "vault")
    content = v.root / "content"
    (content / "concept").mkdir(parents=True, exist_ok=True)
    (content / "concept" / "내보내기-시험-문서.md").write_text(
        FRONTMATTER + BODY, encoding="utf-8"
    )
    db_module.build_db(v, run_lint=False)
    return v


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


SLUG = "content/concept/내보내기-시험-문서"


def test_returns_raw_file_with_frontmatter(client, vault):
    r = client.get(f"/api/vaults/{vault.meta.name}/pages/{SLUG}/export.md")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/markdown")
    assert r.text == FRONTMATTER + BODY


def test_attachment_disposition_encodes_korean_filename(client, vault):
    r = client.get(f"/api/vaults/{vault.meta.name}/pages/{SLUG}/export.md")
    disposition = r.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    # 한글이라 ascii fallback은 stem이 비어 'page.md'로 떨어진다.
    assert 'filename="page.md"' in disposition
    expected = urllib.parse.quote("내보내기-시험-문서.md", safe="")
    assert f"filename*=UTF-8''{expected}" in disposition
    assert "Content-Disposition" in r.headers.get("access-control-expose-headers", "")


def test_frontmatter_false_returns_body_only(client, vault):
    r = client.get(
        f"/api/vaults/{vault.meta.name}/pages/{SLUG}/export.md",
        params={"frontmatter": "false"},
    )
    assert r.status_code == 200
    assert r.text == BODY
    assert "title:" not in r.text


def test_short_slug_resolves_via_fuzzy_fallback(client, vault):
    r = client.get(f"/api/vaults/{vault.meta.name}/pages/내보내기-시험-문서/export.md")
    assert r.status_code == 200
    assert r.text == FRONTMATTER + BODY


def test_missing_page_404(client, vault):
    r = client.get(f"/api/vaults/{vault.meta.name}/pages/content/없는-문서/export.md")
    assert r.status_code == 404


def test_path_traversal_rejected(client, vault):
    r = client.get(f"/api/vaults/{vault.meta.name}/pages/../../etc/passwd/export.md")
    assert r.status_code in (400, 404)


def test_export_route_registered_before_catch_all(client, vault):
    """catch-all이 먼저면 slug='.../export.md'로 해석돼 404가 난다."""
    paths = [r.path for r in app.routes if isinstance(getattr(r, "path", None), str)]
    export_idx = paths.index("/api/vaults/{name}/pages/{slug:path}/export.md")
    catch_all_idx = paths.index("/api/vaults/{name}/pages/{slug:path}")
    assert export_idx < catch_all_idx


def test_get_page_still_works_after_helper_extraction(client, vault):
    """_page_file_or_404 추출이 기존 get_page 동작을 바꾸지 않았는지."""
    r = client.get(f"/api/vaults/{vault.meta.name}/pages/{SLUG}")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["frontmatter"]["title"] == "내보내기 시험 문서"
    assert data["content"].strip().startswith("# 제목")

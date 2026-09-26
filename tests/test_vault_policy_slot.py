"""vault 운영 지침 슬롯 + MCP 전달 회귀 가드.

ADR: _meta/decisions/adr-2026-09-25-vault-policy-slot-and-mcp-delivery.md

Raven은 사용자가 쓴 `_meta/policy/VAULT-POLICY.md`를 읽어서 건네기만 한다.
만들지도, 고치지도, 페이지로 색인하지도 않는다.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path

import pytest
from mcp.server.mcpserver import MCPServer

from raven.core import db as db_module
from raven.core import lint as lint_module
from raven.core.contracts import write_page
from raven.core.vault import VAULT_POLICY_RELPATH, Vault
from raven.mcp.cli import register_tools, server_instructions

POLICY_TEXT = "# 운영 지침\n\n저장 기준: 재사용 가치가 있을 때만.\n"


@pytest.fixture
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Vault:
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "registry"))
    v = Vault.create("policy-vault", tmp_path / "vault")
    content_dir = v.root / "content"
    content_dir.mkdir(parents=True, exist_ok=True)
    (content_dir / "hello.md").write_text(
        "---\ntitle: Hello\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nbody\n",
        encoding="utf-8",
    )
    return v


def _write_policy(v: Vault) -> Path:
    path = v.root / VAULT_POLICY_RELPATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(POLICY_TEXT, encoding="utf-8")
    return path


def _call(mcp: MCPServer, name: str, arguments: dict):
    result = asyncio.run(mcp.call_tool(name, arguments))
    if result.structured_content is not None:
        return result.structured_content.get("result", result.structured_content)
    return json.loads(result.content[0].text)


def _page_slugs(db_path: Path) -> set[str]:
    con = sqlite3.connect(db_path)
    try:
        return {row[0] for row in con.execute("SELECT slug FROM pages")}
    finally:
        con.close()


def test_policy_path_is_outside_agents_dir() -> None:
    # `_meta/agents/`가 있으면 is_llm_wiki가 켜진다. 정책을 쓰는 것만으로 모드가 바뀌면 안 된다.
    assert VAULT_POLICY_RELPATH == "_meta/policy/VAULT-POLICY.md"


def test_wiki_get_policy_returns_user_policy(vault: Vault) -> None:
    _write_policy(vault)
    mcp = MCPServer("wiki")
    register_tools(mcp, "read")

    out = _call(mcp, "wiki_get_policy", {"vault": "policy-vault"})

    assert out["content"] == POLICY_TEXT
    assert out["path"] == VAULT_POLICY_RELPATH
    assert out["modified"]


def test_wiki_get_policy_without_file_is_not_an_error(vault: Vault) -> None:
    mcp = MCPServer("wiki")
    register_tools(mcp, "read")

    out = _call(mcp, "wiki_get_policy", {"vault": "policy-vault"})

    assert out["content"] is None
    assert out["modified"] is None
    assert not (vault.root / VAULT_POLICY_RELPATH).exists(), "읽기가 파일을 만들면 안 된다"


def test_server_instructions_point_agents_to_policy() -> None:
    text = server_instructions(["alpha", "beta"])
    assert "wiki_get_policy" in text
    assert "alpha, beta" in text


def test_build_db_does_not_index_policy(vault: Vault) -> None:
    _write_policy(vault)
    db_module.build_db(vault, run_lint=False)
    slugs = _page_slugs(vault.db_path)
    assert "content/hello" in slugs
    assert not any(s.startswith("_meta/policy") for s in slugs)


def test_inline_build_does_not_index_policy(vault: Vault) -> None:
    _write_policy(vault)
    db_module._inline_build(vault, vault.db_path)
    slugs = _page_slugs(vault.db_path)
    assert "content/hello" in slugs
    assert not any(s.startswith("_meta/policy") for s in slugs)


def test_lint_page_scan_skips_policy(vault: Vault) -> None:
    _write_policy(vault)
    pages = lint_module._all_pages(vault)
    assert all("_meta/policy" not in str(p) for p in pages)


def test_agent_cannot_write_policy(vault: Vault) -> None:
    _write_policy(vault)
    result = write_page(
        vault, VAULT_POLICY_RELPATH[:-3], "덮어쓰기", normalize=False,
        enforce_protected_paths=True,
    )
    assert result.ok is False
    assert result.error == "permission_denied"
    assert (vault.root / VAULT_POLICY_RELPATH).read_text(encoding="utf-8") == POLICY_TEXT

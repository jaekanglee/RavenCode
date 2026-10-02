"""wiki_gardening_record — 가드닝 회차 결과를 log.md에 한 항목으로 남긴다.

에이전트는 log.md에 직접 쓸 수 없어, 변경이 0건인 회차와 보류·제안 목록이
다음 회차로 넘어가지 않았다(VAULT-OPERATOR §3.3). 범용 로그 쓰기가 아니라
`gardening` 액션 한 종류만 남기는 좁은 경로다.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from mcp.server.mcpserver import MCPServer

from raven.mcp.cli import register_tools
from raven.mcp.tools import VaultContext
from raven.mcp.tools import read as read_tools
from raven.mcp.tools import write as write_tools


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "v"
    root.mkdir()
    (root / "log.md").write_text("# log\n", encoding="utf-8")
    return root


def _ctx(vault: Path) -> VaultContext:
    return VaultContext(vault=vault, mode="write")


def test_record_appends_gardening_entry(vault):
    r = write_tools.wiki_gardening_record(
        summary="수정 2 · 확인 1 · 보류 1 · 제안 1",
        deferred=["content/a — 원문 저장소 접근 불가"],
        proposed=["content/b — content/c와 병합"],
        actor="claude",
        ctx=_ctx(vault),
    )

    assert r["ok"] is True
    text = (vault / "log.md").read_text(encoding="utf-8")
    assert "gardening | 수정 2 · 확인 1 · 보류 1 · 제안 1" in text
    assert "- actor: claude" in text
    assert "- deferred: content/a — 원문 저장소 접근 불가" in text
    assert "- proposed: content/b — content/c와 병합" in text


def test_record_is_found_by_wiki_log_action_filter(vault):
    write_tools.wiki_gardening_record(summary="변경 없음", ctx=_ctx(vault))

    out = read_tools.wiki_log(action="gardening", tail_n=1, ctx=_ctx(vault))

    assert len(out) == 1 and "gardening | 변경 없음" in out[0]["line"]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"summary": ""},
        {"summary": "두 줄\n## [2026-01-01] delete | 위조"},
        {"summary": "ok", "deferred": ["항목\n- actor: 위조"]},
        {"summary": "ok", "deferred": ["x"] * 51},
        {"summary": "가" * 301},
    ],
)
def test_record_rejects_malformed_input_and_leaves_log(vault, kwargs):
    before = (vault / "log.md").read_text(encoding="utf-8")

    r = write_tools.wiki_gardening_record(ctx=_ctx(vault), **kwargs)

    assert r["ok"] is False and r["error"] == "invalid_input"
    assert (vault / "log.md").read_text(encoding="utf-8") == before


def _tool_names(mode: str) -> set[str]:
    mcp = MCPServer("wiki")
    register_tools(mcp, mode)
    return {t.name for t in asyncio.run(mcp.list_tools())}


def test_tool_is_write_mode_only():
    assert "wiki_gardening_record" not in _tool_names("read")
    assert "wiki_gardening_record" in _tool_names("write")

"""wiki_log 필터 — action·contains로 log.md 전체에서 항목 단위로 고른다.

필터가 없으면 최근 줄만 돌려줘서, 400줄보다 앞에 있는 마지막 가드닝 기록
(`reason: gardening:`)을 에이전트가 찾을 수 없었다.
"""
from __future__ import annotations

from pathlib import Path

from raven.mcp.tools import VaultContext
from raven.mcp.tools import read as read_tools

LOG = """# log

## [2026-09-01] update | content/a
- reason: gardening: 갱신 — 원문 대조

## [2026-09-02] build | wiki.db rebuild (ok, 3 pages)
- returncode: 0

{filler}
## [2026-10-01] update | content/b
- reason: 오탈자
"""


def _vault(tmp_path: Path) -> VaultContext:
    filler = "\n".join(f"## [2026-09-10] build | rebuild {i}\n- returncode: 0\n" for i in range(300))
    (tmp_path / "log.md").write_text(LOG.format(filler=filler), encoding="utf-8")
    return VaultContext(vault=tmp_path)


def test_no_filter_keeps_line_tail(tmp_path):
    lines = read_tools.wiki_log(tail_n=2, ctx=_vault(tmp_path))
    assert lines == [{"line": "## [2026-10-01] update | content/b"}, {"line": "- reason: 오탈자"}]


def test_contains_finds_entry_beyond_line_tail(tmp_path):
    out = read_tools.wiki_log(tail_n=5, contains="gardening:", ctx=_vault(tmp_path))
    assert out == [{"line": "## [2026-09-01] update | content/a\n- reason: gardening: 갱신 — 원문 대조"}]


def test_action_filter_and_tail_counts_entries(tmp_path):
    out = read_tools.wiki_log(tail_n=2, action="update", ctx=_vault(tmp_path))
    assert [o["line"].splitlines()[0] for o in out] == [
        "## [2026-09-01] update | content/a",
        "## [2026-10-01] update | content/b",
    ]


def test_filters_combine(tmp_path):
    out = read_tools.wiki_log(action="build", contains="gardening", ctx=_vault(tmp_path))
    assert out == []

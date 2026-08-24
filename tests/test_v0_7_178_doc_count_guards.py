"""Theme C — 문서 수치를 런타임에서 파생 (계획 docs/superpowers/plans/2026-07-29-raven-concept-reinforcement.md §4).

README가 SOT로 선언되어 있는데 카운트가 코드와 어긋나 있었다 (endpoint 26 vs 65,
MCP 9+5 vs 23+4, lint 14 vs 22, CLI 그룹 12 vs 11). `CHECK_REGISTRY` 선례
(`tests/test_lint_check_registry.py`)는 *등록 누락*만 잡고 *문서 표기*는 못 잡는다 —
그 빈틈을 여기서 막는다. 새 endpoint/도구/체크를 추가하면 이 테스트가 먼저 실패하고,
README를 같이 고치라고 말해준다.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import raven
from raven.api.server import app
from raven.core.lint import CHECK_REGISTRY

README = (ROOT / "README.md").read_text(encoding="utf-8")
HTTP_METHODS = {"GET", "POST", "PUT", "DELETE", "PATCH"}


def readme_number(pattern: str) -> int:
    match = re.search(pattern, README)
    assert match, f"README에서 이 표기를 찾지 못했습니다: {pattern!r}"
    return int(match.group(1))


def readme_numbers(pattern: str) -> tuple[int, ...]:
    match = re.search(pattern, README)
    assert match, f"README에서 이 표기를 찾지 못했습니다: {pattern!r}"
    return tuple(int(g) for g in match.groups())


def actual_api_endpoints() -> int:
    return sum(
        len(getattr(route, "methods", set()) & HTTP_METHODS)
        for route in app.routes
        if getattr(route, "path", "").startswith("/api")
    )


def source_count(rel_path: str, pattern: str) -> int:
    return len(re.findall(pattern, (ROOT / rel_path).read_text(encoding="utf-8")))


def test_readme_api_endpoint_counts_match_runtime():
    actual = actual_api_endpoints()
    assert readme_number(r"FastAPI (\d+) endpoints") == actual
    assert readme_number(r"## HTTP API \((\d+) endpoints\)") == actual


def test_readme_mcp_tool_counts_match_source():
    tools = source_count("raven/mcp/cli.py", r"@mcp\.tool")
    resources = source_count("raven/mcp/resources.py", r"@mcp\.resource")
    assert readme_numbers(r"MCPServer (\d+) tools \+ (\d+) resources") == (tools, resources)
    assert readme_number(r"tools/list → (\d+)개 도구") == tools


def test_readme_lint_count_matches_registry():
    assert readme_number(r"lint (\d+)개 실행/요약/체크") == len(CHECK_REGISTRY)


def test_readme_cli_group_count_matches_source():
    groups = source_count(
        "raven/cli/__main__.py", r'app\.add_typer\([a-z_]+_app,\s*name="[a-z]+"'
    )
    assert readme_numbers(r"Typer (\d+) top-level commands \+ (\d+) subcommand groups")[1] == groups
    assert readme_numbers(r"## 핵심 명령 \(CLI — (\d+) top-level \+ (\d+) 서브커맨드 그룹\)")[1] == groups


def test_version_is_single_sourced():
    """__version__ / OpenAPI / README 상태줄이 한 문자열이어야 한다 (v0.7.178 이전엔 4종 불일치)."""
    assert app.version == raven.__version__
    assert readme_number(r"- v0\.7\.(\d+) \(") == int(raven.__version__.split(".")[-1])


def test_version_matches_latest_changelog():
    versions = [
        tuple(int(p) for p in m.groups())
        for m in (
            re.fullmatch(r"changelog-v(\d+)\.(\d+)\.(\d+)\.md", path.name)
            for path in (ROOT / "_meta").glob("changelog-v*.md")
        )
        if m
    ]
    latest = ".".join(str(p) for p in max(versions))
    assert raven.__version__ == latest

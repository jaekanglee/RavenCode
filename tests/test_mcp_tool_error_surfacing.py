"""v0.7.185+ — MCP 실패 메시지가 에이전트에게 실제로 도달하는지.

**왜 필요한가**: mcp 2.x는 도구에서 올라온 예외를 두 갈래로 나눈다
(`mcp/server/mcpserver/tools/base.py`).

- `ToolError` → 메시지가 그대로 클라이언트에 전달
- 그 외 → `UnexpectedToolError`로 감싸이고 **`Error executing tool <name>`만**
  남는다. 원본 내용은 클라이언트에 전혀 도달하지 않는다.

Raven의 MCP 실패 메시지는 전부 에이전트가 읽고 스스로 고치라고 쓴 안내다
("사용 가능한 vault 목록", "허용 체크 id", "raven build --vault X로 재빌드").
평범한 ValueError/RuntimeError로 던지면 그 안내가 통째로 사라진다 — mcp 1.x
에서는 새어나왔기 때문에 2.x로 올리기 전까지 아무도 몰랐다.

Contract:
 1. 예상된 실패는 ToolError로 올라오고 안내 문구가 메시지에 남는다
 2. 기존 예외 타입(ValueError/RuntimeError/FileNotFoundError) 계약도 유지
 3. raven/mcp/ 안의 모든 raise는 ToolError 계열이다 (구조적 가드 — 신규 추가분까지)
"""
from __future__ import annotations

import ast
import asyncio
from pathlib import Path

import pytest
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError, UnexpectedToolError

from raven.core.registry import VaultMeta, VaultRegistry
from raven.mcp import errors as mcp_errors
from raven.mcp.cli import register_tools
from raven.mcp.tools import check_permission, resolve_vault_path

REPO = Path(__file__).resolve().parents[1]


@pytest.fixture
def registry_with_vaults(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path))
    reg = VaultRegistry(root=tmp_path)
    for name in ("alpha", "beta"):
        root = tmp_path / name
        (root / "content").mkdir(parents=True, exist_ok=True)
        reg.add(VaultMeta(name=name, path=root))
    return reg


def test_unknown_vault_message_reaches_the_client(registry_with_vaults):
    """마스킹되면 'Error executing tool wiki_log'만 남아 자가 수정이 불가능하다."""
    mcp = MCPServer("wiki")
    register_tools(mcp, "read")

    with pytest.raises(ToolError) as excinfo:
        asyncio.run(mcp.call_tool("wiki_log", {"vault": "nope"}))

    message = str(excinfo.value)
    assert not isinstance(excinfo.value, UnexpectedToolError), (
        "예상된 실패가 크래시로 분류되면 안내 문구가 클라이언트에 도달하지 않는다"
    )
    for token in ("nope", "alpha", "beta"):
        assert token in message


def test_vault_not_found_keeps_value_error_contract(registry_with_vaults):
    """mcp 1.x 시절 `except ValueError` 호출부를 깨지 않는다."""
    with pytest.raises(ValueError) as excinfo:
        resolve_vault_path("nope")
    assert isinstance(excinfo.value, ToolError)
    assert "alpha" in str(excinfo.value)


def test_permission_denial_explains_required_mode():
    with pytest.raises(ToolError) as excinfo:
        check_permission("wiki_delete", "read")
    message = str(excinfo.value)
    assert "wiki_delete" in message
    assert "admin" in message
    # 기존 except PermissionError_ 호출부(stale.py)도 계속 잡혀야 한다.
    from raven.mcp.tools import PermissionError_

    assert isinstance(excinfo.value, PermissionError_)


def test_error_types_keep_legacy_bases():
    """타입을 갈아치우지 않고 ToolError를 '더했는지'."""
    assert issubclass(mcp_errors.VaultNotFound, (ToolError, ValueError))
    assert issubclass(mcp_errors.InvalidToolArgument, (ToolError, ValueError))
    assert issubclass(mcp_errors.VaultDbMissing, (ToolError, FileNotFoundError))
    assert issubclass(mcp_errors.VaultDbSchemaDrift, (ToolError, RuntimeError))
    assert issubclass(mcp_errors.ToolPermissionDenied, (ToolError, PermissionError))


def _raised_names(path: Path) -> list[tuple[str, int]]:
    """파일 안 `raise Name(...)` 의 (이름, 줄번호)."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call):
            func = node.exc.func
            if isinstance(func, ast.Name):
                found.append((func.id, node.lineno))
            elif isinstance(func, ast.Attribute):
                found.append((func.attr, node.lineno))
    return found


def test_every_raise_under_raven_mcp_is_a_tool_error():
    """신규 도구가 평범한 예외를 던지면 여기서 먼저 실패한다.

    mcp 2.x에서 그런 예외는 메시지가 통째로 사라지므로, 에이전트는 무엇이
    잘못됐는지 알 수 없는 문장만 받는다 — 런타임에서야 드러나는 종류의 회귀다.
    """
    allowed = {
        name
        for name, obj in vars(mcp_errors).items()
        if isinstance(obj, type) and issubclass(obj, ToolError)
    }
    # 도구 모듈이 재정의/재수출하는 이름도 ToolError 계열이면 허용.
    allowed |= {"PermissionError_", "ToolError"}

    offenders = []
    for path in sorted((REPO / "raven" / "mcp").rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        for name, lineno in _raised_names(path):
            if name not in allowed:
                offenders.append(f"{path.relative_to(REPO)}:{lineno} raise {name}")

    assert not offenders, (
        "mcp 2.x는 ToolError가 아닌 예외의 메시지를 클라이언트에 전하지 않는다. "
        "raven/mcp/errors.py 의 타입을 쓰거나 거기에 추가하세요:\n  "
        + "\n  ".join(offenders)
    )

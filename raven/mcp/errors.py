"""raven.mcp.errors — MCP 도구가 던지는 "예상된 실패" 예외.

**왜 필요한가 (mcp 2.x 동작)**

mcp 2.x는 도구에서 올라온 예외를 두 갈래로 나눈다
(`mcp/server/mcpserver/tools/base.py`):

- ``ToolError`` — 예상한 실패. 메시지가 그대로 클라이언트에 전달된다
  (``Error executing tool <name>: <메시지>``).
- 그 외 모든 예외 — ``UnexpectedToolError``로 감싸이고 메시지는
  **``Error executing tool <name>``만 남는다**. 원본 내용은 클라이언트에
  전혀 도달하지 않는다 (의도된 정보 은닉).

Raven의 MCP 실패 메시지는 전부 *에이전트가 읽고 스스로 고치라고* 쓴 것이다 —
"사용 가능한 vault 목록", "허용된 체크 id 목록", "``raven build --vault X``로
재빌드하라". 평범한 ``ValueError``/``RuntimeError``로 던지면 mcp 2.x에서 그
안내가 통째로 사라지고 에이전트는 아무 단서 없는 문장만 받는다.

**왜 다중상속인가**

mcp 1.x 시절의 예외 타입(``ValueError``/``RuntimeError``/``FileNotFoundError``)을
기대하는 호출부와 회귀 테스트가 이미 있다. 타입을 갈아치우면 그 계약이 조용히
깨지므로, ``ToolError``를 *더한다*. 기존 ``except ValueError``도, 새 ``except
ToolError``도 모두 잡힌다.
"""
from __future__ import annotations

from mcp.server.mcpserver.exceptions import ToolError


class VaultNotFound(ToolError, ValueError):
    """레지스트리에 없는 vault 이름. 메시지에 사용 가능한 vault 목록을 담는다."""


class InvalidToolArgument(ToolError, ValueError):
    """허용목록 밖 인자. 메시지에 허용 목록을 담는다."""


class ToolPermissionDenied(ToolError, PermissionError):
    """현재 mode(read/write/admin)가 허용하지 않는 도구 호출."""


class VaultDbMissing(ToolError, FileNotFoundError):
    """wiki.db 부재. 메시지에 빌드 방법을 담는다."""


class VaultDbSchemaDrift(ToolError, RuntimeError):
    """구버전 스키마 wiki.db. 메시지에 재빌드 명령을 담는다."""

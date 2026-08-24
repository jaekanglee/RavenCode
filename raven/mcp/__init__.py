"""mcp — Model Context Protocol server for the wiki vault.

Provides a standardized MCP interface (9 tools + 5 resources) over wiki.db.
Default mode is read-only; write/admin require explicit CLI flags.

Submodules:
    cli         — MCPServer CLI entrypoint (stdio + streamable-http transports)
    db          — wiki.db query helpers (read-only)
    tools       — MCP tool implementations (read.py, write.py)
    resources   — MCP resource providers
"""
from raven import __version__  # v0.7.67 (평가 B#14): 별도 버전 방치 대신 top-level에 연결
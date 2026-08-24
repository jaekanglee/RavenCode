"""raven — Multi-vault wiki engine + CLI + API + MCP.

Layered architecture (v0.7.9+):
    raven.core      — pure engine (registry, vault, db, lint, link, export)
    raven.cli       — Typer-based CLI (vault ls/use/crud/lint)
    raven.api       — FastAPI HTTP server (Dashboard backend / external automation)
    dashboard/        — React 19 SPA (read + write UI)
    raven.mcp       — MCPServer (mcp>=2.0) server (LLM agent standard protocol, v0.7.8+)

에이전트(LLM client) ↔ Raven 인터페이스 = MCP only (단일 표준).
사람/스크립트용: CLI / API / Dashboard 자유.
"""
__version__ = "0.7.182"  # SOT — tests/test_v0_7_178_doc_count_guards.py가 이 값을 OpenAPI/README/상위 changelog와 맞춘다.

"""db.py — read-only query helpers for wiki.db (SCHEMA v2.4).

All public functions return plain dicts / lists so they're trivially
JSON-serializable for the MCP transport. Connections are opened per-call
(read-only workload; no concurrent writers in this process).
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Iterable, Optional


# ─────────────────────────── helpers ──────────────────────────────


def _default_vault() -> Path:
    """Resolve the default vault when no explicit vault path is given.

    v0.7.67 (평가 B#16): pre-v0.7.67 this unconditionally returned the
    `raven` *package* directory (`mcp/`'s parent) — a leftover from the
    single-vault era when `mcp/` lived inside the vault itself. In an
    installed-package / multi-vault setup, `raven/wiki.db` never exists,
    so this was a dormant bug (most call sites resolve the vault via the
    registry first, per `resolve_vault_path`, so it rarely fires — but any
    caller that omits `vault` now gets the actual registry default instead
    of a path that can never contain a wiki.db).
    """
    try:
        from raven.core.vault import resolve_active_vault
        return resolve_active_vault().root
    except Exception:
        # No registry / no default vault configured (e.g. isolated dev
        # checkout used as its own vault) — fall back to legacy behavior.
        return Path(__file__).resolve().parent.parent


def _resolve_vault(vault: Optional[Path | str]) -> Path:
    p = Path(vault) if vault else _default_vault()
    return p


def _schema_drifted(db_path: Path) -> bool:
    """True when wiki.db schema no longer matches the SCHEMA v2.4 MCP contract.

    v0.7.183 (톡머리 vault operator report): the legacy standalone CLI
    (2026-07-01, pre-v0.7.67) built wiki.db without `pages.contested` and
    `pages_fts`, so MCP reads failed with cryptic SQLite errors
    (`no such column: contested`, `no such table: pages_fts`). The read
    path must surface a clear rebuild hint instead. Never raises — returns
    True on any inspection error (AGENTS.md §9 silent failure policy).
    """
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(pages)").fetchall()}
            if "contested" not in cols:
                return True
            fts = conn.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type='table' AND name='pages_fts' LIMIT 1"
            ).fetchone()
            return fts is None
        finally:
            conn.close()
    except Exception:
        return True


def get_db(vault: Optional[Path | str] = None) -> sqlite3.Connection:
    """Open a connection to <vault>/wiki.db with row_factory=Row.

    Raises FileNotFoundError if wiki.db does not exist (caller should
    run build_db.py first).

    v0.7.183: raises a clear RuntimeError instead of a cryptic SQLite
    error when the DB was built with an outdated schema (pre-v0.7.67
    standalone CLI). Rebuild hint included.
    """
    root = _resolve_vault(vault)
    db_path = root / "wiki.db"
    if not db_path.exists():
        raise VaultDbMissing(
            f"wiki.db not found at {db_path}. Run scripts/build_db.py first."
        )
    if _schema_drifted(db_path):
        raise VaultDbSchemaDrift(
            f"wiki.db at {db_path} uses an outdated schema (missing "
            f"pages.contested / pages_fts — built by a pre-v0.7.67 raven CLI). "
            f"Rebuild it with: raven build --vault {root.name}"
        )
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def _rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict]:
    return [dict(r) for r in rows]


# ─────────────────────────── pages ────────────────────────────────


def list_pages(vault: Optional[Path | str] = None) -> list[dict]:
    """All pages (catalog). Used by wiki://index resource."""
    conn = get_db(vault)
    try:
        rows = conn.execute(
            "SELECT slug, title, type, path, updated FROM pages ORDER BY slug"
        ).fetchall()
        return _rows_to_dicts(rows)
    finally:
        conn.close()


# v0.7.68 (평가 B#2): relocated to raven.core.db — pure SQLite query with
# no MCP-specific state. Re-exported here so existing MCP callers/imports
# keep working unchanged.
from raven.mcp.errors import VaultDbMissing, VaultDbSchemaDrift
from raven.core.db import search_fts as search_fts  # noqa: E402,F401


def get_page(
    slug: str, vault: Optional[Path | str] = None
) -> Optional[dict]:
    """Single page + backlinks + outbound links + tags.

    Returns None if slug doesn't exist.
    """
    conn = get_db(vault)
    try:
        row = conn.execute(
            "SELECT slug, title, type, created, updated, path, "
            "       confidence, contested, content, raw_content "
            "FROM pages WHERE slug = ?",
            (slug,),
        ).fetchone()
        if not row:
            return None
        page = dict(row)
        page["tags"] = [
            r["tag"]
            for r in conn.execute(
                "SELECT tag FROM tags WHERE page_slug = ? ORDER BY tag",
                (slug,),
            ).fetchall()
        ]
        page["backlinks"] = _rows_to_dicts(
            conn.execute(
                "SELECT source_slug, source_title, source_path "
                "FROM v_backlinks WHERE slug = ? ORDER BY source_slug",
                (slug,),
            ).fetchall()
        )
        page["outbound_links"] = _rows_to_dicts(
            conn.execute(
                "SELECT target_slug, intent "
                "FROM links WHERE source_slug = ? ORDER BY target_slug",
                (slug,),
            ).fetchall()
        )
        # v0.7.178: token an agent passes back as `wiki_update(precondition=...)`.
        # Derived from the markdown file, never from this DB — wiki.db is a
        # regenerable cache and may lag the file, but the precondition must
        # answer "did the actual file move since I read it?".
        from raven.core.contracts import precondition_for_path

        page["precondition"] = precondition_for_path(
            _resolve_vault(vault) / f"{slug}.md"
        )
        return page
    finally:
        conn.close()


# ─────────────────────────── graph ────────────────────────────────


def graph(vault: Optional[Path | str] = None) -> dict[str, list[dict]]:
    """Full link graph: nodes (pages) + edges (links)."""
    conn = get_db(vault)
    try:
        nodes = _rows_to_dicts(
            conn.execute(
                "SELECT slug, title, type FROM pages ORDER BY slug"
            ).fetchall()
        )
        edges = _rows_to_dicts(
            conn.execute(
                "SELECT source_slug AS source, target_slug AS target, intent "
                "FROM links ORDER BY source_slug, target_slug"
            ).fetchall()
        )
        return {"nodes": nodes, "edges": edges}
    finally:
        conn.close()


# ─────────────────────────── log tail ────────────────────────────


def tail_log(
    tail_n: int = 20, vault: Optional[Path | str] = None
) -> list[dict]:
    """Last N non-empty lines of log.md (heuristic — log is free-text)."""
    root = _resolve_vault(vault)
    log_path = root / "log.md"
    if not log_path.exists():
        return []
    lines = log_path.read_text(encoding="utf-8").splitlines()
    # Keep only non-blank lines, then take the tail
    nonblank = [ln for ln in lines if ln.strip()]
    return [{"line": ln} for ln in nonblank[-tail_n:]]


# ─────────────────────────── schema dump ──────────────────────────


def schema_text(vault: Optional[Path | str] = None) -> str:
    """Raw text of SCHEMA.md (resource: wiki://schema)."""
    root = _resolve_vault(vault)
    schema_path = root / "SCHEMA.md"
    if not schema_path.exists():
        return ""
    return schema_path.read_text(encoding="utf-8")
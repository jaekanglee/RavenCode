"""read.py — read-only MCP tools (always permitted).

Tools:
    wiki_search       — FTS5 BM25
    wiki_get_page     — single page + backlinks/tags/outbound
    wiki_lint         — raven.core.lint (14 checks), same runner as the REST API
    wiki_graph        — nodes + edges
    wiki_log          — last N log.md entries
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from raven.mcp import db
from raven.mcp.tools import VaultContext


# ─────────────── 1. wiki_search ───────────────


def wiki_search(
    query: str, top_k: int = 10, ctx: Optional[VaultContext] = None
) -> list[dict]:
    """FTS5 BM25 search across the vault."""
    ctx = ctx or VaultContext(vault=db._default_vault())
    return db.search_fts(query=query, top_k=top_k, vault=ctx.vault)


# ─────────────── 2. wiki_get_page ───────────────


def wiki_get_page(slug: str, ctx: Optional[VaultContext] = None) -> Optional[dict]:
    """Single page with backlinks, outbound links, and tags."""
    ctx = ctx or VaultContext(vault=db._default_vault())
    return db.get_page(slug=slug, vault=ctx.vault)


# ─────────────── 3. wiki_lint ───────────────


def wiki_lint(ctx: Optional[VaultContext] = None) -> dict:
    """Run raven.core.lint (14 checks) against the vault; return structured summary.

    v0.7.x: previously shelled out to a per-vault `<vault>/scripts/lint.py`,
    which only exists for vaults that opted into the standalone LLM-Wiki
    script bundle — every other vault (including the default Docker-managed
    ones) hit "lint.py not found". Calling `raven.core.lint.run_all()`
    in-process matches what the REST API's `/lint` endpoint already does,
    so behavior is consistent regardless of vault layout.
    """
    ctx = ctx or VaultContext(vault=db._default_vault())
    from raven.core.lint import run_all
    from raven.core.registry import VaultMeta
    from raven.core.vault import Vault

    vault_obj = Vault(meta=VaultMeta(name=ctx.vault.name, path=ctx.vault), root=ctx.vault)
    result = run_all(vault_obj)
    return {
        "critical": result["counts"]["critical"],
        "warning": result["counts"]["warning"],
        "info": result["counts"]["info"],
        "total": result["counts"]["total"],
        "issues": result["issues"],
    }


# ─────────────── 4. wiki_graph ───────────────


def wiki_graph(
    project: Optional[str] = None,
    fmt: str = "json",
    ctx: Optional[VaultContext] = None,
) -> dict:
    """Page + link graph (json). `project` filter is a future option."""
    ctx = ctx or VaultContext(vault=db._default_vault())
    g = db.graph(vault=ctx.vault)
    # Optional filter on edges / nodes by slug prefix (project-style buckets)
    if project:
        g = {
            "nodes": [n for n in g["nodes"] if project in n["slug"]],
            "edges": [
                e for e in g["edges"]
                if project in e["source"] or project in e["target"]
            ],
        }
    g["format"] = fmt
    return g


# ─────────────── 5. wiki_log ───────────────


def wiki_log(tail_n: int = 20, ctx: Optional[VaultContext] = None) -> list[dict]:
    """Last N non-empty log.md lines."""
    ctx = ctx or VaultContext(vault=db._default_vault())
    return db.tail_log(tail_n=tail_n, vault=ctx.vault)


# ─────────────── 5.5. wiki_get_policy ───────────────


def wiki_get_policy(ctx: Optional[VaultContext] = None) -> dict:
    """User-owned vault operating policy, verbatim. Missing file → content None.

    Read-only delivery (ADR 2026-09-25): never creates or rewrites the file.
    """
    from raven.core.policy import read_policy

    ctx = ctx or VaultContext(vault=db._default_vault())
    return read_policy(Path(ctx.vault))


# ─────────────── 8. wiki_relations_list ───────────────


def wiki_relations_list(
    slug: Optional[str] = None,
    relation_type: Optional[str] = None,
    ctx: Optional[VaultContext] = None,
) -> list[dict]:
    """List semantic relations, optionally filtered by source slug or type."""
    ctx = ctx or VaultContext(vault=db._default_vault())
    db_path = ctx.vault / "wiki.db"
    if not db_path.exists():
        from raven.core import db as core_db
        from raven.mcp.tools.write import _load_vault
        try:
            core_db.build_db(_load_vault(ctx.vault), run_lint=False)
        except Exception:
            return []

    import sqlite3
    import json

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        query = (
            "SELECT source_slug, target_slug, relation_type, "
            "       confidence_semantic, confidence_structural, confidence_provenance, "
            "       verified_by, evidence, reason "
            "FROM relations WHERE 1=1"
        )
        params = []
        if slug:
            query += " AND source_slug = ?"
            params.append(slug)
        if relation_type:
            query += " AND relation_type = ?"
            params.append(relation_type)

        rows = conn.execute(query, params).fetchall()

        results = []
        for r in rows:
            evidence_val = r["evidence"]
            evidence_parsed = None
            if evidence_val:
                try:
                    evidence_parsed = json.loads(evidence_val)
                except Exception:
                    evidence_parsed = evidence_val

            verified_by_val = r["verified_by"]
            verified_by_parsed = None
            if verified_by_val:
                if ", " in verified_by_val:
                    verified_by_parsed = [v.strip() for v in verified_by_val.split(",")]
                else:
                    verified_by_parsed = [verified_by_val]

            results.append({
                "source": r["source_slug"],
                "target": r["target_slug"],
                "type": r["relation_type"],
                "confidence": {
                    "semantic": r["confidence_semantic"],
                    "structural": r["confidence_structural"],
                    "provenance": r["confidence_provenance"]
                },
                "verified_by": verified_by_parsed,
                "evidence": evidence_parsed,
                "reason": r["reason"]
            })
        return results
    finally:
        conn.close()

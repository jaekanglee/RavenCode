"""raven.core.wikilink — shared [[target]] wikilink parsing.

Single source of truth for both DB builders (`scripts/build_db.py`'s
canonical builder and `raven.core.db._inline_build`'s installed-package
fallback), following the same pattern already used for relation payload
validation (`raven.core.relations.is_valid_relation_payload`). Keeping this
logic in one place avoids the two builders drifting apart — the fallback
previously had a `links` table with no code path that ever populated it.
"""
from __future__ import annotations

import re
import sqlite3
from typing import Iterable, Optional

# [[target]] or [[target]]! or [[target]]?
WIKILINK_RE = re.compile(r"\[\[([^\[\]\n]+?)\]\]([!?]?)")
CONTEXT_RADIUS = 50  # chars on each side of the wikilink in the body


def extract_links(content: str) -> Iterable[tuple[str, str, Optional[str]]]:
    """Yield (target_slug, intent, context) tuples from a markdown body.

    intent is one of: 'auto', 'broken', 'missing'.
    context is up to 50 chars on each side of the wikilink.
    """
    for m in WIKILINK_RE.finditer(content):
        target = m.group(1).strip()
        suffix = m.group(2)
        intent = {"!": "broken", "?": "missing"}.get(suffix, "auto")
        start, end = m.span()
        ctx_start = max(0, start - CONTEXT_RADIUS)
        ctx_end = min(len(content), end + CONTEXT_RADIUS)
        context = content[ctx_start:ctx_end].replace("\n", " ").strip()
        yield target, intent, context


def slug_exists(conn: sqlite3.Connection, slug: str) -> bool:
    row = conn.execute("SELECT 1 FROM pages WHERE slug = ? LIMIT 1", (slug,)).fetchone()
    return row is not None


def resolve_short_slug(conn: sqlite3.Connection, short_slug: str) -> Optional[str]:
    """pages 중 마지막 segment 매치로 짧은 slug 보정. 예: 'vault-structure' → 'concept/vault-structure'."""
    base = short_slug.rsplit("/", 1)[-1]
    rows = conn.execute(
        "SELECT slug FROM pages WHERE slug = ? OR slug LIKE ?",
        (base, "%/" + base),
    ).fetchall()
    if len(rows) == 1:
        return rows[0][0]
    if len(rows) > 1:
        # ambiguous — 가장 짧은 path 우선 (root 가까울수록 canonical)
        return min(rows, key=lambda r: len(r[0]))[0]
    return None

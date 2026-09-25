"""raven.core.recommend — Related page recommendation engine.

Calculates related pages using Co-citation and Tag Overlap indicators.
"""
from __future__ import annotations

import sqlite3
from typing import Optional, Any

from .vault import Vault
from . import db as db_module
from . import frontmatter as frontmatter_module

# Scoring Weights
CO_CITATION_WEIGHT = 2.0
TAG_OVERLAP_WEIGHT = 1.0


def get_recommendations(
    vault: Vault,
    slug: str,
    top_k: int = 5,
) -> list[dict[str, Any]]:
    """Get the top K recommended pages for the given slug.

    Args:
        vault: The Vault instance.
        slug: The target page slug (e.g. 'content/foo').
        top_k: Max number of recommendations to return.

    Returns:
        A list of dicts, each representing a recommendation:
        {
            "slug": str,
            "title": str,
            "type": str,
            "score": float,
            "co_citation_score": int,
            "tag_overlap_score": int,
            "importance": Optional[float],   # Future expansion (Post-MVP)
            "centrality": Optional[float],   # Future expansion (Post-MVP)
        }
    """
    # connect()가 DB 부재/stale 시 lint 없이 재빌드한다 — 여기서 따로 build_db(lint 포함)를
    # 부르면 결과를 버리는 lint가 한 번 더 돌았다.
    conn = db_module.connect(vault)
    conn.row_factory = sqlite3.Row

    # Combined query to count Co-citations (on the 5 core relations) and Tag Overlaps.
    query = """
    SELECT
        p.slug,
        p.title,
        p.type,
        p.raw_content,
        p.importance,
        p.centrality,
        COALESCE(c.co_citation_count, 0) AS co_citation_count,
        COALESCE(t.tag_overlap_count, 0) AS tag_overlap_count
    FROM pages p
    LEFT JOIN (
        SELECT r2.target_slug AS slug, COUNT(r2.source_slug) AS co_citation_count
        FROM relations r1
        JOIN relations r2 ON r1.source_slug = r2.source_slug
        WHERE r1.target_slug = ?
          AND r2.target_slug != ?
          AND r1.relation_type IN ('uses', 'depends_on', 'implements', 'implemented_by', 'related')
          AND r2.relation_type IN ('uses', 'depends_on', 'implements', 'implemented_by', 'related')
        GROUP BY r2.target_slug
    ) c ON p.slug = c.slug
    LEFT JOIN (
        SELECT t2.page_slug AS slug, COUNT(t2.tag) AS tag_overlap_count
        FROM tags t1
        JOIN tags t2 ON t1.tag = t2.tag
        WHERE t1.page_slug = ?
          AND t2.page_slug != ?
        GROUP BY t2.page_slug
    ) t ON p.slug = t.slug
    WHERE p.slug != ?
      AND (c.co_citation_count > 0 OR t.tag_overlap_count > 0)
    """

    try:
        rows = conn.execute(query, (slug, slug, slug, slug, slug)).fetchall()
    except Exception:
        # Fallback to empty if relations table or schema doesn't exist yet
        return []
    finally:
        conn.close()

    recommendations = []
    for row in rows:
        cand_slug = row["slug"]
        title = row["title"]
        ptype = row["type"]
        raw_content = row["raw_content"]
        co_cite = row["co_citation_count"]
        tag_overlap = row["tag_overlap_count"]
        importance = row["importance"]
        centrality = row["centrality"]

        # Parse frontmatter to filter out rejected or archived pages
        try:
            meta, _ = frontmatter_module.parse(raw_content)
        except Exception:
            meta = {}

        status = meta.get("status", "")
        if status in ("rejected", "archived") or meta.get("archived"):
            continue

        score = (co_cite * CO_CITATION_WEIGHT) + (tag_overlap * TAG_OVERLAP_WEIGHT)

        recommendations.append({
            "slug": cand_slug,
            "title": title,
            "type": ptype,
            "score": score,
            "co_citation_score": co_cite,
            "tag_overlap_score": tag_overlap,
            "importance": float(importance) if importance is not None else 0.0,
            "centrality": float(centrality) if centrality is not None else 0.0,
        })

    # Sort: highest score first, then fallback to title, then slug alphabetically
    recommendations.sort(key=lambda x: (-x["score"], x["title"], x["slug"]))

    return recommendations[:top_k]

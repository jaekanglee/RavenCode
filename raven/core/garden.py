"""raven.core.garden — Knowledge gardening backend logic.

Provides helpers to query stale pages, orphan pages, and find link suggestions.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Dict, List, Optional

from .vault import Vault
from . import db as db_module
from .lint import _orphan_grace_days, STALE_DAYS


def db_is_stale(vault: Vault) -> bool:
    """wiki.db가 마크다운 SoT보다 오래됐는지.

    v0.7.66 (평가 P1#12): garden은 DB를 읽는데 lint는 파일시스템을 읽어서,
    빌드가 낡으면 garden이 경고 없이 "정리 대상 없음"으로 거짓 안심을 줬음.
    """
    db = vault.db_path
    if not db.exists():
        return True
    db_mtime = db.stat().st_mtime
    for fp in vault.content_root.rglob("*.md"):
        try:
            if fp.stat().st_mtime > db_mtime:
                return True
        except OSError:
            continue
    return False


def get_stale_pages(vault: Vault) -> List[Dict[str, Any]]:
    """Get pages that haven't been updated for STALE_DAYS (90 days).
    Excludes rule types and _meta/ directory.
    """
    today = dt.date.today()
    conn = db_module.connect(vault)
    cursor = conn.cursor()
    
    # Query all non-rule, non-system pages
    cursor.execute(
        "SELECT slug, title, updated, type FROM pages WHERE slug NOT LIKE '_meta/%' AND type != 'rule'"
    )
    rows = cursor.fetchall()
    conn.close()

    stale = []
    for slug, title, updated_str, ptype in rows:
        try:
            updated = dt.date.fromisoformat(updated_str) if updated_str else None
        except Exception:
            updated = None
        if not updated:
            continue
        age = (today - updated).days
        if age >= STALE_DAYS:
            stale.append({
                "slug": slug,
                "title": title,
                "type": ptype,
                "updated": updated_str,
                "age_days": age,
            })
    
    # Sort by age descending
    stale.sort(key=lambda x: x["age_days"], reverse=True)
    return stale


def get_orphan_pages(vault: Vault) -> List[Dict[str, Any]]:
    """Get orphan pages (inbound wikilinks = 0) older than the grace period.
    Excludes _meta/ directory and the vault root index (content/index), same as lint #4.
    """
    grace = _orphan_grace_days(vault)
    today = dt.date.today()
    conn = db_module.connect(vault)
    cursor = conn.cursor()

    # Query pages with 0 inbound links
    cursor.execute("""
        SELECT p.slug, p.title, p.created, p.type 
        FROM pages p
        WHERE p.slug NOT LIKE '_meta/%'
          AND p.slug != 'content/index'
          AND p.slug NOT IN (SELECT DISTINCT target_slug FROM links)
          AND ('content/' || p.slug) NOT IN (SELECT DISTINCT target_slug FROM links)
    """)
    rows = cursor.fetchall()
    conn.close()

    orphans = []
    for slug, title, created_str, ptype in rows:
        try:
            created = dt.date.fromisoformat(created_str) if created_str else today
        except Exception:
            created = today
        age = (today - created).days
        if age >= grace:
            orphans.append({
                "slug": slug,
                "title": title,
                "type": ptype,
                "created": created_str,
                "age_days": age,
            })
            
    orphans.sort(key=lambda x: x["age_days"], reverse=True)
    return orphans


def find_link_candidates(vault: Vault, slug: str, limit: int = 5) -> List[Dict[str, Any]]:
    """Find potential pages that could link to this orphan page.
    Utilises shared tags and FTS search as fallback.
    """
    conn = db_module.connect(vault)
    cursor = conn.cursor()
    
    candidates: Dict[str, Dict[str, Any]] = {}
    
    # 1. Query pages sharing the same tags
    cursor.execute("""
        SELECT DISTINCT t2.page_slug AS slug, p.title, COUNT(t2.tag) as shared_count
        FROM tags t1
        JOIN tags t2 ON t1.tag = t2.tag AND t2.page_slug != t1.page_slug
        JOIN pages p ON p.slug = t2.page_slug
        WHERE t1.page_slug = ? AND t2.page_slug NOT LIKE '_meta/%'
        GROUP BY t2.page_slug
        ORDER BY shared_count DESC
        LIMIT ?
    """, (slug, limit))
    
    for c_slug, title, shared_count in cursor.fetchall():
        candidates[c_slug] = {
            "slug": c_slug,
            "title": title,
            "reason": f"공통 태그 {shared_count}개 공유",
            "score": shared_count * 10
        }
        
    # 2. FTS search fallback/extension
    clean_slug = slug.split("/")[-1].replace("-", " ")
    if len(candidates) < limit and len(clean_slug) > 2:
        try:
            cursor.execute("""
                SELECT slug, title FROM pages_fts 
                WHERE content MATCH ? AND slug != ? AND slug NOT LIKE '_meta/%'
                LIMIT ?
            """, (clean_slug, slug, limit - len(candidates)))
            for f_slug, title in cursor.fetchall():
                if f_slug not in candidates:
                    candidates[f_slug] = {
                        "slug": f_slug,
                        "title": title,
                        "reason": f"본문 내 '{clean_slug}' 키워드 포함",
                        "score": 5
                    }
        except Exception:
            pass
            
    conn.close()
    
    sorted_candidates = list(candidates.values())
    sorted_candidates.sort(key=lambda x: x["score"], reverse=True)
    return sorted_candidates[:limit]

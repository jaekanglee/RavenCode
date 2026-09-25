"""build_db.py — scan a wiki vault, emit a SQLite v2.4 query index.

Markdown files are the Source of Truth (git-tracked). This script builds a
SQLite database at <vault>/wiki.db that the dashboard / MCP server / lint
tools query. The DB is gitignored — always regenerable from markdown.

Usage:
    python3 build_db.py                          # default vault = ~/wiki
    python3 build_db.py /path/to/vault           # explicit vault
    python3 build_db.py /path/to/vault --db /tmp/x.db
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import sqlite3
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import frontmatter

from raven.core.relations import is_valid_relation_payload
from raven.core.node_meta import aliases_to_json, collection_for_slug, normalize_status
from raven.core.vault import ROOT_AGENT_INSTRUCTION_FILES
from raven.core.wikilink import (
    WIKILINK_RE,
    extract_links,
    slug_exists as _slug_exists,
    resolve_short_slug as _resolve_short_slug,
)

# ─────────────────────────── constants ──────────────────────────────

EXCLUDED_TOP_DIRS = {"raw", "_archive", "scripts", "node_modules", ".venv", ".git"}
TODAY = dt.date.today().isoformat()


# ─────────────────────────── schema (v2.4) ──────────────────────────

SCHEMA_SQL = """
CREATE TABLE pages (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  path TEXT NOT NULL,
  confidence TEXT,
  contested INTEGER DEFAULT 0,
  content TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  collection TEXT NOT NULL DEFAULT 'root',
  status TEXT NOT NULL DEFAULT 'current',
  aliases TEXT NOT NULL DEFAULT '[]',
  importance REAL DEFAULT 0.0,
  centrality REAL DEFAULT 0.0,
  community INTEGER DEFAULT 0,
  layer REAL DEFAULT 0.0,
  freshness REAL DEFAULT 0.0
);

CREATE TABLE tags (
  page_slug TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (page_slug, tag),
  FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE
);
CREATE INDEX idx_tags_tag ON tags(tag);

CREATE TABLE links (
  source_slug TEXT NOT NULL,
  target_slug TEXT NOT NULL,
  context TEXT,
  intent TEXT DEFAULT 'auto',
  PRIMARY KEY (source_slug, target_slug),
  FOREIGN KEY (source_slug) REFERENCES pages(slug) ON DELETE CASCADE
);
CREATE INDEX idx_links_target ON links(target_slug);

CREATE TABLE relations (
  source_slug TEXT NOT NULL,
  target_slug TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  confidence_semantic REAL,
  confidence_structural REAL,
  confidence_provenance REAL,
  verified_by TEXT,
  evidence TEXT,
  reason TEXT,
  PRIMARY KEY (source_slug, target_slug, relation_type),
  FOREIGN KEY (source_slug) REFERENCES pages(slug) ON DELETE CASCADE,
  CHECK (relation_type IN ('uses', 'depends_on', 'implements', 'implemented_by', 'related')),
  CHECK (evidence IS NOT NULL AND TRIM(evidence) != ''),
  CHECK (reason IS NOT NULL AND TRIM(reason) != '')
);
CREATE INDEX idx_relations_target ON relations(target_slug);

CREATE VIRTUAL TABLE pages_fts USING fts5(
  slug, title, tags_concat, content, aliases
);

CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, slug, title, tags_concat, content, aliases)
  VALUES (
    new.rowid, new.slug, new.title,
    COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM tags WHERE page_slug = new.slug), ''),
    new.content, new.aliases
  );
END;

CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
  DELETE FROM pages_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER pages_au AFTER UPDATE ON pages BEGIN
  DELETE FROM pages_fts WHERE rowid = old.rowid;
  INSERT INTO pages_fts(rowid, slug, title, tags_concat, content, aliases)
  VALUES (
    new.rowid, new.slug, new.title,
    COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM tags WHERE page_slug = new.slug), ''),
    new.content, new.aliases
  );
END;

CREATE TRIGGER tags_ai AFTER INSERT ON tags BEGIN
  -- refresh FTS row for this page so new tag joins the index
  DELETE FROM pages_fts WHERE rowid = (SELECT rowid FROM pages WHERE slug = new.page_slug);
  INSERT INTO pages_fts(rowid, slug, title, tags_concat, content, aliases)
  SELECT p.rowid, p.slug, p.title,
         COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM tags WHERE page_slug = p.slug), ''),
         p.content, p.aliases
  FROM pages p WHERE p.slug = new.page_slug;
END;

-- 증분 재빌드용 스냅샷: 마지막 빌드 시점의 파일 상태. 이 표가 없는 DB(예전 빌드)는
-- 무엇이 바뀌었는지 알 수 없어 update_db가 전체 빌드로 돌아간다.
CREATE TABLE build_files (
  path TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  mtime_ns INTEGER NOT NULL,
  size INTEGER NOT NULL
);

CREATE VIEW v_backlinks AS
  SELECT l.target_slug AS slug, l.source_slug, p.title AS source_title,
         p.path AS source_path, l.context
  FROM links l JOIN pages p ON p.slug = l.source_slug;

CREATE VIEW v_pages_with_tags AS
  SELECT p.*, GROUP_CONCAT(t.tag, ',') AS tags_list
  FROM pages p LEFT JOIN tags t ON t.page_slug = p.slug
  GROUP BY p.slug;
"""


# ─────────────────────────── slug strategy (v2.2) ───────────────────

def derive_slug(md_path: Path, vault: Path, fm_slug: Optional[str]) -> str:
    """1. frontmatter slug wins; 2. vault-relative path (.md stripped); 3. _meta/ kept."""
    if fm_slug:
        return fm_slug.strip()
    return md_path.relative_to(vault).with_suffix("").as_posix()


# ─────────────────────────── frontmatter defaults ──────────────────

DEFAULT_FM = {
    "title": "Untitled",
    "type": "rule",
    "tags": [],
    "sources": [],
    "created": TODAY,
    "updated": TODAY,
    "confidence": None,
    "contested": False,
    "slug": None,
}


def parse_page(md_path: Path, vault: Path) -> dict:
    """Read a markdown file, parse frontmatter, derive slug. Returns a dict ready for INSERT."""
    raw = md_path.read_text(encoding="utf-8")
    try:
        post = frontmatter.loads(raw)
        fm = dict(post.metadata)
    except Exception:
        # Malformed frontmatter → treat as empty
        fm = {}

    # Apply defaults for missing required fields
    title = str(fm.get("title") or md_path.stem)
    page_type = str(fm.get("type") or "rule")
    created = str(fm.get("created") or TODAY)
    updated = str(fm.get("updated") or TODAY)
    confidence = fm.get("confidence")
    contested = 1 if fm.get("contested") else 0
    fm_slug = fm.get("slug")

    slug = derive_slug(md_path, vault, fm_slug)
    body = post.content if "post" in locals() else raw
    # Strip leading frontmatter if python-frontmatter didn't (safety)
    if body.startswith("---\n"):
        body = re.sub(r"^---\n.*?\n---\n", "", raw, count=1, flags=re.DOTALL)

    return {
        "slug": slug,
        "title": title,
        "type": page_type,
        "created": created,
        "updated": updated,
        "path": str(md_path.relative_to(vault)),
        "confidence": confidence,
        "contested": contested,
        "content": body.strip(),
        "raw_content": raw,
        "collection": collection_for_slug(slug),
        "status": normalize_status(fm.get("status")),
        "aliases": aliases_to_json(fm.get("aliases")),
        "tags": list(fm.get("tags") or []),
        "relations": list(fm.get("relations") or []),
    }


# ─────────────────────────── vault walking ─────────────────────────

def iter_markdown(vault: Path):
    """Yield every .md file in vault, skipping EXCLUDED_TOP_DIRS."""
    for path in sorted(vault.rglob("*.md")):
        rel_parts = path.relative_to(vault).parts
        if rel_parts and rel_parts[0] in EXCLUDED_TOP_DIRS:
            continue
        if len(rel_parts) == 1 and rel_parts[0] in ROOT_AGENT_INSTRUCTION_FILES:
            continue  # user-owned root instructions, not content pages
        yield path


# ─────────────────────────── DB build ──────────────────────────────

def _insert_page(conn: sqlite3.Connection, page: dict) -> tuple[int, int]:
    """페이지 1개와 그 태그·관계·링크를 INSERT. 전체 빌드와 증분 빌드가 공유한다.
    Returns (n_links, n_tags)."""
    import json

    n_links = n_tags = 0
    conn.execute(
        """INSERT INTO pages (slug, title, type, created, updated, path,
                              confidence, contested, content, raw_content,
                              collection, status, aliases)
           VALUES (:slug, :title, :type, :created, :updated, :path,
                   :confidence, :contested, :content, :raw_content,
                   :collection, :status, :aliases)""",
        {**page, "tags": None, "relations": None},  # tags & relations not columns
    )

    for tag in page["tags"]:
        tag = str(tag).strip()
        if not tag:
            continue
        conn.execute(
            "INSERT OR IGNORE INTO tags (page_slug, tag) VALUES (?, ?)",
            (page["slug"], tag),
        )
        n_tags += 1

    for rel in page["relations"]:
        if not is_valid_relation_payload(rel):
            continue
        rel_type = rel.get("type")
        target = str(rel.get("target")).strip()

        conf = rel.get("confidence")
        conf_sem = None
        conf_str = None
        conf_prov = None
        if isinstance(conf, dict):
            conf_sem = conf.get("semantic")
            conf_str = conf.get("structural")
            conf_prov = conf.get("provenance")
        elif conf is not None:
            conf_sem = conf

        verified = rel.get("verified_by")
        if isinstance(verified, list):
            verified_by_str = ", ".join(str(v) for v in verified)
        else:
            verified_by_str = str(verified) if verified is not None else None

        ev = rel.get("evidence")
        evidence_str = json.dumps(ev) if ev is not None else None
        reason = rel.get("reason")

        normalized = target
        if target and not _slug_exists(conn, target):
            candidate = _resolve_short_slug(conn, target)
            if candidate:
                normalized = candidate

        conn.execute(
            """INSERT OR REPLACE INTO relations (source_slug, target_slug, relation_type,
                                                  confidence_semantic, confidence_structural, confidence_provenance,
                                                  verified_by, evidence, reason)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (page["slug"], normalized, rel_type, conf_sem, conf_str, conf_prov, verified_by_str, evidence_str, reason),
        )

    for target, intent, context in extract_links(page["content"]):
        # v0.6.10: target slug normalize — 옛 wikilink `[[vault-structure]]` (짧은 형태)
        # 가 pages에 `concept/vault-structure` (긴 형태)로 존재할 때 자동 매칭.
        # 1) 정확 매치: 그대로
        # 2) 마지막 segment 매치 (prefix 보정)
        # 3) 매치 없으면 intent = 'broken' 유지
        normalized = target
        if target and not _slug_exists(conn, target):
            candidate = _resolve_short_slug(conn, target)
            if candidate:
                normalized = candidate
        conn.execute(
            """INSERT OR REPLACE INTO links (source_slug, target_slug, context, intent)
               VALUES (?, ?, ?, ?)""",
            (page["slug"], normalized, context, intent),
        )
        n_links += 1

    return n_links, n_tags


def _resolve_pending_targets(conn: sqlite3.Connection) -> None:
    """v0.6.10 post-processing pass: 짧은 slug로 남은 링크·관계 대상을 긴 slug로 보정.

    전체 빌드의 첫 pass에서는 아직 INSERT되지 않은 페이지를 가리키는 링크가
    보정되지 못한다(self-reference race). 모든 페이지가 들어간 뒤 다시 시도한다.
    SQLite에는 id 컬럼 없음 → PRIMARY KEY로 UPDATE.
    """
    try:
        rows = conn.execute(
            "SELECT source_slug, target_slug, context, intent FROM links"
        ).fetchall()
        for src, tgt, ctx, intent in rows:
            if _slug_exists(conn, tgt):
                continue  # 이미 정확
            cand = _resolve_short_slug(conn, tgt)
            if cand:
                conn.execute(
                    "UPDATE links SET target_slug = ? WHERE source_slug = ? AND target_slug = ?",
                    (cand, src, tgt),
                )
    except Exception:
        pass

    try:
        rows = conn.execute(
            "SELECT source_slug, target_slug, relation_type FROM relations"
        ).fetchall()
        for src, tgt, rel_type in rows:
            if _slug_exists(conn, tgt):
                continue
            cand = _resolve_short_slug(conn, tgt)
            if cand:
                conn.execute(
                    "UPDATE relations SET target_slug = ? WHERE source_slug = ? AND target_slug = ? AND relation_type = ?",
                    (cand, src, tgt, rel_type),
                )
    except Exception:
        pass


def _update_analytics(conn: sqlite3.Connection) -> None:
    """analytics post-processing pass — 그래프 전역 지표라 증분 빌드에서도 전체를 다시 계산한다."""
    try:
        repo_root = Path(__file__).resolve().parent.parent
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))
        from raven.core.analytics import update_analytics_properties
        update_analytics_properties(conn)
    except Exception as exc:
        sys.stderr.write(f"⚠️  analytics update failed: {exc}\n")


def _file_state(md_path: Path) -> tuple[int, int]:
    st = md_path.stat()
    return st.st_mtime_ns, st.st_size


def build_db(vault: Path, db_path: Path) -> tuple[int, int, int]:
    """Build wiki.db from vault. Returns (n_pages, n_links, n_tags)."""
    vault = vault.resolve()
    db_path = db_path.resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # Regenerate: remove existing
    if db_path.exists():
        db_path.unlink()

    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(SCHEMA_SQL)
        conn.execute("PRAGMA foreign_keys = ON")

        n_pages = n_links = n_tags = 0
        for md_path in iter_markdown(vault):
            # Raven Product Feedback Brief (2026-09-03): iter_markdown() snapshots
            # the file list up front, but a concurrent wiki_rename/wiki_delete can
            # move/remove a page while this scan is still working through the rest
            # of the vault — read_text() then raises OSError and, uncaught, killed
            # the *entire* build (intermittent "wiki.db rebuild fail, returncode 1"
            # on otherwise-unrelated pages). Skip the vanished page instead; the
            # rename/delete's own rebuild will pick it up correctly. Mirrors the
            # OSError guard raven/core/db.py::_inline_build already has.
            try:
                # stat을 읽기 전에 잡는다 — 빌드 도중 파일이 바뀌면 스냅샷이 옛 값이라
                # 다음 증분 빌드가 그 파일을 다시 색인한다.
                mtime_ns, size = _file_state(md_path)
                page = parse_page(md_path, vault)
            except OSError as exc:
                print(f"⚠️  skipping {md_path} (vanished mid-scan?): {exc}", file=sys.stderr)
                continue
            added_links, added_tags = _insert_page(conn, page)
            n_pages += 1
            n_links += added_links
            n_tags += added_tags
            conn.execute(
                "INSERT OR REPLACE INTO build_files (path, slug, mtime_ns, size) VALUES (?, ?, ?, ?)",
                (page["path"], page["slug"], mtime_ns, size),
            )

        conn.commit()

        _resolve_pending_targets(conn)
        conn.commit()

        _update_analytics(conn)
        conn.commit()

        return n_pages, n_links, n_tags
    finally:
        conn.close()


def update_db(vault: Path, db_path: Path) -> Optional[int]:
    """기존 문서의 내용만 바뀌었으면 그 페이지만 다시 색인한다.

    Returns 다시 색인한 페이지 수(0 = 바뀐 것 없음). 전체 빌드가 필요하면 None을
    돌려주고 DB는 건드리지 않는다:
      - DB나 스냅샷 표(build_files)가 없음 (예전 빌드)
      - 문서가 추가·삭제됐거나 slug가 바뀜 — 짧은 링크 보정(resolve_short_slug)은
        slug 집합에 의존하므로 다른 페이지의 링크 해석이 달라질 수 있다
      - 스캔 중 파일이 사라지는 등 어떤 오류든 (트랜잭션 롤백)
    """
    vault = vault.resolve()
    db_path = db_path.resolve()
    if not db_path.exists():
        return None

    conn = sqlite3.connect(str(db_path))
    try:
        has_snapshot = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'build_files'"
        ).fetchone()
        if not has_snapshot:
            return None
        snapshot = {
            path: (slug, mtime_ns, size)
            for path, slug, mtime_ns, size in conn.execute(
                "SELECT path, slug, mtime_ns, size FROM build_files"
            )
        }

        current: dict[str, tuple[Path, int, int]] = {}
        for md_path in iter_markdown(vault):
            try:
                mtime_ns, size = _file_state(md_path)
            except OSError:
                return None
            current[str(md_path.relative_to(vault))] = (md_path, mtime_ns, size)

        if current.keys() != snapshot.keys():
            return None

        changed = [
            rel for rel, (_, mtime_ns, size) in current.items()
            if (mtime_ns, size) != snapshot[rel][1:]
        ]
        if not changed:
            return 0

        pages = []
        for rel in changed:
            md_path, mtime_ns, size = current[rel]
            try:
                page = parse_page(md_path, vault)
            except OSError:
                return None
            if page["slug"] != snapshot[rel][0]:
                return None
            pages.append((page, mtime_ns, size))

        conn.execute("PRAGMA foreign_keys = ON")
        try:
            for page, mtime_ns, size in pages:
                slug = page["slug"]
                conn.execute("DELETE FROM tags WHERE page_slug = ?", (slug,))
                conn.execute("DELETE FROM links WHERE source_slug = ?", (slug,))
                conn.execute("DELETE FROM relations WHERE source_slug = ?", (slug,))
                conn.execute("DELETE FROM pages WHERE slug = ?", (slug,))
                _insert_page(conn, page)
                conn.execute(
                    "UPDATE build_files SET mtime_ns = ?, size = ? WHERE path = ?",
                    (mtime_ns, size, page["path"]),
                )
            _resolve_pending_targets(conn)
            _update_analytics(conn)
            conn.commit()
        except Exception:
            conn.rollback()
            return None
        return len(pages)
    finally:
        conn.close()


# ─────────────────────────── CLI ───────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    _default_vault = Path(__file__).resolve().parent.parent
    p = argparse.ArgumentParser(description=f"Build {_default_vault} SQLite query index.")
    p.add_argument("vault", nargs="?", default=str(_default_vault),
                   help=f"vault root (default: {_default_vault})")
    p.add_argument("--db", default=None,
                   help="output DB path (default: <vault>/wiki.db)")
    p.add_argument("--incremental", action="store_true",
                   help="기존 문서 내용만 바뀌었으면 그 페이지만 다시 색인 (아니면 전체 빌드)")
    args = p.parse_args(argv)

    vault = Path(args.vault).expanduser().resolve()
    if not vault.is_dir():
        print(f"❌ vault not found: {vault}", file=sys.stderr)
        return 1

    db_path = Path(args.db).expanduser().resolve() if args.db else vault / "wiki.db"
    if args.incremental:
        changed = update_db(vault, db_path)
        if changed is not None:
            # db.py가 이 줄의 mode= 토큰으로 빌드 방식을 읽는다.
            print(f"✅ wiki.db mode=incremental: {changed} page(s) reindexed")
            return 0
    n_pages, n_links, n_tags = build_db(vault, db_path)
    size_kb = db_path.stat().st_size / 1024
    print(f"✅ wiki.db ({size_kb:.1f} KB): {n_pages} pages, {n_links} links, {n_tags} tags")
    return 0


if __name__ == "__main__":
    sys.exit(main())

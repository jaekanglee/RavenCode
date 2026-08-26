"""raven.core.db — vault-aware SQLite index builder.

Wraps `scripts/build_db.py` so any vault can rebuild its own wiki.db.

Strategy:
    - The original `scripts/build_db.py` is a stable 293-line script that takes
      a vault path and an optional --db output. We don't rewrite it; we just
      invoke it as a subprocess with the right argv.
    - This file is the public face used by `raven.cli.build` and the API.
    - Falls back to a minimal inline build if the script is missing (e.g. when
      installed as a package without the `scripts/` dir).
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Optional

from .lock import lock_for_file
from .node_meta import aliases_to_json, collection_for_slug, normalize_status
from .relations import is_valid_relation_payload
from .vault import Vault, resolve_active_vault, ROOT_AGENT_INSTRUCTION_FILES
from .wikilink import extract_links, slug_exists, resolve_short_slug


# ────────────────────────── public API ──────────────────────────


def build_db(vault: Vault, db_path: Optional[Path] = None, *, run_lint: bool = True) -> dict:
    """Rebuild the wiki.db index for `vault`. Returns a small status dict.

    Args:
        vault: the active vault handle (root + meta).
        db_path: where to write the DB (default: <vault>/wiki.db).
        run_lint: build 직후 lint 14개 자동 실행. 기본 True.

    Side effect: appends a `build` entry to log.md on success or failure.
    """
    db_path = Path(db_path) if db_path else vault.db_path

    # v0.7.183 (톡머리 vault operator report): pre-v0.7.67 스키마 wiki.db
    # (구버전 standalone CLI가 생성 — pages.contested / pages_fts 없음) 가
    # 남아있으면 MCP/API read가 깨진다. build는 아래에서 unlink+재생성하므로
    # 결과는 항상 최신 스키마지만, drift를 명시적으로 경고해 silent failure를
    # 막는다. (custom --db 경로일 때는 vault 기본 DB 기준 drift 검사 생략)
    if (
        db_path.resolve() == vault.db_path.resolve()
        and db_path.exists()
        and db_schema_drift(vault)
    ):
        import sys as _sys
        _sys.stderr.write(
            f"⚠️  {vault.meta.name}: wiki.db 스키마가 구버전입니다 — "
            f"최신 스키마(SCHEMA v2.4)로 재구축합니다.\n"
        )

    repo_root = _repo_root()
    script = repo_root / "scripts" / "build_db.py" if repo_root else None

    # v0.7.67 (평가 A#8): build unlinks + recreates db_path with no lock —
    # two concurrent builds (or a build racing a reader mid-unlink) could
    # corrupt/lose wiki.db. Serialize builds through the same FileLock
    # contracts.write_page uses for page writes.
    with lock_for_file(vault.root, db_path):
        if script and script.exists():
            result = _run_legacy_build(script, vault, db_path)
        else:
            result = _inline_build(vault, db_path)

    # log.md에 build entry 자동 append (실패해도 계속)
    try:
        from . import log as _log
        status = "ok" if result.get("ok") else "fail"
        pages = result.get("pages") or "?"
        _log.append(
            vault,
            action="build",
            subject=f"wiki.db rebuild ({status}, {pages} pages)",
            extra={"db": str(db_path), "returncode": str(result.get("returncode", "?"))},
        )
    except Exception as exc:  # AGENTS.md §9: silent 버그 정책 — silent swallow ❌
        import sys
        sys.stderr.write(
            f"⚠️  build log.md append failed for vault {vault.meta.name!r}: "
            f"{type(exc).__name__}: {exc}\n"
        )

    # ─── index.md 마크다운 카탈로그 자동 컴파일 (v0.7.27) ───
    if result.get("ok"):
        try:
            from .index_builder import build_index
            # v0.7.66 (평가 P1#5): index 파일이 갱신되면 같은 build 안에서 재색인.
            # 이전엔 생성된 index.md/_index/*가 DB에 없어 build 직후에도 lint #11이
            # "build 필요"를 냈고, 두 번 빌드해야 수렴했음.
            if build_index(vault):
                with lock_for_file(vault.root, db_path):
                    if script and script.exists():
                        _run_legacy_build(script, vault, db_path)
                    else:
                        _inline_build(vault, db_path)
        except Exception as e:
            result["index_error"] = f"{type(e).__name__}: {e}"

    # build 직후 lint 14개 자동 실행
    if run_lint:
        try:
            from . import lint as _lint
            lint_result = _lint.run_all(vault)
            result["lint"] = lint_result
        except Exception as e:
            result["lint_error"] = f"{type(e).__name__}: {e}"

    return result


def connect(vault: Vault) -> sqlite3.Connection:
    """Open a read-only connection to vault's wiki.db (build/rebuild if missing or stale).

    v0.7.67 (평가 A#2/A#8): pre-v0.7.67 only rebuilt when the DB file was
    entirely missing — a stale DB (markdown edited after the last build)
    was served as-is, so search/graph/backlinks silently returned outdated
    data. Now every connect() checks `garden.db_is_stale()` first.

    v0.7.119 (ADR-2026-07-09): also checks `db_schema_drift()` — pre-v0.7.119
    `db_is_stale()` only watched markdown mtime vs db mtime. Existing vaults
    whose wiki.db was built before the v0.7.67 schema migration (e.g.
    `homelab` / `babymoa` / `hermes-infra` — `links` table is still
    `src/dst/kind/intent`, `tags` is `(name, count)`, no `pages_fts`) had
    a *newer mtime* than their markdown (because someone rebuilt once
    against the wrong schema) so the stale guard returned False and the
    /garden endpoint silently 500'd on every request. Schema drift guard
    triggers a one-shot rebuild — markdown SoT is rebuilt into the
    canonical schema, old db is overwritten.
    """
    if not vault.db_path.exists():
        build_db(vault)
    else:
        from . import garden as _garden
        if _garden.db_is_stale(vault) or db_schema_drift(vault):
            build_db(vault)
    return sqlite3.connect(f"file:{vault.db_path}?mode=ro", uri=True)


def db_schema_drift(vault: Vault) -> bool:
    """True when the wiki.db schema no longer matches the canonical contract.

    v0.7.119 (ADR-2026-07-09): detects pre-v0.7.67 schema state on existing
    vaults — `links` was `src/dst/kind/intent` (now `source_slug/target_slug/
    context/intent`), `tags` was `(name, count)` (now `(page_slug, tag)`),
    and `pages_fts` did not exist. The drift was silent because
    `db_is_stale()` only watched markdown mtime vs db mtime, and the stale
    db could be *newer* than the markdown (a one-shot rebuild against the
    wrong schema). Returning True here forces a rebuild through the
    canonical schema path, after which `connect()` opens cleanly.

    Cheap: three PRAGMA table_info calls, one SELECT name FROM
    sqlite_master. Never raises — returns True on any inspection error
    so the caller rebuilds rather than serving broken schema.
    """
    if not vault.db_path.exists():
        return False  # connect() handles "missing" via build_db directly
    try:
        conn = sqlite3.connect(f"file:{vault.db_path}?mode=ro", uri=True)
        try:
            # 1. links table must have source_slug + target_slug (canonical).
            cols = {row[1] for row in conn.execute("PRAGMA table_info(links)").fetchall()}
            if not {"source_slug", "target_slug"}.issubset(cols):
                return True
            # 2. tags table must have page_slug + tag (canonical M:N join).
            tag_cols = {row[1] for row in conn.execute("PRAGMA table_info(tags)").fetchall()}
            if not {"page_slug", "tag"}.issubset(tag_cols):
                return True
            # 3. pages_fts virtual table must exist (FTS5 index).
            fts_exists = conn.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type='table' AND name='pages_fts' LIMIT 1"
            ).fetchone()
            if fts_exists is None:
                return True
            # 4. pages table must have minimal node meta + analytics columns.
            #    `contested` 추가 (v0.7.183): MCP wiki_get_page가 읽는 컬럼 —
            #    구버전 standalone CLI 스키마엔 없어 `no such column` 발생.
            pages_cols = {row[1] for row in conn.execute("PRAGMA table_info(pages)").fetchall()}
            if not {
                "collection", "status", "aliases", "contested",
                "importance", "centrality", "community", "layer", "freshness",
            }.issubset(pages_cols):
                return True
            return False
        finally:
            conn.close()
    except Exception:
        # Inspection failed (corrupt db, locked, permissions) — treat as
        # drift so caller rebuilds rather than serving whatever we just
        # couldn't read. AGENTS.md §9 silent failure policy.
        return True


def search_fts(
    query: str,
    top_k: int = 10,
    vault: Optional[Path | str] = None,
) -> list[dict]:
    """FTS5 BM25 search across slug/title/tags/content.

    v0.7.68 (평가 B#2): relocated from `raven.mcp.db` — a pure SQLite query
    with no MCP-specific state, so CLI no longer needs to import
    `raven.mcp` just to search. `raven.mcp.db.search_fts` re-exports this
    for existing MCP callers.
    """
    if vault:
        root = Path(vault)
    else:
        root = resolve_active_vault().root
    db_path = root / "wiki.db"
    if not db_path.exists():
        raise FileNotFoundError(
            f"wiki.db not found at {db_path}. Run `raven build` first."
        )
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT p.slug, p.title, p.path, "
            "       bm25(pages_fts) AS score, "
            "       snippet(pages_fts, 3, '**', '**', '...', 32) AS snippet "
            "FROM pages_fts "
            "JOIN pages p ON p.rowid = pages_fts.rowid "
            "WHERE pages_fts MATCH ? "
            # v0.7.66 (평가 P1#8): 자동 생성 카탈로그는 검색 제외.
            # LIKE의 `_`는 단일문자 와일드카드라 ESCAPE 필수.
            "  AND p.slug != 'content/index' "
            "  AND p.slug NOT LIKE 'content/\\_index/%' ESCAPE '\\' "
            "ORDER BY bm25(pages_fts) LIMIT ?",
            (query, top_k),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ────────────────────────── internals ──────────────────────────


def _repo_root() -> Optional[Path]:
    """Locate the raven code repo (parent of `raven/`)."""
    # raven/core/db.py → parents[2] = repo root
    return Path(__file__).resolve().parents[2]


def _run_legacy_build(script: Path, vault: Vault, db_path: Path) -> dict:
    """Invoke scripts/build_db.py with vault path + db output."""
    argv = [sys.executable, str(script), str(vault.root), "--db", str(db_path)]
    env = os.environ.copy()
    env.setdefault("PYTHONPATH", "")
    result = subprocess.run(argv, capture_output=True, text=True, env=env)
    pages = _count_pages(db_path) if result.returncode == 0 else 0
    return {
        "ok": result.returncode == 0,
        "vault": vault.meta.name,
        "db_path": str(db_path),
        "pages": pages,
        "stdout_tail": result.stdout[-500:] if result.stdout else "",
        "stderr_tail": result.stderr[-500:] if result.stderr else "",
        "returncode": result.returncode,
    }


def _count_pages(db_path: Path) -> int:
    """Return indexed page count for a freshly built wiki.db."""
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            row = con.execute("SELECT COUNT(*) FROM pages").fetchone()
            return int(row[0]) if row else 0
        finally:
            con.close()
    except Exception:
        return 0


_INLINE_SCHEMA_SQL = """
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
  page_slug TEXT NOT NULL, tag TEXT NOT NULL,
  PRIMARY KEY (page_slug, tag),
  FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE
);
CREATE INDEX idx_tags_tag ON tags(tag);
CREATE TABLE links (
  source_slug TEXT NOT NULL, target_slug TEXT NOT NULL,
  context TEXT, intent TEXT DEFAULT 'auto',
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
CREATE VIRTUAL TABLE pages_fts USING fts5(slug, title, tags_concat, content, aliases);
CREATE VIEW v_backlinks AS
  SELECT l.target_slug AS slug, l.source_slug, p.title AS source_title,
         p.path AS source_path, l.context
  FROM links l JOIN pages p ON p.slug = l.source_slug;
CREATE VIEW v_pages_with_tags AS
  SELECT p.*, GROUP_CONCAT(t.tag, ',') AS tags_list
  FROM pages p LEFT JOIN tags t ON t.page_slug = p.slug
  GROUP BY p.slug;
"""

_INLINE_EXCLUDED_TOP_DIRS = {"raw", "_archive", "scripts", "node_modules", ".venv", ".git", "dashboard"}


def _inline_build(vault: Vault, db_path: Path) -> dict:
    """Fallback builder used when scripts/build_db.py is unavailable
    (installed-package scenarios without the source `scripts/` dir).

    v0.7.67 (평가 A#8): pre-v0.7.67 this emitted a `pages(slug,title,type,
    path,content)`-only schema — missing `created`/`updated`/`confidence`
    and the `pages_fts`/`links` tables the canonical builder produces.
    Every consumer that assumes the v2.4 schema (index_builder, garden,
    lint, the dashboard's search/graph queries) broke against it. This now
    mirrors scripts/build_db.py's SCHEMA_SQL so the fallback is a real,
    if simpler, subset of the same contract — not a different one. It also
    scans the whole vault (matching the canonical builder's `_meta/`
    inclusion) instead of `content/` only, so lint #11's FS/DB slug parity
    check doesn't false-positive on the fallback path.
    """
    from . import frontmatter as frontmatter_module

    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()
    con = sqlite3.connect(db_path)
    con.executescript(_INLINE_SCHEMA_SQL)
    today = __import__("datetime").date.today().isoformat()
    n_pages = 0
    for fp in vault.root.rglob("*.md"):
        rel_parts = fp.relative_to(vault.root).parts
        if rel_parts and rel_parts[0] in _INLINE_EXCLUDED_TOP_DIRS:
            continue
        if len(rel_parts) == 1 and rel_parts[0] in ROOT_AGENT_INSTRUCTION_FILES:
            continue  # user-owned root instructions, not content pages
        slug = str(fp.relative_to(vault.root))[:-3]
        try:
            text = fp.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta, body = frontmatter_module.parse(text)
        title = str(meta.get("title") or slug.split("/")[-1])
        ptype = str(meta.get("type") or "concept")
        created = str(meta.get("created") or today)
        updated = str(meta.get("updated") or today)
        confidence = meta.get("confidence")
        collection = collection_for_slug(slug)
        status = normalize_status(meta.get("status"))
        aliases = aliases_to_json(meta.get("aliases"))
        con.execute(
            "INSERT INTO pages (slug, title, type, created, updated, path, "
            "confidence, content, raw_content, collection, status, aliases) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (slug, title, ptype, created, updated, str(fp),
             str(confidence) if confidence else None, body, text,
             collection, status, aliases),
        )
        tags = meta.get("tags") or []
        if isinstance(tags, (list, tuple)):
            for tag in tags:
                con.execute(
                    "INSERT OR IGNORE INTO tags (page_slug, tag) VALUES (?,?)",
                    (slug, str(tag)),
                )
        con.execute(
            "INSERT INTO pages_fts (rowid, slug, title, tags_concat, content, aliases) "
            "SELECT (SELECT rowid FROM pages WHERE slug = ?), ?, ?, ?, ?, ?",
            (slug, slug, title, " ".join(str(t) for t in tags) if isinstance(tags, (list, tuple)) else "", body, aliases),
        )
        relations = meta.get("relations") or []
        if isinstance(relations, list):
            import json
            for rel in relations:
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

                con.execute(
                    "INSERT OR REPLACE INTO relations (source_slug, target_slug, relation_type, "
                    "confidence_semantic, confidence_structural, confidence_provenance, "
                    "verified_by, evidence, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (slug, target, rel_type, conf_sem, conf_str, conf_prov, verified_by_str, evidence_str, reason),
                )

        # Raven Product Feedback Brief: this fallback builder used to create
        # the `links` table schema but never populate it — no [[wikilink]]
        # extraction ran here at all, so wiki_graph edges,
        # wiki_get_page backlinks/outbound_links, and the dashboard's
        # orphan-page detection were always empty/wrong for any vault built
        # through this path (e.g. the packaged desktop app, which ships
        # `raven/` without the sibling `scripts/` dir the canonical builder
        # lives in). Mirrors scripts/build_db.py's link extraction exactly.
        for target, intent, context in extract_links(body):
            normalized = target
            if target and not slug_exists(con, target):
                candidate = resolve_short_slug(con, target)
                if candidate:
                    normalized = candidate
            con.execute(
                "INSERT OR REPLACE INTO links (source_slug, target_slug, context, intent) "
                "VALUES (?, ?, ?, ?)",
                (slug, normalized, context, intent),
            )

        n_pages += 1
    con.commit()

    # short-slug 보정 후처리 패스 (scripts/build_db.py와 동일) — 첫 pass에서
    # 아직 INSERT되지 않은 다른 페이지를 가리키는 self-reference race 보정.
    try:
        rows = con.execute("SELECT source_slug, target_slug FROM links").fetchall()
        for src, tgt in rows:
            if slug_exists(con, tgt):
                continue
            candidate = resolve_short_slug(con, tgt)
            if candidate:
                con.execute(
                    "UPDATE links SET target_slug = ? WHERE source_slug = ? AND target_slug = ?",
                    (candidate, src, tgt),
                )
        con.commit()
    except Exception:
        pass

    try:
        from .analytics import update_analytics_properties
        update_analytics_properties(con)
        con.commit()
    except Exception as exc:
        import sys
        sys.stderr.write(f"⚠️  inline analytics update failed: {exc}\n")
    con.close()
    return {"ok": True, "vault": vault.meta.name, "db_path": str(db_path), "pages": n_pages, "returncode": 0, "mode": "inline"}

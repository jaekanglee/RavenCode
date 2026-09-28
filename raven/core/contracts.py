"""contracts.py — single write contract shared by all entrypoints (v0.6.2+).

Why this module exists
----------------------
v0.5.6 changelog §8 P1-1 promised: "write-path 단일화
(`raven.core.contracts.write_page()` 같은 단일 진입 함수로 모든 write path 통합)".

Before v0.6.2, the same 4-step write recipe was duplicated in 4 places:

  - raven/cli/__main__.py:page_new   (slug validate → FM merge → write → log)
  - raven/api/server.py:create_page  (same recipe + extra HTTP exception types)
  - raven/api/server.py:update_page  (same recipe with `created` preservation)
  - a legacy agent adapter write path         (same recipe + agent provenance)

That meant every change to the recipe (e.g. add `confidence` field, change
log format, add telemetry) had to be applied in 4 places — and each one
risked drifting out of sync with the others.

After v0.6.2, the recipe lives in `contracts.write_page()`. Each entrypoint
calls it with its own arguments; the entrypoint-specific concerns
(HTTPException types, typer.Exit codes, agent provenance block) stay at
the boundary layer.

Scope (deliberately limited)
----------------------------
- `write_page()` + `rename_page()`. `delete_page()` is not yet unified
  (archive.py is a richer surface; deferred).
- v0.7.67 (평가 A#1): MCP `wiki_update` now routes through `write_page()`.
  MCP-specific concerns (idempotency cache, advisory locks, response
  shape) stay in `raven/mcp/tools/write.py`; the file mutation itself —
  slug validation, frontmatter merge, provenance, FileLock, log — is
  this contract. `extra_meta` + `append_log` were added for that caller.
- v0.7.68 (평가 B#2): `rename_page()` added — CLI's `page rename` and MCP's
  `wiki_rename` both route the file-move + link-rewrite recipe through
  here. MCP-specific concerns (advisory lock, idempotency, response
  shape) stay in `raven/mcp/tools/write.py`; CLI calls this directly.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import os
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

from . import frontmatter as frontmatter_module
from . import link as link_module
from . import log as log_module
from . import slug as slug_module
from .lock import atomic_write_text, lock_for_file
from .vault import Vault


# ────────────────────────── result type ────────────────────────────


@dataclass(frozen=True)
class WriteResult:
    """Outcome of a `write_page()` call.

    Attributes mirror the keys the entrypoints previously returned so
    callers can swap implementations without changing their return-handling
    code.

    `slug` is the *normalized* slug (after `slug_module.normalize_prefix`)
    so callers can echo back what was actually written — differs from the
    raw input when a short name like `foo` was auto-prefixed to
    `content/foo`.
    """

    ok: bool
    slug: str
    path: Optional[Path] = None
    bytes_written: int = 0
    created: bool = False  # True = new file, False = overwrite
    created_date: Optional[str] = None  # ISO date string, set on new file
    error: Optional[str] = None
    message: str = ""


# SCHEMA.md type 9종 — 제품이 강제하는 page type 계약의 단일 원본.
# 쓰기 검증과 lint #24(운영 지침 계약)가 함께 쓴다.
PAGE_TYPES: frozenset[str] = frozenset({
    "concept", "person", "tool", "comparison", "project", "rule", "query", "journal", "issue",
})


# ────────────────────────── write contract ──────────────────────────


def precondition_for_path(fp: Path) -> str:
    """Token describing a markdown file's current content ("" when absent).

    v0.7.180: derived from the file bytes (sha256). The v0.7.178 token was
    `(st_mtime_ns, st_size)`, which could not tell apart a concurrent write that
    landed inside the same mtime tick with the same byte count — that write was
    silently overwritten. Hashing content answers the question the caller
    actually asks ("did what I read change?") and makes an identical rewrite a
    no-op rather than a conflict.
    """
    try:
        data = fp.read_bytes()
    except OSError:
        return ""
    return f"sha256-{hashlib.sha256(data).hexdigest()[:32]}"


def page_precondition(vault: Vault, slug: str, *, normalize: bool = True) -> str:
    """`precondition_for_path` resolved through slug validation.

    Callers that read-modify-write pass this back as `write_page(precondition=...)`
    so a concurrent write in between is rejected instead of silently overwritten.
    """
    raw_slug = slug if not normalize else slug_module.normalize_prefix(slug)
    try:
        fp = slug_module.validate(raw_slug, vault_root=vault.root).with_suffix(".md")
    except slug_module.SlugError:
        return ""
    return precondition_for_path(fp)


def write_page(
    vault: Vault,
    slug: str,
    content: str,
    *,
    title: Optional[str] = None,
    type: Optional[str] = None,
    tags: Optional[Iterable[str]] = None,
    actor: Optional[object] = None,
    overwrite: bool = True,
    normalize: bool = True,
    body: Optional[str] = None,
    enforce_protected_paths: bool = False,
    extra_meta: Optional[dict] = None,
    append_log: bool = True,
    precondition: Optional[str] = None,
) -> WriteResult:
    """Create or overwrite a markdown page through the shared write contract.

    Steps (identical to the previous inline recipes):
      1. Normalize + validate slug (`slug_module.normalize_prefix` + `validate`).
         Set `normalize=False` to skip auto-prefix (Agent semantics:
         LLM agents should pass explicit `content/...` paths).
      2. Parse existing frontmatter (if any) for `created` preservation.
      3. Merge updates (title/type/tags/updated) + optional agent provenance.
      4. Render markdown + write file.
      5. Append a `log.md` entry (action="create" or "update").

    Args:
        vault: A loaded `Vault` handle.
        slug: User-supplied slug. Short names are auto-prefixed to
            `content/<name>` (matches CLI/API pre-v0.6.2 behavior) unless
            `normalize=False`.
        content: Markdown body. If `body` is also provided, `content`
            wins (callers may pass either).
        title/type/tags: Frontmatter fields. None means "preserve
            existing" (overwrite) or "use defaults" (create).
        actor: Optional agent identity. When provided, an `agents:` block
            is attached to the frontmatter — same shape AgentVault.write
            produced pre-v0.6.2. Accepts a dict (Agent-style provenance
            with `name`/`run_id`/`intent` keys) or any object with a
            `name` attribute (str fallback). `None` skips provenance.
        overwrite: If False and the target file already exists, returns
            `WriteResult(ok=False, error="exists")` without touching the
            filesystem. Matches CLI/API pre-v0.6.2 "create-only" semantics.
        normalize: If False, skip `slug_module.normalize_prefix` (Agent
            entrypoint semantics — bare `hello` lands at vault root).
        body: Legacy alias for `content`; `content` takes precedence.
        extra_meta: Optional dict of additional frontmatter fields
            (e.g. MCP `frontmatter_data`). Merged into the update set
            BEFORE the explicit `title`/`type`/`tags` kwargs (kwargs win).
            `created`/`updated`/`agents` stay governed by `merge()` rules
            regardless of what this dict contains.
        append_log: If False, skip the log.md append (callers like MCP
            keep their own richer provenance logging — avoids double
            entries).
        precondition: Optional `page_precondition()` token captured when the
            caller read the page. When given and the page's current token
            differs, nothing is written and `error="stale_precondition"` is
            returned — this is what stops a lost update. `""` asserts the page
            does not exist yet. `None` (default) skips the check entirely, so
            existing callers are unaffected.

    Returns:
        WriteResult — `ok=True` on success, `ok=False` + `error` on
        validation failure (slug error, exists-when-overwrite=False, etc).
    """
    if body is not None and content is None:
        content = body

    # ── 0. agents allowlist gate (v0.7.37+)
    # When a vault declares an opt-in `agents` allowlist in .vault.json,
    # only listed actors may write through this contract. Empty allowlist
    # = no policy = always allowed (no behavior change for existing vaults).
    if not vault.write_allowed_for(actor):
        actor_id = actor if isinstance(actor, str) else (
            str(getattr(actor, "name", "anonymous")) if actor is not None else "anonymous"
        )
        return WriteResult(
            ok=False,
            slug=slug,
            error=(
                f"actor {actor_id!r} not in vault's `agents` allowlist "
                f"{list(vault.meta.agents)!r}"
            ),
            message=(
                "v0.7.37+ opt-in policy: vault declared an `agents` "
                "allowlist; this actor is not authorized to write."
            ),
        )

    # ── 1. slug normalize + validate
    raw_slug = slug if not normalize else slug_module.normalize_prefix(slug)
    try:
        safe_path = slug_module.validate(raw_slug, vault_root=vault.root)
    except slug_module.SlugError as e:
        return WriteResult(ok=False, slug=raw_slug, error=f"invalid slug: {e}")

    fp = safe_path.with_suffix(".md")

    try:
        with lock_for_file(vault.root, fp):
            # ── 2. existence check
            if fp.exists() and not overwrite:
                return WriteResult(ok=False, slug=raw_slug, error="exists")

            # ── 2b. precondition (v0.7.178): reject a write whose base state moved.
            # Inside the lock so the compared token cannot change under us.
            if precondition is not None:
                current = precondition_for_path(fp)
                if current != precondition:
                    return WriteResult(
                        ok=False,
                        slug=raw_slug,
                        error="stale_precondition",
                        message=(
                            "페이지가 이 편집을 시작한 뒤 다른 곳에서 변경됐습니다. "
                            "최신 내용을 다시 불러온 뒤 편집을 옮겨 주세요."
                        ),
                    )

            # ── 3. parse existing frontmatter (preserve `created`, `agents`)
            existing_meta: dict = {}
            if fp.exists():
                try:
                    existing_text = fp.read_text(encoding="utf-8")
                    existing_meta, _ = frontmatter_module.parse(existing_text)
                except Exception:
                    # Corrupt frontmatter: treat as empty so the write still
                    # succeeds (matches pre-v0.6.2 AgentVault.write behavior).
                    existing_meta = {}

            today = _dt.date.today().isoformat()
            updates: dict = {"updated": today}
            if extra_meta:
                updates.update(extra_meta)
            if title is not None:
                updates["title"] = title
            if type is not None:
                updates["type"] = type
            if tags is not None:
                updates["tags"] = list(tags)

            # `created` only set on first write (matches API create_page pre-v0.6.2)
            if "created" not in existing_meta:
                updates["created"] = today

            merged = frontmatter_module.merge(existing_meta, updates, today=today)

            # Immutable areas are always read-only for agent-style callers.
            if actor is not None or enforce_protected_paths:
                slug_lower = raw_slug.lower()
                if (
                    slug_lower.startswith("raw/") or
                    slug_lower.startswith("content/raw/") or
                    slug_lower.startswith("_meta/") or
                    slug_lower == "log" or
                    slug_lower == "log.md"
                ):
                    return WriteResult(
                        ok=False,
                        slug=raw_slug,
                        error="permission_denied",
                        message="raw/, _meta/, log.md 는 불변/보호 영역이므로 에이전트가 수정할 수 없습니다."
                    )
            # Strict Schema & WIP guardrail check for agents in LLM Wiki vaults.
            if vault.is_llm_wiki and actor is not None:
                missing = validate_gardening_schema(vault, raw_slug, content or "", merged)
                if missing:
                    return WriteResult(
                        ok=False,
                        slug=raw_slug,
                        error="strict_schema_violated",
                        message=(
                            "WIP가 아닌 메인 content/ 페이지는 Frontmatter와 규약을 완전히 갖춰야 합니다. "
                            f"누락된 항목: {', '.join(missing)}. "
                            "임시 작업은 content/wip/ 아래에 작성해 주세요."
                        )
                    )

            # Optional agent provenance — matches AgentVault.write pre-v0.6.2 shape.
            # Stored as list-of-dict so frontmatter_module.render serializes it as
            # a YAML list (matches the YAML format pre-v0.6.2 produced).
            if actor is not None:
                provenance_list = list(merged.get("agents") or [])
                if isinstance(actor, dict):
                    entry = dict(actor)
                elif hasattr(actor, "__dict__"):
                    entry = {k: v for k, v in vars(actor).items() if not k.startswith("_")}
                else:
                    entry = {"name": str(actor)}
                if "timestamp" not in entry:
                    entry["timestamp"] = _dt.datetime.now().isoformat()
                provenance_list.append(entry)
                merged["agents"] = provenance_list

            # ── 4. render + write
            # `frontmatter.render` expects `agents` as a separate kwarg (rendered
            # as a YAML list block), not as a meta dict entry (which would be
            # serialized via Python repr).
            agents_list: Optional[list[dict]] = None
            if actor is not None:
                # We've already appended into merged["agents"] above — extract it
                # back out for the dedicated render path.
                agents_list = merged.pop("agents", None)
            rendered = frontmatter_module.render(merged, content or "", agents=agents_list)
            atomic_write_text(fp, rendered)

            is_create = not existing_meta  # empty parsed meta ⇒ new file

            # ── 5. log.md append (best-effort; matches pre-v0.6.2 try/except wrap)
            if append_log:
                try:
                    actor_name = ""
                    if isinstance(actor, dict):
                        name_val = actor.get("name")
                        if isinstance(name_val, str):
                            actor_name = name_val
                    log_module.append(
                        vault,
                        action="create" if is_create else "update",
                        subject=raw_slug,
                        files=[raw_slug],
                        note=f"actor={actor_name}" if actor_name else "",
                    )
                except Exception:
                    pass
    except TimeoutError as exc:
        return WriteResult(
            ok=False,
            slug=raw_slug,
            error=f"concurrency lock timeout: {exc}",
            message=f"failed to write {raw_slug} due to lock timeout",
        )

    return WriteResult(
        ok=True,
        slug=raw_slug,
        path=fp,
        bytes_written=len(rendered),
        created=is_create,
        created_date=merged.get("created"),
        message=f"wrote {raw_slug}",
    )


@dataclass(frozen=True)
class RenameResult:
    """Outcome of a `rename_page()` call. Mirrors `WriteResult`'s shape."""

    ok: bool
    old_slug: str
    new_slug: str
    rewritten_files: int = 0
    error: Optional[str] = None
    message: str = ""


def _resolve_page_path(vault: Vault, slug: str) -> Path:
    s = slug.strip()
    if s.lower().endswith(".md"):
        s = s[:-3]
    safe = slug_module.validate(s, vault_root=vault.root)
    return safe.with_suffix(".md")


def rename_page(
    vault: Vault,
    old_slug: str,
    new_slug: str,
    *,
    actor: Optional[str] = None,
) -> RenameResult:
    """Rename a slug, rewrite every inbound wikilink, through the shared contract.

    Steps: 1) validate both slugs, 2) update frontmatter (`slug`/`aliases`/
    `agents`) and move the file, 3) rewrite `[[old_slug]]` → `[[new_slug]]`
    across the vault (`link_module.rewrite_links`).

    Does NOT rebuild wiki.db — callers rebuild explicitly, same as
    `write_page()`. Does NOT touch MCP's advisory locks/idempotency — those
    stay in `raven/mcp/tools/write.py`. DOES take the same core `FileLock`
    `write_page()` uses (both old_path and new_path, sorted to avoid
    lock-order deadlocks) so CLI/MCP renames are mutually exclusive with
    any other write touching either path.
    """
    if not old_slug or not new_slug:
        return RenameResult(
            ok=False, old_slug=old_slug, new_slug=new_slug,
            message="old_slug and new_slug are required",
        )

    try:
        old_path = _resolve_page_path(vault, old_slug)
        new_path = _resolve_page_path(vault, new_slug)
    except slug_module.SlugError as e:
        return RenameResult(
            ok=False, old_slug=old_slug, new_slug=new_slug,
            message=f"invalid slug: {e}", error="invalid_slug",
        )

    try:
        with ExitStack() as locks:
            for p in sorted({old_path, new_path}, key=str):
                locks.enter_context(lock_for_file(vault.root, p))

            if not old_path.exists():
                return RenameResult(
                    ok=False, old_slug=old_slug, new_slug=new_slug,
                    message=f"{old_slug} not found",
                )
            if new_path.exists() and new_path != old_path:
                return RenameResult(
                    ok=False, old_slug=old_slug, new_slug=new_slug,
                    message=f"{new_slug} already exists",
                )

            text = old_path.read_text(encoding="utf-8")
            meta, body = frontmatter_module.parse(text)

            meta["slug"] = new_slug
            aliases = list(meta.get("aliases") or [])
            if old_slug not in aliases:
                aliases.insert(0, old_slug)
            meta["aliases"] = aliases
            meta["updated"] = _dt.date.today().isoformat()
            agents_hist = list(meta.get("agents") or [])
            agents_hist.append({
                "name": actor or "anonymous",
                "timestamp": _dt.datetime.now().isoformat(),
                "intent": f"rename {old_slug} -> {new_slug}",
            })
            meta.pop("agents", None)

            rendered = frontmatter_module.render(meta, body, agents=agents_hist)
            new_path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_text(new_path, rendered)

            if old_path != new_path:
                old_path.unlink()

            rewritten = link_module.rewrite_links(vault, old_slug, new_slug)
    except TimeoutError as exc:
        return RenameResult(
            ok=False, old_slug=old_slug, new_slug=new_slug,
            message=f"concurrency lock timeout: {exc}",
        )

    return RenameResult(
        ok=True, old_slug=old_slug, new_slug=new_slug,
        rewritten_files=rewritten,
        message=f"renamed {old_slug} → {new_slug} ({rewritten} wikilinks rewritten)",
    )


def validate_gardening_schema(vault, slug: str, content: str, meta: dict) -> list[str]:
    """Validate the minimal metadata required for agent writes.
    Returns a list of missing items (empty if valid).
    """
    slug_lower = slug.lower()
    if (
        slug_lower.startswith("content/wip/") or 
        slug_lower.startswith("content/scratch/") or 
        slug_lower.startswith("wip/") or 
        slug_lower.startswith("scratch/") or
        slug_lower.startswith("_meta/")
    ):
        return []

    missing = []
    
    # 1. Check type
    ptype = (meta.get("type") or "").strip().lower()
    if not ptype or ptype not in PAGE_TYPES:
        missing.append("올바른 type (frontmatter)")
        return missing

    # Human-first contract: keep write-time validation minimal.
    # Richer writing guidance is advisory in agent/SCHEMA.md and lint info.
    return missing

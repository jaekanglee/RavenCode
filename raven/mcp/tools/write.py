"""write.py — 2 mutating MCP tools (require --write).

Tools:
    wiki_update — overwrite a markdown file (frontmatter-aware)
    wiki_ingest — turn a raw source into a vault page (lightweight)

NOTE: this module does NOT touch git. The orchestrator (Hermes) commits
the diff after a batch of writes. Tools only mutate files.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path
from typing import Optional

from raven.core import archive as archive_module
from raven.core import db as core_db
from raven.core import frontmatter as core_frontmatter
from raven.core import slug as slug_module
from raven.core.contracts import rename_page, write_page
from raven.core.registry import VaultMeta
from raven.core.vault import Vault
from raven.mcp import db
from raven.mcp.tools import (
    VaultContext,
    append_log_entry,
    check_lock,
    check_permission,
    lookup_idempotent,
    normalize_actor,
    now_iso,
    record_idempotent,
)


# ─────────────── shared helpers ───────────────


def _load_vault(vault_path: Path) -> Vault:
    """Load a Vault handle honoring the vault's own ``.vault.json``.

    v0.7.67 (평가 A#1): pre-v0.7.67 MCP built ``Vault(meta=VaultMeta(...))``
    with default (empty) fields, silently bypassing the vault's opt-in
    ``agents`` write allowlist. Reading ``.vault.json`` restores the same
    policy surface CLI/API see.
    """
    import json as _json

    data: dict = {}
    vf = vault_path / ".vault.json"
    if vf.exists():
        try:
            data = _json.loads(vf.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    data.setdefault("path", str(vault_path))
    meta = VaultMeta.from_json(vault_path.name, data)
    return Vault.load(meta)


def _strip_md_suffix(slug: str) -> str:
    """``"concepts/wiki.md"`` → ``"concepts/wiki"`` (idempotent)."""
    s = slug.strip()
    return s[:-3] if s.lower().endswith(".md") else s


def _resolve_md_path(vault: Path, slug: str) -> Path:
    """Resolve a slug to a **validated** absolute markdown path.

    The slug may be a vault-relative path with or without the .md suffix
    (e.g. ``"concepts/wiki"`` or ``"_meta/system/SCHEMA.md"``).

    v0.7.67 (평가 A#1): now routes through ``raven.core.slug.validate`` —
    pre-v0.7.67 this was a bare ``vault / slug`` join, so ``../`` or an
    absolute path escaped the vault entirely.

    Raises:
        slug_module.SlugError: unsafe slug (traversal, absolute, NUL, …).
    """
    safe = slug_module.validate(_strip_md_suffix(slug), vault_root=vault)
    return safe.with_suffix(".md")


def _is_immutable_agent_path(slug: str) -> bool:
    """Return True when the slug points at a protected agent read-only area."""
    normalized = slug.strip().lower()
    if normalized.endswith(".md"):
        normalized = normalized[:-3]
    return (
        normalized == "log" or
        normalized.startswith("raw/") or
        normalized.startswith("content/raw/") or
        normalized.startswith("_meta/")
    )


def _rebuild_db(vault: Path) -> None:
    """Rebuild wiki.db so it reflects on-disk changes.

    v0.7.67 (평가 A#2): pre-v0.7.67 looked for ``<vault>/scripts/build_db.py``
    — a path that only exists when the vault *is* the raven source repo.
    Every normal user vault (``~/Raven/<name>/``) has no ``scripts/`` dir,
    so this was a silent, permanent no-op: MCP delete/rename claimed to
    rebuild the index but never did, leaving wiki.db (search/graph/backlinks)
    stale after every MCP write. Routes through the same
    ``raven.core.db.build_db`` CLI/API use instead.

    Best-effort: prints to stderr on failure but does not raise (admin
    operations should succeed even if DB rebuild fails — the caller can
    manually rerun build_db later).
    """
    try:
        vault_obj = _load_vault(vault)
        # 내용 수정은 그 페이지만 증분 색인, 생성·삭제·이름 변경은 자동으로 전체 빌드.
        core_db.build_db(vault_obj, run_lint=False, incremental=True)
    except Exception as e:
        sys.stderr.write(f"⚠️  wiki.db rebuild failed: {e}\n")


# ─────────────── M4 / F1 — provenance + idempotency ───────────────
#
# The four write tools all follow the same shape:
#
#   1. normalize actor
#   2. check idempotency_key (short-circuit if already executed)
#   3. do the actual write (page archive / frontmatter rewrite / etc.)
#   4. attach actor/idempotency_key/timestamp to the response
#   5. record provenance in log.md
#   6. persist idempotency cache for future retries
#
# Steps 1, 2, 4, 5, 6 are tool-agnostic and live in helpers below.
# Step 3 — the real work — is intentionally untouched per F1 spec.

# Common response keys attached to every successful write. Tools merge
# these into their existing return dicts so README.md §8 ("additive-only
# response keys") is honored.
_PROVENANCE_KEYS = ("actor", "idempotency_key", "timestamp")


def _attach_provenance(
    response: dict,
    *,
    actor: str,
    idempotency_key: Optional[str],
    timestamp: Optional[str] = None,
) -> dict:
    """Return a copy of ``response`` with provenance keys attached."""
    out = dict(response)
    out["actor"] = actor
    out["idempotency_key"] = idempotency_key
    out["timestamp"] = timestamp or now_iso()
    return out


def _resolve_idempotency(
    *,
    tool: str,
    vault: Path,
    idempotency_key: Optional[str],
    params: dict,
    actor: str,
):
    """Idempotency precheck.

    Returns ``(cached_response, fingerprint_params)`` where ``cached_response``
    is one of:

      * ``None`` — first call for this key, proceed normally
      * a ``dict`` — the cached response from a previous successful call;
        attach provenance (so the caller sees actor/key/timestamp even
        on a retry) and return immediately
      * a dict with ``"_idempotency_conflict": True`` — the same key was
        used for a *different* write; fail-closed with a clear message

    ``fingerprint_params`` is the params dict the caller should pass into
    ``record_idempotent`` after a successful write (typically the same as
    the input ``params``).
    """
    cached = lookup_idempotent(vault, idempotency_key, tool, params)
    if cached is None:
        return None, params
    if cached.get("_idempotency_conflict"):
        stored = cached.get("stored", {})
        return {
            "ok": False,
            "message": (
                f"idempotency_key {idempotency_key!r} was previously used "
                f"for tool={stored.get('tool')!r} at {stored.get('timestamp')!r}; "
                "refusing to silently reuse it for a different write"
            ),
            "_idempotency_conflict": True,
            "stored": stored,
            "actor": actor,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
        }, params
    # Hit: re-emit cached response with current actor/timestamp attached
    # so callers always see provenance keys. Mark with _idempotent_replay
    # so callers can tell a retry from a fresh write.
    replay = _attach_provenance(
        cached,
        actor=actor,
        idempotency_key=idempotency_key,
    )
    replay["_idempotent_replay"] = True
    return replay, params


# ─────────────── M5 / F4 — advisory concurrency lock ───────────────
#
# M4/F1 attaches actor/idempotency_key/timestamp via ``_attach_provenance``.
# M5/F4 adds ``_lock_holder``: a non-blocking advisory read of any active
# lock on the slugs this write is about to touch. The write proceeds
# regardless (F4 is advisory per README.md §3); the caller sees
# ``_lock_holder`` (with ``_advisory_conflict`` if a different actor
# holds the claim) and decides whether to back off.
#
# Helpers in this section are read-only — ``acquire_lock`` itself is
# exposed in mcp.tools and is the caller's job when they want to *claim*
# a slug before editing. A write tool just *reports* the current state.


def _attach_lock_holder(
    response: dict,
    *,
    vault: Path,
    slugs: list[str],
    actor: str,
) -> dict:
    """Return a copy of ``response`` with ``_lock_holder`` attached.

    Walks ``slugs`` in order and reports the *first* non-self, non-expired
    lock it finds. "Self" here means the holder's actor equals the
    caller — re-acquiring your own lock is fine, we don't want every
    edit to look like a conflict.

    Returns the response unchanged when no advisory conflict exists.
    """
    for slug in slugs:
        if not slug:
            continue
        holder = check_lock(vault, slug)
        if holder is None:
            continue
        if holder.get("actor") == actor:
            # Our own claim — not a conflict, just metadata.
            response["_lock_holder"] = holder
            response["_lock_holder"]["_advisory_conflict"] = False
            response["_lock_holder"]["_self"] = True
            return response
        # Foreign actor — this is the F4 advisory case.
        response["_lock_holder"] = holder
        # holder already carries ``_advisory_conflict: True`` from
        # ``check_lock``; we re-state it at the response level so a
        # shallow ``if resp.get("_advisory_conflict")`` check still
        # works without descending into the lock dict.
        response["_advisory_conflict"] = True
        response["_lock_holder"]["_self"] = False
        return response
    # No active lock on any slug → explicit None so callers don't have
    # to special-case missing vs empty.
    response["_lock_holder"] = None
    return response


def _finalize_write(
    *,
    tool: str,
    vault: Path,
    action: str,
    subject: str,
    actor: str,
    idempotency_key: Optional[str],
    params: dict,
    response: dict,
    extras: Optional[list[str]] = None,
    skip_idempotency_record: bool = False,
    slugs: Optional[list[str]] = None,
) -> dict:
    """Post-write bookkeeping.

    Attaches provenance, reads the advisory lock state on ``slugs``,
    appends the log entry, persists the idempotency record (unless the
    caller is on the cached-replay path). Returns the augmented response
    dict.

    The ``slugs`` arg is the F4 hook — callers pass the slugs their write
    touched (one for update/ingest/delete, two for rename). When omitted,
    no lock probe is performed (preserves pre-F4 behavior for any
    existing caller that hasn't been migrated).
    """
    response = _attach_provenance(
        response, actor=actor, idempotency_key=idempotency_key
    )
    if slugs:
        # F4: read-only advisory lock check. The write has already
        # succeeded by this point; we just surface the conflict for the
        # caller to see.
        response = _attach_lock_holder(
            response, vault=vault, slugs=list(slugs), actor=actor,
        )
    # Skip the log append on cached replays — re-executing an idempotent
    # write should not produce a second provenance entry.
    if not response.get("_idempotent_replay"):
        log_ok = append_log_entry(
            vault, action=action, subject=subject,
            actor=actor, idempotency_key=idempotency_key, extras=extras,
        )
        response["log_appended"] = log_ok
        if not skip_idempotency_record:
            record_idempotent(vault, idempotency_key, tool, params, response)
    else:
        response["log_appended"] = False
    return response


# ─────────────── 6. wiki_update ───────────────


def wiki_update(
    slug: str,
    content: str,
    frontmatter_data: Optional[dict] = None,
    ctx: Optional[VaultContext] = None,
    actor: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    summary: Optional[str] = None,
    reason: Optional[str] = None,
    precondition: Optional[str] = None,
) -> dict:
    """Update (or create) a markdown page by slug.

    Args:
        slug: vault slug (e.g. ``"concepts/wiki"``, ``"SCHEMA"``,
              ``"_meta/system/SCHEMA.md"``). Top-level slugs (no ``/``) are
              allowed — the file simply lives at the vault root.
        content: raw markdown body. 선두에 frontmatter 블록(``---``)이 있으면
            본문에 남기지 않고 메타로 승격해 검증에 사용한다 (v0.7.66+).
        frontmatter_data: optional dict to serialize as YAML frontmatter
        ctx: VaultContext; defaults to read/write/admin per the CLI
        actor: optional caller identity (M4/F1 provenance). Defaults to
            ``"anonymous"`` when omitted.
        idempotency_key: optional retry-suppression key (M4/F1). Re-running
            a write with the same key + same parameters returns the cached
            response without touching the file. Reusing a key with
            *different* parameters fails closed with an ``ok=False`` reply.

    Returns:
        ``{"ok": bool, "message": str, "path": str, "actor": str,
            "idempotency_key": str|None, "timestamp": str}``
    """
    ctx = ctx or VaultContext(vault=db._default_vault())
    ctx.require("wiki_update")  # raises if read mode

    # M3 fix (was: rejected any slug without "/"). We now only require
    # *some* non-empty slug — top-level pages (e.g. SCHEMA.md) are valid.
    if not slug:
        return {
            "ok": False,
            "message": "slug required", "path": "",
            "actor": normalize_actor(actor),
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
        }

    actor_norm = normalize_actor(actor)
    vault_path = Path(ctx.vault).expanduser()

    # Idempotency precheck. Only meaningful when the file exists — a fresh
    # create (upsert, v0.7.66+) should run the schema guard instead of
    # replaying a cached response for a file that no longer exists.
    try:
        abs_path = _resolve_md_path(vault_path, slug)
    except slug_module.SlugError as e:
        return {
            "ok": False,
            "message": f"invalid slug: {e}",
            "path": "",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "invalid_slug",
        }
    if _is_immutable_agent_path(slug):
        rel = abs_path.relative_to(vault_path)
        # v0.7.107+ (G5 audit log, PWW §8.4): permission_denied와 별개로
        # 시도 자체를 log.md에 audit 레코드 append (north star "원문 보존" 직접 보호).
        # append()는 9종 action enum — "chore"로 audit 의미 표기 (raw file append).
        try:
            log_path = vault_path / "log.md"
            if log_path.exists():
                ts = now_iso()
                actor = actor_norm or "unknown"
                audit_line = (
                    f"\n## [{ts[:10]}] chore | audit blocked write: {rel} "
                    f"(actor={actor}, slug={slug}, result=permission_denied)\n"
                )
                with log_path.open("a", encoding="utf-8") as f:
                    f.write(audit_line)
        except Exception:
            pass  # audit 실패는 본 동작을 막지 않음
        return {
            "ok": False,
            "message": (
                f"{rel} is read-only for agents. "
                "raw/, _meta/, and log.md must not be updated via wiki_update."
            ),
            "path": str(rel),
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "permission_denied",
        }
    if idempotency_key and abs_path.exists():
        cached, _ = _resolve_idempotency(
            tool="wiki_update", vault=vault_path,
            idempotency_key=idempotency_key, actor=actor_norm,
            params={
                "slug": slug, "content": content,
                "frontmatter_data": frontmatter_data,
                "summary": summary, "reason": reason,
            },
        )
        if cached is not None:
            return cached

    holder = check_lock(vault_path, slug)
    if holder and holder.get("actor") != actor_norm:
        return {
            "ok": False,
            "message": f"Lock conflict: page '{slug}' is currently locked by agent '{holder['actor']}'. Please wait or release the lock.",
            "path": slug,
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "lock_conflict",
            "_lock_holder": holder,
        }

    # v0.7.69+ Plan B-2 (ADR-2026-07-06 §1.3): 본문 50%+ 재작성 가드 (1.5배 임계값).
    # north star "원문 보존 + 증분 누적만 ⭕"의 실행 가드. False positive 회피:
    # - 신규 생성(creating=True)은 본문 0→N이므로 가드 우회
    # - 사용자 force=True 옵션 시 가드 우회 (다음 사이클)
    creating = not abs_path.exists()
    if not creating:
        try:
            existing_text = abs_path.read_text(encoding="utf-8")
            _existing_fm, existing_body = core_frontmatter.parse(existing_text)
        except (OSError, UnicodeDecodeError):
            existing_body = ""
        existing_len = len(existing_body.strip())
        new_len = len(content.strip())
        if existing_len > 0 and new_len > existing_len * 1.5:
            return {
                "ok": False,
                "message": (
                    f"Large rewrite rejected (ADR-2026-07-06 §1.3: 본문 50%+ 재작성 금지). "
                    f"existing={existing_len} chars, new={new_len} chars "
                    f"({new_len / existing_len:.1f}x). Use partial update 또는 split/merge 우회."
                ),
                "path": slug,
                "actor": actor_norm,
                "idempotency_key": idempotency_key,
                "timestamp": now_iso(),
                "error": "large_rewrite_blocked",
                "_existing_len": existing_len,
                "_new_len": new_len,
            }

    # v0.7.66 (평가 P0#2): 신규 slug는 upsert로 생성한다. raw/, _meta/, log.md는
    # 위 immutable 가드가 이미 차단하고, is_llm_wiki vault면 스키마 검증을
    # 통과해야 실제 파일이 생긴다. (구 동작은 "Use wiki_ingest for new pages"로
    # 안내했으나 wiki_ingest는 raw/ 전용 + 사람 명시 명령 필수라 모순 — ADR-2026-07-02)
    creating = not abs_path.exists()

    # v0.7.66 (평가 P0#3): content 선두의 frontmatter 블록은 본문이 아니라 메타.
    # 승격하지 않으면 검증은 기존 메타로 통과하면서 블록이 본문에 이중 기록되어
    # SoT가 조용히 오염된다.
    embedded_meta: dict = {}
    stripped = content.lstrip()
    if stripped.startswith("---\n"):
        emb_meta, emb_body = core_frontmatter.parse(stripped)
        if emb_meta:
            embedded_meta = emb_meta
            content = emb_body

    # 메타 우선순위: 명시 frontmatter_data > content 임베디드 > 기존 파일.
    # v0.7.67 (평가 A#1): pre-v0.7.67은 frontmatter_data가 기존 메타를 통째로
    # "대체"해 created/기존 tags가 소실됐다. 이제 contracts.write_page의 merge
    # 규칙(created 보존, updated 강제, agents 이력 append)이 적용된다.
    updates_meta: dict = {}
    if frontmatter_data:
        updates_meta = dict(frontmatter_data)
    elif embedded_meta:
        updates_meta = embedded_meta

    # v0.7.67 (평가 A#1): 실제 파일 변형은 모든 진입점이 공유하는 단일 쓰기
    # 계약(contracts.write_page)을 경유한다 — slug 재검증 + FileLock(상호배제)
    # + frontmatter merge + agents: provenance + llm_wiki 스키마 검증까지.
    # MCP 고유 관심사(idempotency/advisory lock/응답 형태)만 이 함수에 남는다.
    vault = _load_vault(vault_path)
    result = write_page(
        vault,
        _strip_md_suffix(slug),
        content,
        actor={"name": actor_norm, "timestamp": now_iso()},
        overwrite=True,
        normalize=False,          # MCP semantics: explicit paths, top-level 허용
        extra_meta=updates_meta,
        append_log=False,         # _finalize_write가 idempotency 인지 로그를 담당
        precondition=precondition,
    )
    if not result.ok:
        return {
            "ok": False,
            "message": result.message or result.error or "write failed",
            "path": str(abs_path.relative_to(vault_path)),
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": result.error,
        }

    rel = abs_path.relative_to(vault_path)
    # v0.7.67 (평가 A#2): pre-v0.7.67 wiki_update never rebuilt wiki.db —
    # only wiki_delete/wiki_rename tried (and failed, see _rebuild_db).
    # A page written via MCP would be invisible to wiki_search/wiki_get_page
    # (DB-backed reads) until a manual `raven build`.
    _rebuild_db(vault_path)
    response = {
        "ok": True,
        "message": f"{'created' if creating else 'updated'} {rel}",
        "path": str(rel),
        "rewritten_files": 0,
    }
    return _finalize_write(
        tool="wiki_update", vault=vault_path, action="create" if creating else "update",
        subject=summary.strip() if summary and summary.strip() else str(rel), actor=actor_norm,
        idempotency_key=idempotency_key,
        params={"slug": slug, "content": content,
                "frontmatter_data": frontmatter_data,
                "summary": summary, "reason": reason},
        response=response,
        extras=[f"path: {rel}"] + ([f"reason: {reason.strip()}"] if reason and reason.strip() else []),
        slugs=[slug],
    )


# ─────────────── 7. wiki_ingest ───────────────


def wiki_ingest(
    source: str,
    project: Optional[str] = None,
    mode: str = "auto",
    ctx: Optional[VaultContext] = None,
    actor: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    # v0.7.55+, ADR-2026-07-02: raw/ 폴더는 사람 1차 운영 영역.
    # 에이전트가 자율로 wiki_ingest를 호출하면 source of truth가 변조될 수 있으므로
    # 사람 운영자의 명시 명령이 있을 때만 허용.
    user_command: bool = False,
) -> dict:
    """Ingest a raw source into the vault.

    Args:
        source: absolute path to a file under <vault>/raw/ (or a string
                of raw text when source ends with ':::').
        project: optional project tag (added to frontmatter)
        mode: "auto" → write to raw/<project>/ if not yet present,
              "force" → always overwrite
        ctx: VaultContext
        actor: optional caller identity (M4/F1 provenance). Defaults to
            ``"anonymous"`` when omitted.
        idempotency_key: optional retry-suppression key (M4/F1). Re-running
            a write with the same key + same parameters returns the cached
            response without touching the file. Reusing a key with
            *different* parameters fails closed with an ``ok=False`` reply.
        user_command: v0.7.55+, **필수**. 사람 운영자의 명시적 명령이 있음을
            선언. False (기본값)이면 에이전트 자율 호출로 간주하고 거부.
            CLI `raven raw ingest ...` 등 사람이 직접 호출하는 경로에서만
            `user_command=True`로 설정.

    Returns:
        ``{"ok": bool, "message": str, "pages_created": int,
            "pages_updated": int, "actor": str,
            "idempotency_key": str|None, "timestamp": str}``

    v0.7.55+ 권한 (ADR-2026-07-02):
        - 사람 (CLI/Dashboard 직접 호출): user_command=True로 호출 가능
        - 에이전트 (MCP wiki_ingest 자동 호출): user_command=False로 거부
    """
    ctx = ctx or VaultContext(vault=db._default_vault())
    ctx.require("wiki_ingest")

    # v0.7.55+: raw/ 쓰기 = 사람 1차 권한. 에이전트 자율 호출 차단.
    if not user_command:
        return {
            "ok": False,
            "message": (
                "wiki_ingest requires user_command=True (ADR-2026-07-02). "
                "raw/ is human-first; agent-driven ingest is blocked to prevent "
                "source-of-truth mutation. Call via `raven raw ingest` (CLI) or "
                "Dashboard /raw panel with explicit user authorization."
            ),
            "error": "user_command_required",
            "pages_created": 0,
            "pages_updated": 0,
            "actor": normalize_actor(actor) if actor else "anonymous",
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
        }

    actor_norm = normalize_actor(actor)
    provenance = {
        "actor": actor_norm,
        "idempotency_key": idempotency_key,
        "timestamp": now_iso(),
    }
    fail = lambda msg, **kw: {  # noqa: E731
        "ok": False, "message": msg,
        "pages_created": 0, "pages_updated": 0,
        **provenance, **kw,
    }

    # M3 fix: callers sometimes pass VaultContext(vault="~/wiki") as a str.
    # Normalize to Path before any / operator, otherwise `str / "raw"`
    # raises TypeError on Py 3.11+.
    vault_path = Path(ctx.vault).expanduser()
    raw_root = vault_path / "raw"
    if not raw_root.exists():
        return fail(f"raw/ does not exist at {raw_root}")

    src_path = Path(source).expanduser()
    if not src_path.is_absolute():
        src_path = vault_path / source

    if not src_path.exists():
        return fail(f"source not found: {source}")

    # Decide destination under raw/<project>/<basename>
    project_dir = raw_root / (project or "default")
    project_dir.mkdir(parents=True, exist_ok=True)
    dest = project_dir / src_path.name

    # Idempotency precheck — only when the destination already exists,
    # because wiki_ingest already short-circuits re-ingestion in that
    # case. We layer our cache on top: the cached response takes priority
    # over the file-system "already exists" branch.
    ingest_params = {
        "source": str(src_path), "project": project,
        "mode": mode,
    }
    if idempotency_key and dest.exists():
        cached, _ = _resolve_idempotency(
            tool="wiki_ingest", vault=vault_path,
            idempotency_key=idempotency_key, actor=actor_norm,
            params=ingest_params,
        )
        if cached is not None:
            return cached

    dest_slug = f"raw/{project or 'default'}/{src_path.name}"
    holder = check_lock(vault_path, dest_slug)
    if holder and holder.get("actor") != actor_norm:
        return {
            "ok": False,
            "message": f"Lock conflict: raw path '{dest_slug}' is currently locked by agent '{holder['actor']}'. Please wait or release the lock.",
            "pages_created": 0,
            "pages_updated": 0,
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "lock_conflict",
            "_lock_holder": holder,
        }

    if dest.exists() and mode != "force":
        response = {
            "ok": True,
            "message": f"already ingested at {dest.relative_to(vault_path)} (use mode=force to overwrite)",
            "pages_created": 0,
            "pages_updated": 0,
        }
        # No actual copy happened — skip log/idempotency to avoid spurious
        # provenance on a no-op. Still return provenance keys so callers
        # see them.
        return _attach_provenance(response, actor=actor_norm,
                                   idempotency_key=idempotency_key)

    shutil.copy2(src_path, dest)
    response = {
        "ok": True,
        "message": f"ingested to {dest.relative_to(vault_path)}",
        "pages_created": 1,
        "pages_updated": 0,
    }
    return _finalize_write(
        tool="wiki_ingest", vault=vault_path, action="ingest",
        subject=str(dest.relative_to(vault_path)),
        actor=actor_norm, idempotency_key=idempotency_key,
        params=ingest_params, response=response,
        extras=[f"source: {src_path.name}",
                f"project: {project or 'default'}"],
        slugs=[f"raw/{project or 'default'}/{src_path.name}"],
    )


# ─────────────── 8. wiki_delete (admin) ───────────────


def wiki_delete(
    slug: str,
    ctx: Optional[VaultContext] = None,
    actor: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """Delete a vault page by archiving it to ``_archive/``.

    The page is moved to ``_archive/<original-nested-path>-YYYYMMDD-HHMMSS.md``,
    mirroring its original path (never permanently destroyed — git + archive
    both retain history). ``wiki.db`` is then rebuilt so backlinks and search
    reflect the new state.

    v0.7.67 (평가 B#5): now routes through ``core.archive.archive_page`` — the
    same recipe CLI/API use. Pre-v0.7.67 this flattened the archive path
    (``_archive/<stem>-<ts>.md``), which broke ``restore_archived()`` for
    any nested page (it would restore to vault-root instead of the original
    nested slug).

    Args:
        slug: vault slug (e.g. ``"concepts/wiki"``)
        ctx: VaultContext (must be ``admin`` mode)
        actor: optional caller identity (M4/F1 provenance). Defaults to
            ``"anonymous"`` when omitted.
        idempotency_key: optional retry-suppression key (M4/F1). Re-running
            a write with the same key + same parameters returns the cached
            response without re-archiving. Reusing a key with *different*
            parameters fails closed with an ``ok=False`` reply.

    Returns:
        ``{"ok": bool, "message": str, "archived": str|None,
            "rewritten_files": int, "actor": str,
            "idempotency_key": str|None, "timestamp": str}``
    """
    ctx = ctx or VaultContext(vault=db._default_vault(), mode="admin")
    ctx.require("wiki_delete")

    actor_norm = normalize_actor(actor)
    provenance = {
        "actor": actor_norm,
        "idempotency_key": idempotency_key,
        "timestamp": now_iso(),
    }
    fail = lambda msg, **kw: {  # noqa: E731
        "ok": False, "message": msg,
        "archived": None, "rewritten_files": 0,
        **provenance, **kw,
    }

    if not slug:
        return fail("slug required")

    vault_path = Path(ctx.vault).expanduser()
    try:
        abs_path = _resolve_md_path(vault_path, slug)
    except slug_module.SlugError as e:
        return fail(f"invalid slug: {e}", error="invalid_slug")

    # Idempotency precheck. Run even when the file is missing: a retry of
    # a successful archive should still return the cached "ok=True"
    # response, not the fresh "not found" branch.
    if idempotency_key:
        cached, _ = _resolve_idempotency(
            tool="wiki_delete", vault=vault_path,
            idempotency_key=idempotency_key, actor=actor_norm,
            params={"slug": slug},
        )
        if cached is not None:
            return cached

    holder = check_lock(vault_path, slug)
    if holder and holder.get("actor") != actor_norm:
        return {
            "ok": False,
            "message": f"Lock conflict: page '{slug}' is currently locked by agent '{holder['actor']}'. Please wait or release the lock.",
            "archived": None,
            "rewritten_files": 0,
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "lock_conflict",
            "_lock_holder": holder,
        }

    if not abs_path.exists():
        return fail(f"{slug} not found")

    vault = _load_vault(vault_path)
    archived = archive_module.archive_page(vault, _strip_md_suffix(slug), actor=actor_norm)
    if not archived.ok:
        return fail(archived.error or "archive failed")
    _rebuild_db(vault_path)

    response = {
        "ok": True,
        "message": f"archived {slug} → {archived.archived_to}",
        "archived": archived.archived_to,
        "rewritten_files": 0,
    }
    return _finalize_write(
        tool="wiki_delete", vault=vault_path, action="archive",
        subject=slug, actor=actor_norm, idempotency_key=idempotency_key,
        params={"slug": slug}, response=response,
        extras=[f"archived_to: {archived.archived_to}"],
        slugs=[slug],
    )


# ─────────────── 9. wiki_rename (admin) ───────────────


def wiki_rename(
    old_slug: str,
    new_slug: str,
    ctx: Optional[VaultContext] = None,
    actor: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """Rename a slug and rewrite every inbound ``[[old_slug]]`` wikilink.

    Steps:
        1. Locate ``<old>.md`` under the vault.
        2. Update its frontmatter ``slug:`` field (if present) to ``new_slug``
           and add ``aliases: [<old_slug>]`` so old links continue to resolve.
        3. Move the file to ``<new>.md``.
        4. Walk every other markdown file in the vault and rewrite
           ``[[old_slug]]`` → ``[[new_slug]]`` (preserving intent
           suffixes ``!`` / ``?``).
        5. Rebuild ``wiki.db`` so backlinks/search reflect the rename.

    Args:
        old_slug: current vault slug (file must exist)
        new_slug: target vault slug (file must NOT exist)
        ctx: VaultContext (must be ``admin`` mode)
        actor: optional caller identity (M4/F1 provenance). Defaults to
            ``"anonymous"`` when omitted.
        idempotency_key: optional retry-suppression key (M4/F1). Re-running
            a write with the same key + same parameters returns the cached
            response without re-renaming. Reusing a key with *different*
            parameters fails closed with an ``ok=False`` reply.

    Returns:
        ``{"ok": bool, "message": str, "rewritten_files": int,
            "old_slug": str, "new_slug": str, "actor": str,
            "idempotency_key": str|None, "timestamp": str}``
    """
    ctx = ctx or VaultContext(vault=db._default_vault(), mode="admin")
    ctx.require("wiki_rename")

    actor_norm = normalize_actor(actor)
    provenance = {
        "actor": actor_norm,
        "idempotency_key": idempotency_key,
        "timestamp": now_iso(),
    }
    fail = lambda msg, **kw: {  # noqa: E731
        "ok": False, "message": msg, "rewritten_files": 0,
        "old_slug": old_slug, "new_slug": new_slug,
        **provenance, **kw,
    }

    if not old_slug or not new_slug:
        return fail("old_slug and new_slug are required")

    vault_path = Path(ctx.vault).expanduser()

    # Idempotency precheck. The rename fingerprint includes both slugs
    # — a retry with the same key+slug pair returns the cached response,
    # even if old_slug no longer exists on disk (which it won't, after a
    # successful rename).
    if idempotency_key:
        cached, _ = _resolve_idempotency(
            tool="wiki_rename", vault=vault_path,
            idempotency_key=idempotency_key, actor=actor_norm,
            params={"old_slug": old_slug, "new_slug": new_slug},
        )
        if cached is not None:
            return cached

    old_holder = check_lock(vault_path, old_slug)
    if old_holder and old_holder.get("actor") != actor_norm:
        return {
            "ok": False,
            "message": f"Lock conflict: page '{old_slug}' is currently locked by agent '{old_holder['actor']}'. Please wait or release the lock.",
            "rewritten_files": 0,
            "old_slug": old_slug,
            "new_slug": new_slug,
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "lock_conflict",
            "_lock_holder": old_holder,
        }

    new_holder = check_lock(vault_path, new_slug)
    if new_holder and new_holder.get("actor") != actor_norm:
        return {
            "ok": False,
            "message": f"Lock conflict: page '{new_slug}' is currently locked by agent '{new_holder['actor']}'. Please wait or release the lock.",
            "rewritten_files": 0,
            "old_slug": old_slug,
            "new_slug": new_slug,
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "lock_conflict",
            "_lock_holder": new_holder,
        }

    # 1-4: file move + frontmatter update + link rewrite — shared contract
    # (v0.7.68, 평가 B#2): CLI's `page rename` calls the same
    # `contracts.rename_page()`, so this recipe lives in one place.
    vault_obj = _load_vault(vault_path)
    result = rename_page(vault_obj, old_slug, new_slug, actor=actor_norm)
    if not result.ok:
        extra = {"error": result.error} if result.error else {}
        return fail(result.message, **extra)

    # 5: rebuild DB
    _rebuild_db(vault_path)

    response = {
        "ok": True,
        "message": result.message,
        "rewritten_files": result.rewritten_files,
        "old_slug": old_slug,
        "new_slug": new_slug,
    }
    return _finalize_write(
        tool="wiki_rename", vault=vault_path, action="rename",
        subject=f"{old_slug} → {new_slug}",
        actor=actor_norm, idempotency_key=idempotency_key,
        params={"old_slug": old_slug, "new_slug": new_slug},
        response=response,
        extras=[f"wikilinks_rewritten: {result.rewritten_files}"],
        slugs=[old_slug, new_slug],
    )


# ─────────────── 10. wiki_relation_add ───────────────


def wiki_relation_add(
    source_slug: str,
    target_slug: str,
    relation_type: str,
    evidence: list[str] | str | None = None,
    reason: Optional[str] = None,
    confidence: Optional[dict | float] = None,
    verified_by: Optional[list[str] | str] = None,
    ctx: Optional[VaultContext] = None,
    actor: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    precondition: Optional[str] = None,
) -> dict:
    """Add or update a semantic relation in a page's frontmatter.

    Args:
        source_slug: source page slug
        target_slug: target page slug
        relation_type: uses | depends_on | implements | implemented_by | related
        evidence: list of evidence strings or single string
        reason: explanation for the relation
        confidence: optional dictionary of semantic/structural/provenance or single float
        verified_by: optional list of actors or single actor
        ctx: VaultContext
        actor: optional caller identity (M4/F1 provenance)
        idempotency_key: optional retry key (M4/F1)
    """
    ctx = ctx or VaultContext(vault=db._default_vault())
    ctx.require("wiki_relation_add")

    from raven.core.relations import (
        SEMANTIC_RELATION_TYPES,
        has_relation_evidence,
        has_relation_reason,
        is_valid_relation_type,
    )

    # input validation
    if not is_valid_relation_type(relation_type):
        return {
            "ok": False,
            "message": f"Invalid relation type '{relation_type}'. Allowed: {', '.join(sorted(SEMANTIC_RELATION_TYPES))}",
            "actor": normalize_actor(actor),
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "invalid_relation_type",
        }

    actor_norm = normalize_actor(actor)
    vault_path = Path(ctx.vault).expanduser()

    try:
        abs_path = _resolve_md_path(vault_path, source_slug)
    except slug_module.SlugError as e:
        return {
            "ok": False,
            "message": f"invalid source slug: {e}",
            "path": "",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "invalid_slug",
        }

    if _is_immutable_agent_path(source_slug):
        return {
            "ok": False,
            "message": f"Cannot modify protected path: {source_slug}",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "permission_denied",
        }

    # lock checking
    holder = check_lock(vault_path, source_slug)
    if holder and holder.get("actor") != actor_norm:
        return {
            "ok": False,
            "message": f"Lock conflict: page '{source_slug}' is currently locked by agent '{holder['actor']}'. Please wait or release the lock.",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "lock_conflict",
            "_lock_holder": holder,
        }

    # read existing page content
    if not abs_path.exists():
        return {
            "ok": False,
            "message": f"Source page '{source_slug}' not found.",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "page_not_found",
        }

    vault_obj = _load_vault(vault_path)

    # normalize target_slug if it's a short slug
    target_normalized = target_slug
    try:
        target_path = _resolve_md_path(vault_path, target_slug)
        if not target_path.exists():
            target_found = False
            base = target_slug.rsplit("/", 1)[-1]
            excluded_dirs = {"raw", "_archive", "scripts", "node_modules", ".venv", ".git"}
            for fp_md in vault_path.rglob("*.md"):
                rel_parts = fp_md.relative_to(vault_path).parts
                if rel_parts and rel_parts[0] in excluded_dirs:
                    continue
                cand_slug = str(fp_md.relative_to(vault_path))[:-3]
                if cand_slug == target_slug or cand_slug.endswith("/" + base):
                    target_normalized = cand_slug
                    target_found = True
                    break
        else:
            target_found = True
    except Exception:
        target_found = False

    # self-referencing check
    if target_normalized == source_slug:
        return {
            "ok": False,
            "message": f"Self-referencing relation is not allowed (source_slug == target_slug: '{source_slug}').",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "self_referencing",
        }

    # read existing content and merge relation
    try:
        raw_text = abs_path.read_text(encoding="utf-8")
        meta, body = core_frontmatter.parse(raw_text)
    except Exception as e:
        return {
            "ok": False,
            "message": f"Failed to parse source page: {e}",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "parse_failed",
        }

    # Auto inference of evidence and reason if missing/empty for uses or depends_on relations
    is_ev_empty = not has_relation_evidence(evidence)
    is_re_empty = not has_relation_reason(reason)

    if (is_ev_empty or is_re_empty) and relation_type in {"uses", "depends_on"}:
        target_content = ""
        target_title = target_normalized.split("/")[-1]
        if target_found:
            try:
                target_abs_path = _resolve_md_path(vault_path, target_normalized)
                if target_abs_path.exists():
                    target_content = target_abs_path.read_text(encoding="utf-8")
                    target_meta, _ = core_frontmatter.parse(target_content)
                    target_title = target_meta.get("title") or target_title
            except Exception:
                pass
        
        source_title = meta.get("title") or source_slug.split("/")[-1]
        
        from raven.curator.evidence import extract_evidence_and_reason
        auto_ev, auto_re = extract_evidence_and_reason(
            source_content=raw_text,
            target_content=target_content,
            source_title=source_title,
            target_title=target_title,
            source_slug=source_slug,
            target_slug=target_normalized,
            relation_type=relation_type,
        )
        if is_ev_empty:
            evidence = auto_ev
        if is_re_empty:
            reason = auto_re

    # final validation checks
    if not has_relation_evidence(evidence):
        return {
            "ok": False,
            "message": "evidence is required and cannot be empty",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "evidence_required",
        }
    if not has_relation_reason(reason):
        return {
            "ok": False,
            "message": "reason is required and cannot be empty",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "reason_required",
        }

    # idempotency precheck (after filling missing fields)
    params = {
        "source_slug": source_slug,
        "target_slug": target_slug,
        "relation_type": relation_type,
        "evidence": evidence,
        "reason": reason,
        "confidence": confidence,
        "verified_by": verified_by,
    }
    if idempotency_key and abs_path.exists():
        cached, _ = _resolve_idempotency(
            tool="wiki_relation_add", vault=vault_path,
            idempotency_key=idempotency_key, actor=actor_norm,
            params=params,
        )
        if cached is not None:
            return cached

    relations = meta.get("relations") or []
    if not isinstance(relations, list):
        relations = []

    # construct the new relation object
    new_rel = {
        "type": relation_type,
        "target": target_normalized,
        "evidence": evidence if isinstance(evidence, list) else [evidence],
        "reason": reason,
    }
    if confidence is not None:
        new_rel["confidence"] = confidence
    if verified_by is not None:
        new_rel["verified_by"] = verified_by if isinstance(verified_by, list) else [verified_by]

    # merge or update
    updated_relations = []
    found = False
    for r in relations:
        if isinstance(r, dict) and r.get("target") == target_normalized and r.get("type") == relation_type:
            updated_relations.append(new_rel)
            found = True
        else:
            updated_relations.append(r)

    if not found:
        updated_relations.append(new_rel)

    meta["relations"] = updated_relations

    # write back using write_page contract
    result = write_page(
        vault_obj,
        _strip_md_suffix(source_slug),
        body,
        actor={"name": actor_norm, "timestamp": now_iso()},
        overwrite=True,
        normalize=False,
        extra_meta=meta,
        append_log=False,
        precondition=precondition,
    )
    if not result.ok:
        return {
            "ok": False,
            "message": result.message or result.error or "relation update failed",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": result.error,
        }

    _rebuild_db(vault_path)

    response = {
        "ok": True,
        "message": f"Added relation {relation_type} -> {target_normalized} to {source_slug}",
        "source_slug": source_slug,
        "target_slug": target_normalized,
        "relation_type": relation_type,
    }

    return _finalize_write(
        tool="wiki_relation_add", vault=vault_path, action="update",
        subject=f"relation add: {source_slug} {relation_type} {target_normalized}", actor=actor_norm,
        idempotency_key=idempotency_key,
        params=params,
        response=response,
        extras=[f"target: {target_normalized}", f"relation_type: {relation_type}"],
        slugs=[source_slug],
    )


# ─────────────── 11. wiki_relation_remove ───────────────


def wiki_relation_remove(
    source_slug: str,
    target_slug: str,
    relation_type: str,
    ctx: Optional[VaultContext] = None,
    actor: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    precondition: Optional[str] = None,
) -> dict:
    """Remove a semantic relation from a page's frontmatter.

    Args:
        source_slug: source page slug
        target_slug: target page slug
        relation_type: uses | depends_on | implements | implemented_by | related
        ctx: VaultContext
        actor: optional caller identity (M4/F1 provenance)
        idempotency_key: optional retry key (M4/F1)
    """
    ctx = ctx or VaultContext(vault=db._default_vault())
    ctx.require("wiki_relation_remove")

    actor_norm = normalize_actor(actor)
    vault_path = Path(ctx.vault).expanduser()

    try:
        abs_path = _resolve_md_path(vault_path, source_slug)
    except slug_module.SlugError as e:
        return {
            "ok": False,
            "message": f"invalid source slug: {e}",
            "path": "",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "invalid_slug",
        }

    if _is_immutable_agent_path(source_slug):
        return {
            "ok": False,
            "message": f"Cannot modify protected path: {source_slug}",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "permission_denied",
        }

    # lock checking
    holder = check_lock(vault_path, source_slug)
    if holder and holder.get("actor") != actor_norm:
        return {
            "ok": False,
            "message": f"Lock conflict: page '{source_slug}' is currently locked by agent '{holder['actor']}'. Please wait or release the lock.",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "lock_conflict",
            "_lock_holder": holder,
        }

    # idempotency precheck
    params = {
        "source_slug": source_slug,
        "target_slug": target_slug,
        "relation_type": relation_type,
    }
    if idempotency_key and abs_path.exists():
        cached, _ = _resolve_idempotency(
            tool="wiki_relation_remove", vault=vault_path,
            idempotency_key=idempotency_key, actor=actor_norm,
            params=params,
        )
        if cached is not None:
            return cached

    # read existing page content
    if not abs_path.exists():
        return {
            "ok": False,
            "message": f"Source page '{source_slug}' not found.",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "page_not_found",
        }

    try:
        raw_text = abs_path.read_text(encoding="utf-8")
        meta, body = core_frontmatter.parse(raw_text)
    except Exception as e:
        return {
            "ok": False,
            "message": f"Failed to parse source page: {e}",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "parse_failed",
        }

    relations = meta.get("relations") or []
    if not isinstance(relations, list):
        return {
            "ok": False,
            "message": f"No relations found on page '{source_slug}'.",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "no_relations",
        }

    # target normalization matching
    target_normalized = target_slug
    matched_target = None
    for r in relations:
        if isinstance(r, dict) and r.get("type") == relation_type:
            tgt = r.get("target")
            if tgt == target_slug or (tgt and tgt.rsplit("/", 1)[-1] == target_slug.rsplit("/", 1)[-1]):
                matched_target = tgt
                break

    if not matched_target:
        matched_target = target_slug

    updated_relations = []
    found = False
    for r in relations:
        if isinstance(r, dict) and r.get("target") == matched_target and r.get("type") == relation_type:
            found = True
        else:
            updated_relations.append(r)

    if not found:
        return {
            "ok": False,
            "message": f"Relation {relation_type} -> {target_slug} not found on page '{source_slug}'.",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": "relation_not_found",
        }

    meta["relations"] = updated_relations

    vault_obj = _load_vault(vault_path)
    result = write_page(
        vault_obj,
        _strip_md_suffix(source_slug),
        body,
        actor={"name": actor_norm, "timestamp": now_iso()},
        overwrite=True,
        normalize=False,
        extra_meta=meta,
        append_log=False,
        precondition=precondition,
    )
    if not result.ok:
        return {
            "ok": False,
            "message": result.message or result.error or "relation deletion failed",
            "actor": actor_norm,
            "idempotency_key": idempotency_key,
            "timestamp": now_iso(),
            "error": result.error,
        }

    _rebuild_db(vault_path)

    response = {
        "ok": True,
        "message": f"Removed relation {relation_type} -> {matched_target} from {source_slug}",
        "source_slug": source_slug,
        "target_slug": matched_target,
        "relation_type": relation_type,
    }

    return _finalize_write(
        tool="wiki_relation_remove", vault=vault_path, action="update",
        subject=f"relation remove: {source_slug} {relation_type} {matched_target}", actor=actor_norm,
        idempotency_key=idempotency_key,
        params=params,
        response=response,
        extras=[f"target: {matched_target}", f"relation_type: {relation_type}"],
        slugs=[source_slug],
    )

"""tools — MCP tool implementations for the wiki vault.

Split into read.py (default, no permission) and write.py (--write / --admin).
All tools share a VaultContext that carries the vault root and the active
permission mode.

M4 / F1 — provenance + idempotency helpers live here so every write tool can
reach them without reimplementing the JSON file dance. The store is per-vault
(under ``<vault>/.mcp/idempotency.json``), append-only, and intentionally
lock-free: the multi-agent write caveat in README.md §3 still applies —
idempotency prevents accidental *retry*, not concurrent writers.

M5 / F4 — advisory lock helpers live here too. They store per-vault claim
records under ``<vault>/.mcp/locks.json`` and are **advisory only**: a write
tool never refuses to run when a lock is held by another actor. The response
just carries ``_lock_holder`` (with ``_advisory_conflict: True``) so the
caller can decide whether to back off. This matches README.md §3's
"multi-agent experimental" posture: surface the conflict, don't enforce it.
"""
from __future__ import annotations

from raven.mcp.errors import ToolPermissionDenied, VaultNotFound
import datetime as dt
import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional


# ─────────────── permission model ───────────────


READ = "read"
WRITE = "write"
ADMIN = "admin"

# Tools that require --write (mutate content)
WRITE_TOOLS: frozenset[str] = frozenset({
    "wiki_update",
    "wiki_ingest",
    "wiki_archive",
    "wiki_relation_add",
    "wiki_relation_remove",
})

# Tools that require --admin (destructive)
ADMIN_TOOLS: frozenset[str] = frozenset({"wiki_delete", "wiki_rename"})


class PermissionError_(ToolPermissionDenied):
    """Raised when a tool is called in a mode that doesn't permit it.

    v0.7.185: ToolPermissionDenied(= ToolError) 상속 추가. mcp 2.x는 ToolError가
    아닌 예외의 메시지를 클라이언트에 전하지 않아, "--admin이 필요하다"는 안내가
    통째로 사라지고 있었다. 기존 `except PermissionError_`는 그대로 동작한다.
    """


def check_permission(tool_name: str, mode: str) -> None:
    """Raise if `tool_name` cannot run under `mode`.

    mode ∈ {"read", "write", "admin"}.
    """
    if tool_name in ADMIN_TOOLS and mode != ADMIN:
        raise PermissionError_(
            f"{tool_name!r} requires --admin (current mode: {mode!r})"
        )
    if tool_name in WRITE_TOOLS and mode == READ:
        raise PermissionError_(
            f"{tool_name!r} requires --write (current mode: {mode!r})"
        )


# ─────────────── shared context ───────────────


@dataclass
class VaultContext:
    """Per-server vault handle + permission mode."""

    vault: Path
    mode: str = READ

    def require(self, tool_name: str) -> None:
        """Check that `tool_name` is permitted in self.mode."""
        check_permission(tool_name, self.mode)


def make_context(
    vault: Optional[Path | str] = None, mode: str = READ
) -> VaultContext:
    """Build a VaultContext.

    v0.7.67 (평가 B#16): default vault now resolves the same way
    `db._default_vault()` does — via the vault registry — instead of
    unconditionally pointing at the `raven` package directory (a leftover
    from the single-vault era). Falls back to the legacy package-relative
    path when no registry default is configured.
    """
    if vault is None:
        from raven.mcp.db import _default_vault
        vault = _default_vault()
    return VaultContext(vault=Path(vault), mode=mode)


def resolve_vault_path(name: str) -> Path:
    """Look up a registered vault's root path by name.

    Mirrors ``raven.api.server._vault_or_404`` so the MCP server can serve
    every vault the registry knows about (one process, many vaults) instead
    of being pinned to a single vault at startup.

    Raises:
        ValueError: ``name`` is not in the registry. Message lists the
            currently registered vault names so the caller (an LLM agent)
            can self-correct.
    """
    from raven.core.registry import registry

    reg = registry()
    meta = reg.get(name)
    if meta is None:
        available = ", ".join(sorted(v.name for v in reg.list())) or "(none registered)"
        raise VaultNotFound(
            f"vault {name!r} not found. Available vaults: {available}"
        )
    return meta.path


# ─────────────── M4 / F1 — provenance + idempotency ───────────────


# Default actor when the caller does not identify themselves. Surfaced in
# frontmatter and log entries so we can always answer "who wrote this?".
ANONYMOUS_ACTOR = "anonymous"


def normalize_actor(actor: Optional[str]) -> str:
    """Normalize an actor string.

    Strips whitespace; falls back to ``ANONYMOUS_ACTOR`` for ``None`` /
    empty / whitespace-only input. Does *not* validate against a user
    registry — MCP has no such concept and README.md §3 calls out that
    multi-agent identity is the caller's responsibility.
    """
    if actor is None:
        return ANONYMOUS_ACTOR
    cleaned = actor.strip()
    return cleaned or ANONYMOUS_ACTOR


def _idempotency_path(vault: Path) -> Path:
    """Where the idempotency store lives for a given vault.

    ``.mcp/`` is gitignored elsewhere — this file is intentionally not
    part of the vault's source of truth. It is best-effort persistence
    for retry suppression across MCP server restarts.
    """
    return vault / ".mcp" / "idempotency.json"


def _load_idempotency_store(vault: Path) -> dict[str, dict[str, Any]]:
    """Read the idempotency store from disk. Returns ``{}`` on miss / error.

    Failures are swallowed (logged to stderr) so a corrupted store never
    blocks a legitimate write — the trade-off is documented in F1 as
    "best-effort persistence".
    """
    path = _idempotency_path(vault)
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            return data
        # Wrong shape — treat as empty.
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        import sys
        print(f"⚠️  idempotency store unreadable ({exc}); treating as empty",
              file=sys.stderr)
        return {}


def _save_idempotency_store(vault: Path, store: dict[str, dict[str, Any]]) -> bool:
    """Atomically persist the idempotency store.

    Writes to a sibling temp file then ``os.replace``s into place so a
    crash mid-write never leaves a half-truncated JSON on disk. Returns
    True on success, False on error (caller decides whether to fail-closed).
    """
    path = _idempotency_path(vault)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix="idempotency.", suffix=".tmp", dir=path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(store, fh, ensure_ascii=False, indent=2, sort_keys=True)
            os.replace(tmp_name, path)
            return True
        except Exception:
            # Clean up the temp file if the replace never happened.
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
    except OSError as exc:
        import sys
        print(f"⚠️  could not persist idempotency store: {exc}", file=sys.stderr)
        return False


def params_fingerprint(params: dict[str, Any]) -> str:
    """Stable short hash of the write parameters.

    Used to detect a *different* write that happens to reuse the same
    idempotency_key — in that case we surface a clear error instead of
    silently returning a stale cached result.
    """
    # sort_keys=True plus separators produces a canonical encoding.
    blob = json.dumps(params, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def now_iso() -> str:
    """Local-time ISO-8601 timestamp (seconds precision, no tz suffix).

    The vault is a single-machine artefact; UTC offsets are noise. We
    match the existing `dt.datetime.now().isoformat()` style used by
    ``wiki_delete`` / ``wiki_rename``.
    """
    return dt.datetime.now().replace(microsecond=0).isoformat()


def lookup_idempotent(
    vault: Path,
    idempotency_key: Optional[str],
    tool: str,
    params: dict[str, Any],
) -> Optional[dict[str, Any]]:
    """Return the cached response if ``idempotency_key`` was already used.

    Returns ``None`` when:
      - ``idempotency_key`` is falsy (no protection requested), or
      - the key is not in the store (first call), or
      - the cached ``tool``/``fingerprint`` does not match (key reuse for
        a *different* write → caller should treat as conflict).

    A fingerprint mismatch is reported via ``{"_idempotency_conflict": True,
    "stored": {...}}`` so the tool can fail-closed with a clear message.
    """
    if not idempotency_key:
        return None
    store = _load_idempotency_store(vault)
    entry = store.get(idempotency_key)
    if entry is None:
        return None
    fp = params_fingerprint(params)
    if entry.get("tool") != tool or entry.get("fingerprint") != fp:
        return {"_idempotency_conflict": True, "stored": entry}
    return entry.get("response")


def record_idempotent(
    vault: Path,
    idempotency_key: Optional[str],
    tool: str,
    params: dict[str, Any],
    response: dict[str, Any],
) -> None:
    """Persist the response under ``idempotency_key`` for future retries.

    No-op when ``idempotency_key`` is falsy. Failure to persist is logged
    but never raised — losing the idempotency cache just means a retry
    will re-execute, which is the pre-F1 behavior.
    """
    if not idempotency_key:
        return
    store = _load_idempotency_store(vault)
    store[idempotency_key] = {
        "tool": tool,
        "fingerprint": params_fingerprint(params),
        "timestamp": now_iso(),
        "response": response,
    }
    _save_idempotency_store(vault, store)


def append_log_entry(
    vault: Path,
    action: str,
    subject: str,
    actor: str,
    idempotency_key: Optional[str] = None,
    extras: Optional[list[str]] = None,
) -> bool:
    """Append a provenance entry to ``<vault>/log.md``.

    v0.7.67 (평가 A#1): routes through ``raven.core.log.append`` so MCP log
    entries gain the same FileLock + action whitelist as CLI/API writes
    (pre-v0.7.67 this was a raw unlocked ``open("a")`` with no validation).
    Entry shape is unchanged: ``## [date] action | subject via mcp`` with
    ``- actor:`` / ``- idempotency_key:`` detail lines. Returns True on
    success, False on error — the caller is expected to surface the
    failure in its response but never let it crash a write that already
    mutated files.
    """
    try:
        from raven.core import log as log_module
        from raven.core.registry import VaultMeta
        from raven.core.vault import Vault

        v = Vault.load(VaultMeta(name=vault.name, path=vault))
        extra: dict[str, str] = {"actor": actor}
        if idempotency_key:
            extra["idempotency_key"] = idempotency_key
        for line in extras or []:
            key, sep, val = line.partition(": ")
            if sep:
                extra[key.strip()] = val.strip()
        log_module.append(
            v, action=action, subject=f"{subject} via mcp", extra=extra,
        )
        return True
    except Exception as exc:
        import sys
        print(f"⚠️  could not append log.md entry: {exc}", file=sys.stderr)
        return False


# ─────────────── M5 / F4 — advisory concurrency lock ───────────────
#
# Per-vault advisory lock store at ``<vault>/.mcp/locks.json``.
#
# Shape:
#   {
#     "<slug>": {
#       "actor": "<actor name>",
#       "since": "<ISO timestamp>",
#       "ttl_seconds": 300,
#       "expires_at": "<ISO timestamp>"  # since + ttl, for cheap GC
#     },
#     ...
#   }
#
# Semantics (F4 spec, README.md §3):
#   - advisory only — no write tool blocks on a held lock
#   - claim is overwritten by the SAME actor (idempotent re-acquire / extend)
#   - claim by a DIFFERENT actor is refused: ``acquire_lock`` returns the
#     existing claim as ``{"_advisory_conflict": True, "lock": {...}}`` so
#     the caller can surface the conflict without raising
#   - expired claims (now > expires_at) are treated as released on read;
#     the next acquire by anyone wins
#
# This mirrors the F1 pattern: best-effort persistence, corruption-tolerant,
# never blocks a write path.

# Default TTL for an advisory lock (5 minutes). Long enough to cover a
# normal "I'm editing this page" session, short enough that a crashed
# actor doesn't hold the slug hostage forever.
DEFAULT_LOCK_TTL_SECONDS = 300


def _locks_path(vault: Path) -> Path:
    """Where the advisory lock store lives for a given vault.

    Same directory as ``idempotency.json`` (``<vault>/.mcp/``), distinct
    file so F1 tests don't accidentally observe lock writes.
    """
    return vault / ".mcp" / "locks.json"


def _load_locks_store(vault: Path) -> dict[str, dict[str, Any]]:
    """Read the advisory lock store from disk. Returns ``{}`` on miss/error.

    Failures are swallowed (logged to stderr) so a corrupted store never
    blocks a legitimate write — the trade-off mirrors ``_load_idempotency_store``.
    """
    path = _locks_path(vault)
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            return data
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        import sys
        print(f"⚠️  locks store unreadable ({exc}); treating as empty",
              file=sys.stderr)
        return {}


def _save_locks_store(vault: Path, store: dict[str, dict[str, Any]]) -> bool:
    """Atomically persist the lock store.

    Same temp-file + ``os.replace`` dance as ``_save_idempotency_store``.
    Returns True on success, False on error.
    """
    path = _locks_path(vault)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix="locks.", suffix=".tmp", dir=path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(store, fh, ensure_ascii=False, indent=2, sort_keys=True)
            os.replace(tmp_name, path)
            return True
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
    except OSError as exc:
        import sys
        print(f"⚠️  could not persist locks store: {exc}", file=sys.stderr)
        return False


def _is_expired(entry: dict[str, Any], *, now: Optional[dt.datetime] = None) -> bool:
    """True if ``entry`` has passed its ``expires_at`` (or is malformed).

    Used by ``check_lock`` / ``acquire_lock`` to GC stale claims without a
    separate sweeper. A missing or unparseable ``expires_at`` counts as
    expired (fail-open — better to lose a stale claim than block forever).
    """
    expires_at = entry.get("expires_at")
    if not expires_at:
        return True
    try:
        when = dt.datetime.fromisoformat(expires_at)
    except (TypeError, ValueError):
        return True
    return (now or dt.datetime.now()) >= when


def check_lock(vault: Path, slug: str) -> Optional[dict[str, Any]]:
    """Return the active lock for ``slug`` or ``None``.

    A lock is "active" when it exists, has a different actor from the
    caller (passes through unchanged for the *same* actor — see
    ``acquire_lock``), and has not expired. Expired entries are *removed*
    on read so the next ``acquire_lock`` by anyone wins.

    The returned dict is shaped::

        {"actor": "...", "since": "...", "ttl_seconds": int,
         "expires_at": "...", "_advisory_conflict": True}

    The trailing ``_advisory_conflict`` label is what F4 spec requires
    every caller to surface, so we attach it here once.
    """
    store = _load_locks_store(vault)
    entry = store.get(slug)
    if entry is None:
        return None
    if _is_expired(entry):
        # GC the stale claim so it doesn't haunt ``check_lock`` forever.
        store.pop(slug, None)
        _save_locks_store(vault, store)
        return None
    return {
        "actor": entry.get("actor"),
        "since": entry.get("since"),
        "ttl_seconds": entry.get("ttl_seconds"),
        "expires_at": entry.get("expires_at"),
        "_advisory_conflict": True,
    }


def acquire_lock(
    vault: Path,
    slug: str,
    actor: str,
    *,
    ttl_seconds: int = DEFAULT_LOCK_TTL_SECONDS,
) -> dict[str, Any]:
    """Claim an advisory lock on ``slug`` for ``actor``.

    Returns one of:

      * ``{"ok": True, "lock": {...}}`` — claim acquired (or refreshed by
        the *same* actor — this matches the F4 "extend by re-acquire"
        convenience).
      * ``{"ok": False, "lock": <existing>, "_advisory_conflict": True}`` —
        another actor holds a non-expired claim. Caller decides whether
        to surface the conflict, wait, or proceed (F4 is advisory — no
        blocking).

    A failed ``_save_locks_store`` returns ``ok=False`` with
    ``_persisted=False`` but does *not* raise — write tools must never
    crash on a lock-store I/O error.
    """
    actor = normalize_actor(actor)
    store = _load_locks_store(vault)
    existing = store.get(slug)
    now = dt.datetime.now()

    # Expired claim → free to take over.
    if existing is not None and not _is_expired(existing, now=now):
        if existing.get("actor") != actor:
            return {
                "ok": False,
                "lock": {
                    "actor": existing.get("actor"),
                    "since": existing.get("since"),
                    "ttl_seconds": existing.get("ttl_seconds"),
                    "expires_at": existing.get("expires_at"),
                    "_advisory_conflict": True,
                },
                "_advisory_conflict": True,
            }
        # Same actor → fall through and refresh TTL.

    since = now.replace(microsecond=0).isoformat()
    expires_at = (now + dt.timedelta(seconds=ttl_seconds)).replace(microsecond=0).isoformat()
    entry = {
        "actor": actor,
        "since": since,
        "ttl_seconds": ttl_seconds,
        "expires_at": expires_at,
    }
    store[slug] = entry
    persisted = _save_locks_store(vault, store)
    out = {"ok": persisted, "lock": entry}
    if not persisted:
        out["_persisted"] = False
    return out


def release_lock(vault: Path, slug: str, actor: str) -> bool:
    """Release an advisory lock on ``slug``.

    Only the actor that holds the lock may release it — releasing on
    behalf of someone else is a silent no-op (returns False) so a
    concurrent agent cannot accidentally drop a peer's claim.

    Returns True if a claim was removed, False otherwise (no claim,
    different actor, or persistence error).
    """
    actor = normalize_actor(actor)
    store = _load_locks_store(vault)
    existing = store.get(slug)
    if existing is None or existing.get("actor") != actor:
        return False
    store.pop(slug, None)
    return _save_locks_store(vault, store)


def extend_lock(
    vault: Path,
    slug: str,
    actor: str,
    *,
    ttl_seconds: int = DEFAULT_LOCK_TTL_SECONDS,
) -> dict[str, Any]:
    """Extend an existing lock's TTL.

    Mirrors ``acquire_lock``'s actor check: extending someone else's lock
    is a conflict, not a takeover. Expired locks cannot be extended —
    the caller must re-acquire (which is the natural workflow anyway,
    since an expired lock means the previous holder is gone).
    """
    actor = normalize_actor(actor)
    store = _load_locks_store(vault)
    existing = store.get(slug)
    now = dt.datetime.now()
    if existing is None or _is_expired(existing, now=now):
        return {
            "ok": False,
            "lock": None,
            "_advisory_conflict": True,
            "reason": "no active lock to extend",
        }
    if existing.get("actor") != actor:
        return {
            "ok": False,
            "lock": {
                "actor": existing.get("actor"),
                "since": existing.get("since"),
                "ttl_seconds": existing.get("ttl_seconds"),
                "expires_at": existing.get("expires_at"),
                "_advisory_conflict": True,
            },
            "_advisory_conflict": True,
            "reason": "different actor",
        }
    expires_at = (now + dt.timedelta(seconds=ttl_seconds)).replace(microsecond=0).isoformat()
    entry = dict(existing)
    entry["ttl_seconds"] = ttl_seconds
    entry["expires_at"] = expires_at
    store[slug] = entry
    persisted = _save_locks_store(vault, store)
    out = {"ok": persisted, "lock": entry}
    if not persisted:
        out["_persisted"] = False
    return out

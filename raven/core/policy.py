"""User-owned vault operating policy — read/write contract.

ADR 2026-09-25 (vault policy slot and MCP delivery): Raven owns the slot
(`_meta/policy/VAULT-POLICY.md`) and the delivery path, never the content.
Nothing here creates the file on read, syncs it, or checks it for freshness.
Writes come only from human entry points (REST/Dashboard); agents reach this
module read-only through MCP `wiki_get_policy`.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

from . import log as log_module
from .contracts import precondition_for_path
from .lock import atomic_write_text, lock_for_file
from .vault import VAULT_POLICY_RELPATH, Vault

_TEMPLATE = Path(__file__).parent / "templates" / "policy" / "VAULT-POLICY.md"


@dataclass
class PolicyWriteResult:
    ok: bool
    precondition: str = ""
    error: str = ""


def read_policy(vault_root: Path) -> dict:
    """Policy text verbatim, or `content: None` when the owner has not written one."""
    path = Path(vault_root) / VAULT_POLICY_RELPATH
    if not path.is_file():
        return {"path": VAULT_POLICY_RELPATH, "content": None, "modified": None, "precondition": ""}
    return {
        "path": VAULT_POLICY_RELPATH,
        "content": path.read_text(encoding="utf-8"),
        "modified": datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"),
        "precondition": precondition_for_path(path),
    }


def policy_template() -> str:
    """Blank form offered by the Dashboard's "start from template" action."""
    return _TEMPLATE.read_text(encoding="utf-8")


def write_policy(vault: Vault, content: str, *, precondition: Optional[str] = None) -> PolicyWriteResult:
    """Save the policy verbatim (no frontmatter merge, unlike pages).

    `precondition` is the token from `read_policy`; `""` asserts the file is
    absent. A mismatch writes nothing and returns `error="stale_precondition"`.
    """
    path = vault.root / VAULT_POLICY_RELPATH
    with lock_for_file(vault.root, path):
        current = precondition_for_path(path)
        if precondition is not None and current != precondition:
            return PolicyWriteResult(ok=False, precondition=current, error="stale_precondition")
        is_create = not path.exists()
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, content)
    try:
        log_module.append(
            vault,
            action="create" if is_create else "update",
            subject=VAULT_POLICY_RELPATH,
            files=[VAULT_POLICY_RELPATH],
        )
    except Exception:
        pass  # log is best-effort, same as contracts.write_page
    return PolicyWriteResult(ok=True, precondition=precondition_for_path(path))

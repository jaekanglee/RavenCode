"""vault — single-vault handle.

A vault is a user-owned Markdown workspace. Raven registers the folder and
indexes its pages, but never injects policy documents, setup guides, logs, or
Git state into it.

The CLI resolves the *active* vault via:
  1. `--vault NAME` flag (explicit override)
  2. `WIKI_VAULT` env var
  3. registry's `default` vault
"""
from __future__ import annotations

import datetime as _dt
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .registry import registry, VaultMeta


# Conventional root instruction files are user-owned. Raven excludes them from
# page parsing but never creates, rewrites, validates, or migrates them.
ROOT_AGENT_INSTRUCTION_FILES: tuple[str, ...] = (
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".cursorrules",
    ".windsurfrules",
)

# User-owned vault operating policy (ADR 2026-09-25). Raven reads it for MCP
# delivery but never creates, rewrites, syncs, or indexes it. Kept outside
# `_meta/agents/` because that directory flips `is_llm_wiki` on.
VAULT_POLICY_RELPATH = "_meta/policy/VAULT-POLICY.md"
_VAULT_POLICY_DIR_PARTS: tuple[str, ...] = ("_meta", "policy")


def is_user_owned_instruction(rel_parts: tuple[str, ...]) -> bool:
    """True for user-owned instruction files that must not become pages."""
    if len(rel_parts) == 1 and rel_parts[0] in ROOT_AGENT_INSTRUCTION_FILES:
        return True
    return rel_parts[: len(_VAULT_POLICY_DIR_PARTS)] == _VAULT_POLICY_DIR_PARTS


@dataclass
class Vault:
    """In-memory handle to a single vault on disk."""

    meta: VaultMeta
    root: Path

    @classmethod
    def load(cls, meta: VaultMeta) -> "Vault":
        root = meta.path
        if not root.exists():
            raise FileNotFoundError(f"vault path missing: {root}")
        
        # v0.7.121+: 자가치유 (Self-heal)
        # 만약 .vault.json 파일이 존재하고, 그 안의 path 필드가 현재의 root 경로와 다르다면
        # 실제 현재 로컬 경로로 .vault.json 파일을 자동 갱신해준다.
        vjson = root / ".vault.json"
        if vjson.exists():
            try:
                import json
                data = json.loads(vjson.read_text(encoding="utf-8"))
                saved_path = data.get("path")
                if saved_path and str(root.resolve()) != str(Path(saved_path).expanduser().resolve()):
                    data["path"] = str(root.resolve())
                    vjson.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass

        return cls(meta=meta, root=root)

    @property
    def is_llm_wiki(self) -> bool:
        """Check if LLM Wiki patterns are enabled for this vault."""
        if hasattr(self.meta, "features") and dict(self.meta.features).get("llm_wiki") is True:
            return True
        vf = self.root / ".vault.json"
        if vf.exists():
            try:
                import json
                data = json.loads(vf.read_text(encoding="utf-8"))
                if data.get("features", {}).get("llm_wiki") is True:
                    return True
            except Exception:
                pass
        # Structural opt-in: agent workflow docs indicate the user
        # intentionally enabled the LLM Wiki layer. `raw/` and `log.md` are
        # excluded because some non-wiki flows may still create them.
        if (self.root / "_meta" / "agents").exists():
            return True
        return False

    # ────────────────────────── v0.7.37+: agents policy ─────────────────────
    #
    # When `.vault.json` lists an `agents` allowlist, ONLY callers whose
    # actor string (or dict `.name`) appears in that list may write to
    # this vault. Empty list = permissive (every actor allowed) — full
    # backward compatibility with vaults that haven't opted in.
    #
    # Reads (`search`, `get_page`, `graph`, `lint`, `log`, MCP read
    # tools) are NEVER gated here; the policy is write-only by design.
    # Doing it this way keeps federation / cross-vault wikilinks free
    # while preventing rogue actors from silently mutating another
    # vault's content.

    def write_allowed_for(self, actor: Optional[object]) -> bool:
        """Return True if `actor` may write to this vault under the
        `agents` opt-in policy.

        Args:
            actor: One of:
                * None — anonymous caller (treated as `"anonymous"`).
                * str — actor identifier (e.g. `"hermes"`, `"wiki-agent"`).
                * dict — must carry `"name"` (used as actor id).
                * any object with `.name` attribute — used as actor id.

        Returns:
            True if `actor` may write. False ONLY when the vault has an
            opt-in allowlist (`meta.agents` non-empty) AND the actor id
            is not in that list. Otherwise True (default).
        """
        allowlist = self.meta.agents
        if not allowlist:
            # No policy declared → allow every actor (current behavior).
            return True

        # Normalize actor → str
        if actor is None:
            actor_id = "anonymous"
        elif isinstance(actor, str):
            actor_id = actor
        elif isinstance(actor, dict):
            actor_id = str(actor.get("name", "anonymous"))
        else:
            name = getattr(actor, "name", None)
            actor_id = str(name) if name else "anonymous"

        return actor_id in allowlist

    @classmethod
    def create(
        cls,
        name: str,
        path: Path,
        mode: str = "personal",
        owner: str = "user",
        description: str = "",
        *,
        workspace_path: str = "",
    ) -> "Vault":
        """Create and register a plain Markdown workspace.

        Raven creates only the requested folder, its ``content/`` directory,
        and the current registry metadata. It does not add onboarding pages,
        agent instructions, activity logs, or Git state.
        """
        path = Path(path).expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
        (path / "content").mkdir(parents=True, exist_ok=True)
        meta = VaultMeta(
            name=name,
            path=path,
            mode=mode,
            owner=owner,
            created=__import__("datetime").date.today().isoformat(),
            description=description,
            workspace_path=workspace_path,
        )
        (path / ".vault.json").write_text(
            json.dumps(meta.to_json(), indent=2, ensure_ascii=False), encoding="utf-8"
        )
        registry().add(meta)
        return cls(meta=meta, root=path)

    @classmethod
    def clone(
        cls,
        src: "Vault",
        name: str,
        path: Path,
        *,
        mode: Optional[str] = None,
        owner: Optional[str] = None,
        description: str = "",
        copy_meta: bool = False,
        data_only: bool = False,
    ) -> "Vault":
        """Create a new vault by copying `src`'s content to `path`.

        Args:
            src: source Vault instance.
            name: new vault name (must not already be registered).
            path: absolute path for new vault directory.
            mode, owner, description: optional overrides (default: copy from src).
            copy_meta: if False (default, v2026-06-26 Lite policy), do NOT copy
                       src's _meta/. If True, copy _meta/ from src.
                       NOTE: copy_meta=True can leak Tier 1 raven-internal docs
                       from source vault (OPERATIONS, agent/*, raven-policy).
                       Use only for explicit dev/debug workflows.
            data_only: if True, copy ONLY content/ (no _meta/, no .vault.json
                       policy inheritance). Use for data migration / backup
                       where you don't want source vault's policy semantics
                       to leak into the new vault. Mutually exclusive with
                       copy_meta=True (data_only wins).

        Returns:
            New Vault instance (already registered in the registry).

        Copies:
            content/  — all user markdown (1:1) [always]
            _meta/    — system docs (only if copy_meta=True AND not data_only)

        Skips:
            _archive/ — not transferred (it's transient)
            wiki.db   — regenerated on first build

        Raises:
            FileExistsError: if name is already in registry, or path has files.
            ValueError: if src.path equals path.
        """
        from .registry import registry as _registry

        if name in [m.name for m in _registry().list()]:
            raise FileExistsError(f"vault {name!r} already registered")
        new_path = Path(path).expanduser().resolve()
        if new_path == src.root.resolve():
            raise ValueError(f"clone target cannot be same as src: {src.root}")
        if new_path.exists() and any(new_path.iterdir()):
            raise FileExistsError(f"target path not empty: {new_path}")
        new_path.mkdir(parents=True, exist_ok=True)

        import shutil
        # content/ 1:1 (always)
        src_content = src.root / "content"
        if src_content.exists():
            shutil.copytree(src_content, new_path / "content")
        else:
            (new_path / "content").mkdir(exist_ok=True)

        # _meta/ optional copy (only if copy_meta=True AND not data_only)
        copy_meta = copy_meta and not data_only
        if copy_meta and (src.root / "_meta").exists():
            shutil.copytree(src.root / "_meta", new_path / "_meta")

        # write .vault.json with overrides
        meta = VaultMeta(
            name=name,
            path=new_path,
            mode=mode if mode is not None else src.meta.mode,
            owner=owner if owner is not None else src.meta.owner,
            created=_dt.date.today().isoformat(),
            description=description,
        )
        import json
        (new_path / ".vault.json").write_text(
            json.dumps(meta.to_json(), indent=2, ensure_ascii=False)
        )
        _registry().add(meta)
        return cls(meta=meta, root=new_path)

    # ─── path helpers ──────────────────────────────

    @property
    def db_path(self) -> Path:
        return self.root / "wiki.db"

    @property
    def content_root(self) -> Path:
        return self.root / "content"

    @property
    def meta_root(self) -> Path:
        return self.root / "_meta"

    @property
    def drafts_root(self) -> Path:
        return self.root / "drafts"



# Re-export datetime at module scope (used by clone)
_dt = __import__("datetime")


def resolve_active_vault(name: Optional[str] = None) -> Vault:
    """Resolve which vault to operate on.

    Priority:
      1. explicit `name` arg
      2. `WIKI_VAULT` env var
      3. registry default
    """
    reg = registry()
    chosen_name = (
        name
        or os.environ.get("WIKI_VAULT", "").strip()
        or reg._data.get("default", "")
    )
    if chosen_name:
        meta = reg.get(chosen_name)
        if meta is None:
            raise ValueError(f"vault {chosen_name!r} not in registry")
        return Vault.load(meta)
    default = reg.default()
    if default is None:
        raise ValueError(
            "no vaults registered. Create one first:\n"
            "  raven vault create <name> <path>"
        )
    return Vault.load(default)

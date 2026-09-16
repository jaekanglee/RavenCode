"""raven CLI entrypoint — `python -m raven.cli ...` or installed `raven ...`.

Design:
    - Typer sub-apps: `vault`, `page`, `link`, `build`, `export`
    - shared resolver: `--vault NAME` overrides active vault
    - all output is human-readable text + small JSON for machine consumers
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

import typer

from raven.core import registry, resolve_active_vault, VAULTS_ROOT, REGISTRY_PATH
from raven.core import db_module, lint_module, export_module, link_module
from raven.core import slug_module, frontmatter_module, archive_module
from raven.core import log_module
from raven.core import contracts
from raven import migrate as migrate_module
from raven import __version__ as RAVEN_VERSION
from raven.core.vault import Vault

app = typer.Typer(
    name="raven",
    help="Multi-vault wiki engine — CLI for vault mgmt + page CRUD + linking.",
    no_args_is_help=True,
    add_completion=False,
    # v0.7.183: root callback 옵션(`--version`)이 서브커맨드 없이도 동작하게.
    invoke_without_command=True,
)


@app.callback()
def _cli_main(
    version: bool = typer.Option(
        False, "--version", "-V", help="Show raven version and exit."
    ),
) -> None:
    """v0.7.183: 설치본 CLI/MCP/DB 스키마 버전 불일치를 스스로 감지할 수 있게
    `raven --version` → SOT(raven/__init__.py __version__) 출력."""
    if version:
        typer.echo(f"raven {RAVEN_VERSION}")
        raise typer.Exit()

vault_app = typer.Typer(help="Vault discovery / creation / registration.")
page_app = typer.Typer(help="Page CRUD inside the active vault.")
link_app = typer.Typer(help="Wikilink inspection.")
archive_app = typer.Typer(help="Vault _archive/ management (list/clean/restore).")
log_app = typer.Typer(help="log.md 작업 이력 관리 (LLM Wiki 패턴은 optional).")
lint_app = typer.Typer(help="vault lint (raven.core.lint.CHECK_REGISTRY 참조) — broken/orphan/contradictions/stale/tier integrity/slug-title 1:1/growth/duplicate title/audit violation pattern 등.")
migrate_app = typer.Typer(help="vault 마이그레이션 — lint 5 카테고리 dry-run/apply (v0.5.2+).")
note_app = typer.Typer(help="트리거 헬퍼 — 결정/개념/lesson/journal 페이지 즉시 생성 (playbook §10).")
collection_app = typer.Typer(help="collection sync — vault FS ↔ yaml diff (Stateless Curator 합의안 v3).")
curator_app = typer.Typer(help="curator run — Stateless Curator execute() (git diff 기반 change set 큐레이션).")
docs_app = typer.Typer(
    help=(
        "Tier 1 raven-internal docs (v2026-06-26, 2-tier model). "
        "Reads OPERATIONS.md, agent/*, raven-policy.md from the raven package — "
        "NEVER copies them into the user vault."
    ),
)
app.add_typer(vault_app, name="vault")
app.add_typer(page_app, name="page")
app.add_typer(link_app, name="link")
app.add_typer(archive_app, name="archive")
app.add_typer(log_app, name="log")
app.add_typer(lint_app, name="lint")
app.add_typer(migrate_app, name="migrate")
app.add_typer(note_app, name="note")
app.add_typer(collection_app, name="collection")
app.add_typer(curator_app, name="curator")
app.add_typer(docs_app, name="docs")


# ────────────────────────── top-level ──────────────────────────


@app.command()
def update(
    check: bool = typer.Option(
        False, "--check", help="업데이트 가능 여부만 확인하고 아무것도 바꾸지 않습니다."
    ),
) -> None:
    """Raven 자체 업데이트 — 체크아웃을 origin으로 fast-forward 하고 의존성을 갱신."""
    from raven.cli import update as update_module

    root = update_module.resolve_repo_root()
    if root is None:
        typer.echo("❌ git 체크아웃이 아닙니다 — 소스에서 설치된 raven에서만 업데이트할 수 있습니다.")
        typer.echo("   데스크톱 앱(Raven.app)은 앱 내 '업데이트 확인'을 사용하세요.")
        raise typer.Exit(1)

    try:
        status = update_module.read_repo_status(root)
    except update_module.GitError as exc:
        typer.echo(f"❌ {exc}")
        raise typer.Exit(1)

    plan = update_module.plan_update(status)
    before = update_module.read_version_from_checkout(root) or RAVEN_VERSION
    typer.echo(f"📦 raven {before}  ({root}, {status.branch})")

    # --check는 읽기 전용 조회다. dirty 트리(untracked 포함)에서도 "받을 게 있는지"는
    # 답할 수 있어야 한다 — 차단 사유는 덧붙이되 조회 자체를 막지 않는다.
    if check:
        if status.behind:
            typer.echo(f"⬆️  {status.behind}개 커밋을 받을 수 있습니다.")
        else:
            typer.echo("✅ 이미 최신입니다.")
        if plan.action == "blocked":
            typer.echo(f"⚠️  단, 지금은 적용할 수 없습니다 — {plan.reason}")
        typer.echo("   (--check — 아무것도 변경하지 않았습니다.)")
        return

    if plan.action == "blocked":
        typer.echo(f"❌ {plan.reason}")
        raise typer.Exit(1)
    if plan.action == "up-to-date":
        typer.echo(f"✅ {plan.reason}")
        return

    typer.echo(f"⬆️  {plan.reason}")
    try:
        update_module.apply_update(root, plan.reinstall_deps)
    except update_module.GitError as exc:
        typer.echo(f"❌ {exc}")
        raise typer.Exit(1)
    except update_module.DepsError as exc:
        # 소스는 이미 전진했다 — 반쪽 상태를 숨기지 말고 다음 할 일을 알려준다.
        after = update_module.read_version_from_checkout(root) or "?"
        typer.echo(f"⚠️  소스는 {before} → {after} 로 업데이트됐지만 의존성 재설치에 실패했습니다.")
        typer.echo(f"   {exc}")
        typer.echo("   수동 복구: `make install`")
        raise typer.Exit(1)

    after = update_module.read_version_from_checkout(root) or "?"
    typer.echo(f"✅ 업데이트 완료: {before} → {after}")
    if plan.reinstall_deps:
        typer.echo("   의존성도 재설치했습니다.")
    typer.echo("   실행 중인 서비스는 `./raven.sh restart`로 재시작하세요.")


@app.command()
def where() -> None:
    """Show current raven config (vaults root, registry, active vault)."""
    typer.echo(f"📁 vaults root: {VAULTS_ROOT()}")
    typer.echo(f"📋 registry:    {REGISTRY_PATH()}")
    reg = registry()
    vaults = reg.list()
    if not vaults:
        typer.echo("⚠️  no vaults registered. Create one with `raven vault create <name> <path>`.")
        return
    typer.echo(f"\n🔐 active:      {reg._data.get('default', '(unset)')} (set with `raven vault use <name>`)")
    typer.echo(f"\n📚 vaults ({len(vaults)}):")
    for v in vaults:
        marker = "★" if v.default else " "
        typer.echo(f"  {marker} {v.name:14s} {v.mode:8s} {v.path}")


# ────────────────────────── vault ──────────────────────────


@vault_app.command("list")
def vault_list(
    json_out: bool = typer.Option(False, "--json", help="machine-readable output"),
) -> None:
    """List all vaults in the registry."""
    reg = registry()
    vaults = reg.list()
    if json_out:
        typer.echo(json.dumps([{
            "name": v.name,
            "path": str(v.path),
            "mode": v.mode,
            "owner": v.owner,
            "default": v.default,
        } for v in vaults], indent=2, ensure_ascii=False))
        return
    if not vaults:
        typer.echo("(empty — create with `raven vault create <name> <path>`)")
        return
    for v in vaults:
        marker = "★" if v.default else " "
        typer.echo(f"  {marker} {v.name:14s} {v.mode:8s} {v.path}")


@vault_app.command("use")
def vault_use(name: str) -> None:
    """Set registry default to <name>."""
    if registry().set_default(name):
        typer.echo(f"✅ default → {name}")
    else:
        typer.echo(f"❌ vault {name!r} not found", err=True)
        raise typer.Exit(1)


@vault_app.command("info")
def vault_info(name: Optional[str] = typer.Argument(None, help="vault name (default: active)")) -> None:
    """Show metadata + content stats for one vault."""
    v = resolve_active_vault(name)
    pages = list(v.content_root.rglob("*.md"))
    typer.echo(f"📚 {v.meta.name}")
    typer.echo(f"   path:        {v.root}")
    typer.echo(f"   mode:        {v.meta.mode}")
    typer.echo(f"   owner:       {v.meta.owner}")
    typer.echo(f"   created:     {v.meta.created or '(unknown)'}")
    typer.echo(f"   pages:       {len(pages)} .md files")
    typer.echo(f"   db present:  {v.db_path.exists()}")


@vault_app.command("create")
def vault_create(
    name: str,
    path: str,
    mode: str = typer.Option("personal", help="personal | shared | agent"),
    owner: str = typer.Option("user"),
    description: str = typer.Option(""),
    workspace: str = typer.Option("", "--workspace", "-w", help="associated project workspace directory path"),
) -> None:
    """Create a plain Markdown vault on disk and register it."""
    v = Vault.create(
        name=name,
        path=Path(path).expanduser(),
        mode=mode,
        owner=owner,
        description=description,
        workspace_path=workspace,
    )
    typer.echo(f"✅ vault created: {v.meta.name} → {v.root}")


@vault_app.command("register")
def vault_register(
    name: str,
    path: str,
    mode: str = typer.Option("personal"),
    owner: str = typer.Option("user"),
    workspace: str = typer.Option("", "--workspace", "-w", help="associated project workspace directory path"),
) -> None:
    """Register an existing folder as a vault (no file changes)."""
    p = Path(path).expanduser().resolve()
    if not p.exists() or not p.is_dir():
        typer.echo(f"❌ not a directory: {p}", err=True)
        raise typer.Exit(1)
    from raven.core.registry import VaultMeta
    meta = VaultMeta(name=name, path=p, mode=mode, owner=owner, workspace_path=workspace)
    registry().add(meta)
    typer.echo(f"✅ registered: {name} → {p}")


@vault_app.command("workspace")
def vault_workspace(
    name: str = typer.Argument(..., help="vault name"),
    workspace_path: Optional[str] = typer.Argument(None, help="workspace directory path to associate (or empty to show current)"),
    unlink: bool = typer.Option(False, "--unlink", help="unlink the associated workspace"),
) -> None:
    """Associate, show, or unlink a workspace directory with a vault."""
    reg = registry()
    meta = reg.get(name)
    if not meta:
        typer.echo(f"❌ vault {name!r} not found", err=True)
        raise typer.Exit(1)

    if unlink:
        reg.update_workspace_path(name, "")
        typer.echo(f"✅ unlinked workspace for vault {name!r}")
        return

    if workspace_path is None:
        if meta.workspace_path:
            typer.echo(f"💻 associated workspace for {name!r}: {meta.workspace_path}")
        else:
            typer.echo(f"ℹ️  no workspace associated with vault {name!r}")
        return

    # Check if workspace path exists
    w_path = Path(workspace_path).expanduser().resolve()
    if not w_path.exists() or not w_path.is_dir():
        typer.echo(f"❌ not a directory: {w_path}", err=True)
        raise typer.Exit(1)

    reg.update_workspace_path(name, str(w_path))
    typer.echo(f"✅ workspace associated: {name!r} → {w_path}")


@vault_app.command("clone")
def vault_clone(
    src: str = typer.Argument(..., help="source vault name"),
    name: str = typer.Argument(..., help="new vault name"),
    path: str = typer.Argument(..., help="absolute path for new vault"),
    mode: str = typer.Option(None, "--mode", help="override mode (default: copy from src)"),
    owner: str = typer.Option(None, "--owner", help="override owner (default: copy from src)"),
    copy_meta: bool = typer.Option(
        False,
        "--copy-meta",
        help=(
            "Also copy _meta/ from src (Lite policy default: False). "
            "WARNING: --copy-meta can leak Tier 1 raven-internal docs "
            "(OPERATIONS, agent/*, raven-policy) from src. "
            "Use only for explicit dev/debug workflows."
        ),
    ),
    data_only: bool = typer.Option(
        False,
        "--data-only",
        help="Copy ONLY content/. Skip _meta/ entirely (no policy inheritance).",
    ),
) -> None:
    """Clone an existing vault to a new vault.

    Lite policy default (v2026-06-26, 2-tier boundary):
        content/ copied, _meta/ NOT copied. This prevents Tier 1
        raven-internal docs from leaking into the new vault via
        source vault contamination.

    Skips _archive/ and wiki.db. Useful for templates, sandboxes, branches.

    Examples:
        raven vault clone wiki new-vault /path/to/new     # content only
        raven vault clone wiki new-vault /path --copy-meta  # content + _meta (주의)
        raven vault clone wiki new-vault /path --data-only  # content only (명시)
    """
    src_meta = registry().get(src)
    if src_meta is None:
        typer.echo(f"❌ source vault {src!r} not found", err=True)
        raise typer.Exit(1)
    if registry().get(name) is not None:
        typer.echo(f"❌ name {name!r} already registered", err=True)
        raise typer.Exit(1)
    src_v = Vault.load(src_meta)
    try:
        new_v = Vault.clone(
            src=src_v,
            name=name,
            path=Path(path).expanduser(),
            mode=mode,
            owner=owner,
            copy_meta=copy_meta,
            data_only=data_only,
        )
    except (FileExistsError, ValueError) as e:
        typer.echo(f"❌ clone failed: {e}", err=True)
        raise typer.Exit(1)
    typer.echo(f"✅ cloned: {src!r} → {name!r} at {new_v.root}")
    if copy_meta and not data_only:
        typer.echo(
            "   ⚠️  _meta/ copied — verify Tier 1 docs are not leaking "
            "(run `raven docs list` to see what's in src)"
        )
    elif data_only:
        typer.echo("   (data_only mode: _meta/ not copied)")
    else:
        typer.echo(
            "   (Lite default: _meta/ not copied — "
            "run `raven meta sync` to populate fresh templates)"
        )


# alias for `vault import` (same as clone)
@vault_app.command("import")
def vault_import_alias(
    src: str = typer.Argument(...),
    name: str = typer.Argument(...),
    path: str = typer.Argument(...),
    mode: str = typer.Option(None, "--mode"),
    owner: str = typer.Option(None, "--owner"),
    copy_meta: bool = typer.Option(False, "--copy-meta"),
    data_only: bool = typer.Option(False, "--data-only"),
) -> None:
    """Alias for `vault clone` (same behavior)."""
    vault_clone(
        src=src, name=name, path=path,
        mode=mode, owner=owner, copy_meta=copy_meta, data_only=data_only,
    )


@vault_app.command("repair")
def vault_repair(
    name: str,
    path: str = typer.Option(
        ..., "--path",
        help=(
            "corrected path where the vault's files actually live, as resolvable "
            "from wherever THIS command runs — e.g. the container-internal path "
            "under WIKI_VAULTS_DIR if run via `docker compose exec api ...`, not "
            "necessarily the host path shown in `.vault.json`"
        ),
    ),
) -> None:
    """Fix a vault's registered path without touching any files.

    Use when `.registry.json` points at a path that no longer resolves
    (e.g. after a Docker/host path mismatch). Registry-only — no data is
    copied, moved, or deleted.
    """
    reg = registry()
    if reg.get(name) is None:
        typer.echo(f"❌ vault {name!r} not found", err=True)
        raise typer.Exit(1)
    new_path = Path(path).expanduser().resolve()
    if not new_path.is_dir():
        typer.echo(f"❌ not a directory: {new_path}", err=True)
        raise typer.Exit(1)
    if not (new_path / ".vault.json").exists():
        typer.echo(f"❌ not a vault (missing .vault.json): {new_path}", err=True)
        raise typer.Exit(1)
    reg.update_path(name, new_path)
    typer.echo(f"✅ repaired: {name} → {new_path}")


@vault_app.command("remove")
def vault_remove(name: str, force: bool = typer.Option(False, "--force")) -> None:
    """Unregister a vault (does NOT delete the folder)."""
    if not force:
        confirm = typer.confirm(f"Unregister vault {name!r}? Files will remain on disk.", default=False)
        if not confirm:
            raise typer.Abort()
    if registry().remove(name):
        typer.echo(f"✅ unregistered: {name}")
    else:
        typer.echo(f"❌ not found: {name}", err=True)
        raise typer.Exit(1)


# ────────────────────────── page ──────────────────────────


def _resolve_vault_or_die(name: Optional[str]) -> Vault:
    try:
        return resolve_active_vault(name)
    except Exception as e:
        typer.echo(f"❌ {e}", err=True)
        raise typer.Exit(1)


@page_app.command("ls")
def page_ls(
    type_filter: Optional[str] = typer.Option(None, "--type", "-t"),
    vault: Optional[str] = typer.Option(None, "--vault"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """List pages in active vault."""
    v = _resolve_vault_or_die(vault)
    pages = sorted(v.content_root.rglob("*.md"))
    rows = []
    for p in pages:
        slug = str(p.relative_to(v.root)).replace(".md", "")
        # read frontmatter
        try:
            text = p.read_text()
        except Exception:
            continue
        title = ""
        ptype = ""
        if text.startswith("---"):
            try:
                fm = text.split("---", 2)[1]
                for line in fm.splitlines():
                    if line.startswith("title:"):
                        title = line.split(":", 1)[1].strip()
                    elif line.startswith("type:"):
                        ptype = line.split(":", 1)[1].strip()
            except Exception:
                pass
        if type_filter and ptype != type_filter:
            continue
        rows.append({"slug": slug, "title": title, "type": ptype})
    if json_out:
        typer.echo(json.dumps(rows, indent=2, ensure_ascii=False))
        return
    if not rows:
        typer.echo("(no pages)")
        return
    for r in rows:
        marker = f"[{r['type']}]" if r["type"] else "[?]"
        typer.echo(f"  {marker:13s} {r['slug']:40s} {r['title']}")


@page_app.command("get")
def page_get(
    slug: str,
    vault: Optional[str] = typer.Option(None, "--vault"),
) -> None:
    """Show one page (frontmatter + body)."""
    v = _resolve_vault_or_die(vault)
    fp = v.root / f"{slug}.md"
    if not fp.exists():
        typer.echo(f"❌ not found: {slug}", err=True)
        raise typer.Exit(1)
    typer.echo(fp.read_text())


@page_app.command("new")
def page_new(
    slug: str,
    title: str = typer.Option(..., "--title", help="page title"),
    type_: str = typer.Option("concept", "--type", help="concept|person|comparison|project|tool|rule|query|journal"),
    tags: str = typer.Option("", help="comma-separated tags"),
    vault: Optional[str] = typer.Option(None, "--vault"),
) -> None:
    """Create a new page with frontmatter + empty body.

    Slug handling (v0.3+):
        - 'foo' → 'content/foo' (auto prefix when no '/' in slug)
        - 'meta/welcome' → '_meta/welcome' (explicit prefix preserved)
        - Invalid slugs (.., ~, absolute, NUL, ':') are rejected.

    v0.6.2+:
        - Delegates to `raven.core.contracts.write_page` (shared recipe).
    """
    v = _resolve_vault_or_die(vault)
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []
    # v0.7.67 (평가 B#1): API/MCP는 raw/를 항상 거부하는데 CLI `page new raw/x`만
    # 성공했다 — "raw/는 불변" 정책이 CLI 한 표면에서 뚫려 있었음. CLI는
    # `_meta/`에 직접 쓰는 기존 능력(예: page new _meta/welcome)을 의도적으로
    # 유지해야 하므로(테스트로 고정됨) contracts.py의 일괄
    # `enforce_protected_paths`(raw/+_meta/+log 전체 차단)는 쓰지 않고,
    # raw/만 CLI에서 선제 차단한다.
    normalized_for_check = slug_module.normalize_prefix(slug).lower()
    if normalized_for_check.startswith("raw/") or normalized_for_check.startswith("content/raw/"):
        typer.echo(
            "❌ permission_denied: raw/ 는 불변/보호 영역이므로 page new로 쓸 수 없습니다.",
            err=True,
        )
        raise typer.Exit(1)
    result = contracts.write_page(
        v,
        slug,
        f"# {title}\n",
        title=title,
        type=type_,
        tags=tag_list,
        overwrite=False,  # create-only: typer.Exit on exists (matches pre-v0.6.2)
    )
    if not result.ok:
        if result.error == "exists":
            typer.echo(f"❌ exists: {result.slug}", err=True)
        else:
            typer.echo(f"❌ {result.error}", err=True)
        raise typer.Exit(1)
    typer.echo(f"✅ created: {result.slug}")


# ────────────────────────── note (트리거 헬퍼) ──────────────────────────

NOTE_TEMPLATES = {
    "decision": (
        "# {title}\n\n"
        "## 컨텍스트\n"
        "| 후보 | 장점 | 단점 |\n"
        "|---|---|---|\n"
        "| | | |\n"
        "| | | |\n\n"
        "## 결정\n"
        "**{title}**\n\n"
        "## 이유 (왜 A안이지 B안이 아닌지)\n"
        "1.\n"
        "2.\n"
        "3.\n\n"
        "## 트레이드오프 (받아들인 비용)\n"
        "-\n\n"
        "## 대안 검토 시 다시 보기\n"
        "-\n\n"
        "## 관련\n"
        "-\n"
    ),
    "concept": (
        "# {title}\n\n"
        "## 정의\n\n\n"
        "## 왜 중요한가\n\n\n"
        "## 사용 예시\n\n\n"
        "## 주의점\n\n\n"
        "## 관련\n"
        "-\n"
    ),
    "lesson": (
        "# {title}\n\n"
        "## 실수 / 함정\n\n\n"
        "## 어떻게 발견했나\n\n\n"
        "## 어떻게 피하나\n\n\n"
        "## 관련\n"
        "-\n"
    ),
    "journal": (
        "# {title}\n\n"
        "## 오늘 한 것\n"
        "-\n\n"
        "## 배운 것\n"
        "-\n\n"
        "## 내일 할 것\n"
        "-\n"
    ),
    "rule": (
        "# {title}\n\n"
        "## 적용 범위\n\n\n"
        "## 규칙\n\n\n"
        "## 예외\n\n\n"
        "## 관련\n"
        "-\n"
    ),
    "issue": (
        "# {title}\n\n"
        "## 상태\n"
        "열림 (Open)\n\n"
        "## 문제 상황\n\n\n"
        "## 원인 분석\n\n\n"
        "## 해결 방안\n\n\n"
        "## 관련\n"
        "-\n"
    ),
}

NOTE_TYPE_MAP = {
    "decision": ("decisions", "decision"),
    "concept": ("concepts", "concept"),
    "lesson": ("lessons", "lesson"),
    "journal": ("journal", "journal"),
    "rule": ("rules", "rule"),
    "issue": ("issues", "issue"),
}


@note_app.command("decision")
def note_decision(
    project: str = typer.Option(..., "--project", "-p", help="프로젝트 슬러그"),
    slug: str = typer.Option(..., "--slug", help="예: why-spring-boot"),
    title: str = typer.Option(..., "--title", "-t"),
    vault: Optional[str] = typer.Option(None, "--vault"),
) -> None:
    """결정 트리거 — decisions/{slug}.md 즉시 생성 (playbook §10.1)."""
    _note_create("decision", project, slug, title, vault)


@note_app.command("concept")
def note_concept(
    project: str = typer.Option(..., "--project", "-p"),
    slug: str = typer.Option(..., "--slug"),
    title: str = typer.Option(..., "--title", "-t"),
    vault: Optional[str] = typer.Option(None, "--vault"),
) -> None:
    """막힘해결 트리거 — concepts/{slug}.md 즉시 생성 (playbook §10.1)."""
    _note_create("concept", project, slug, title, vault)


@note_app.command("lesson")
def note_lesson(
    project: str = typer.Option(..., "--project", "-p"),
    slug: str = typer.Option(..., "--slug"),
    title: str = typer.Option(..., "--title", "-t"),
    vault: Optional[str] = typer.Option(None, "--vault"),
) -> None:
    """막힘(실수) 트리거 — lessons/{slug}.md 즉시 생성 (playbook §10.1)."""
    _note_create("lesson", project, slug, title, vault)


@note_app.command("journal")
def note_journal(
    project: str = typer.Option(..., "--project", "-p"),
    vault: Optional[str] = typer.Option(None, "--vault"),
) -> None:
    """하루끝 트리거 — journal/{YYYY-MM-DD}.md 즉시 생성 (playbook §10.1).

    slug/title 자동 = 오늘 날짜.
    """
    from datetime import date
    today = date.today().isoformat()
    _note_create("journal", project, today, today, vault)


@note_app.command("rule")
def note_rule(
    project: str = typer.Option(..., "--project", "-p"),
    slug: str = typer.Option(..., "--slug"),
    title: str = typer.Option(..., "--title", "-t"),
    vault: Optional[str] = typer.Option(None, "--vault"),
) -> None:
    """규칙 트리거 — rules/{slug}.md 즉시 생성 (playbook §10.1)."""
    _note_create("rule", project, slug, title, vault)


@note_app.command("issue")
def note_issue(
    project: str = typer.Option(..., "--project", "-p"),
    slug: str = typer.Option(..., "--slug"),
    title: str = typer.Option(..., "--title", "-t"),
    vault: Optional[str] = typer.Option(None, "--vault"),
) -> None:
    """이슈 트리거 — issues/{slug}.md 즉시 생성 (playbook §10.1)."""
    _note_create("issue", project, slug, title, vault)


def _note_create(kind: str, project: str, slug: str, title: str, vault: Optional[str]) -> None:
    """트리거 헬퍼 공통 구현.

    v0.7.67 (평가 B#1/B#4): contracts.write_page 경유로 전환 (락 + 원자적
    쓰기 + frontmatter merge를 다른 모든 write 경로와 통일). 이전에는 이
    함수가 자체 write 레시피를 갖는 5번째 쓰기 경로였고, `project` 값이
    `harumoa|homeauto|resume|design-spec` 4개로 하드코딩돼 있었다 — 범용
    CLI에 개인 프로젝트명이 박혀 있던 것. project는 이제 자유 슬러그이며,
    경로 안전성은 write_page 내부의 slug 검증이 담당한다.
    """
    if not project or not project.strip():
        typer.echo("❌ --project 값이 비어 있습니다.", err=True)
        raise typer.Exit(1)

    cat, type_ = NOTE_TYPE_MAP[kind]
    full_slug = f"content/{project}/{cat}/{slug}"
    body = NOTE_TEMPLATES[kind].format(title=title)

    v = _resolve_vault_or_die(vault)
    result = contracts.write_page(
        v, full_slug, body,
        title=title, type=type_, tags=[kind, project],
        overwrite=False,  # create-only: 트리거 헬퍼는 항상 신규 페이지
        enforce_protected_paths=True,
    )
    if not result.ok:
        if result.error == "exists":
            typer.echo(f"❌ exists: {result.slug}", err=True)
        else:
            typer.echo(f"❌ {result.error}", err=True)
        raise typer.Exit(1)

    typer.echo(f"✅ {kind} created: {result.slug}")
    typer.echo(f"   → 다음 단계: vim {result.path} (빈 섹션 채우기)")


@note_app.command("gate")
def note_gate(
    project: str = typer.Option(..., "--project", "-p"),
    vault: Optional[str] = typer.Option(None, "--vault"),
) -> None:
    """트리거 헬퍼로 작성한 페이지가 Phase 게이트를 충족하는지 확인.

    이 명령은 scripts/gate.py 의 thin wrapper.
    """
    import subprocess
    cmd = ["python3", str(Path(__file__).resolve().parent.parent.parent / "scripts" / "gate.py"), project]
    if vault:
        cmd.extend(["--vault", vault])
    result = subprocess.run(cmd, capture_output=False)
    raise typer.Exit(result.returncode)


# ────────────────────────── collection (Stateless Curator v3) ──────────────────────────


@collection_app.command("sync")
def collection_sync(
    vault: Optional[str] = typer.Option(None, "--vault", "-v"),
    policy: str = typer.Option("warn", "--policy", help="warn|conflict"),
    grace_days: int = typer.Option(7, "--grace-days"),
    apply: bool = typer.Option(False, "--apply", help="grace ≥ N → soft-archive 실제 적용"),
    json_output: bool = typer.Option(False, "--json"),
    no_log: bool = typer.Option(False, "--no-log"),
) -> None:
    """vault FS ↔ collections.yaml diff (Stateless Curator 합의안 v3).

    기본 정책 (v3):
    - warn (default): MISSING < grace → 경고 + continue, MISSING ≥ grace → soft-archive 후보
    - conflict: MISSING ≥ grace 시 hard stop (CI/audit용)

    sync_reports는 ~/.local/share/raven/curator.db에 자동 기록.
    """
    from raven.curator import sync as curator_sync

    v = _resolve_vault_or_die(vault)
    yaml_path = v.root / "_meta" / "collections.yaml"

    report = curator_sync.sync(
        vault_root=v.root,
        collections_yaml_path=yaml_path,
        grace_days=grace_days,
        policy=policy,
        apply_archive=apply,
    )

    # log.md append (best-effort)
    try:
        curator_sync.append_log(v.root, report, no_log=no_log)
    except Exception:
        pass

    if json_output:
        typer.echo(json.dumps(report.to_json(), ensure_ascii=False, indent=2))
    else:
        typer.echo(report.to_human())

    # exit: errors 있으면 1, 그 외 0
    if report.errors:
        raise typer.Exit(1)


@collection_app.command("validate")
def collection_validate(
    vault: Optional[str] = typer.Option(None, "--vault", "-v"),
) -> None:
    """collections.yaml 검증만 (DRY — yaml 작성 + execute 시점 양쪽 호출)."""
    from raven.curator import schema

    v = _resolve_vault_or_die(vault)
    yaml_path = v.root / "_meta" / "collections.yaml"

    if not yaml_path.exists():
        typer.echo(f"❌ not found: {yaml_path}", err=True)
        raise typer.Exit(1)

    try:
        y = schema.load_and_validate(yaml_path)
    except schema.CollectionsYamlError as e:
        typer.echo(f"❌ invalid: {e}", err=True)
        raise typer.Exit(1)

    typer.echo(f"✅ collections.yaml OK")
    typer.echo(f"   schema_version: {y.schema_version}")
    typer.echo(f"   defaults: {y.defaults}")
    typer.echo(f"   collections: {len(y.collections)}")
    for c in y.collections:
        active = "active" if c.is_active else f"inactive ({'archived' if c.archived else 'retired'})"
        typer.echo(f"     - {c.id} [{active}] paths={c.paths} strategy={c.first_run_strategy}")


@collection_app.command("add")
def collection_add(
    path: str = typer.Option(..., "--path", help="예: content/finance"),
    cid: str = typer.Option(..., "--id", help="collection id (예: finance)"),
    description: str = typer.Option("", "--description", "-d"),
    vault: Optional[str] = typer.Option(None, "--vault", "-v"),
) -> None:
    """collections.yaml에 새 collection 1건 추가 (사람 결정 후 호출)."""
    from raven.curator import schema

    v = _resolve_vault_or_die(vault)
    yaml_path = v.root / "_meta" / "collections.yaml"

    if not yaml_path.exists():
        typer.echo(f"❌ not found: {yaml_path}", err=True)
        raise typer.Exit(1)

    try:
        y = schema.load_and_validate(yaml_path)
    except schema.CollectionsYamlError as e:
        typer.echo(f"❌ invalid yaml: {e}", err=True)
        raise typer.Exit(1)

    # 중복 체크
    for c in y.collections:
        if c.id == cid:
            typer.echo(f"❌ duplicate id: {cid}", err=True)
            raise typer.Exit(1)
        if path in c.paths:
            typer.echo(f"❌ path already used by collection {c.id!r}: {path}", err=True)
            raise typer.Exit(1)

    new_coll = schema.Collection(
        id=cid,
        paths=[path],
        description=description,
        auto_detect=True,
        first_run_strategy=y.defaults.get("first_run_strategy", "skip_silent"),
    )

    # path 검증 (yaml 작성 시점 정책 그대로)
    try:
        schema.validate_paths(new_coll.paths)
    except schema.CollectionsYamlError as e:
        typer.echo(f"❌ invalid path: {e}", err=True)
        raise typer.Exit(1)

    y.collections.append(new_coll)
    schema.save(y, yaml_path)
    typer.echo(f"✅ added: {cid} → {path}")


# ────────────────────────── curator run ──────────────────────────


@curator_app.command("run")
def curator_run(
    collection_id: str = typer.Argument(..., help="collection id"),
    vault: Optional[str] = typer.Option(None, "--vault", "-v"),
    apply: bool = typer.Option(False, "--apply", help="기본 dry-run. --apply 시 DB write"),
    trigger: str = typer.Option("manual", "--trigger", help="manual|cron|sync"),
) -> None:
    """Stateless Curator.execute() — git diff 기반 change set 큐레이션.

    기본은 dry-run (변경 set만 보여줌). --apply 시 curation_history.db에 event 기록.
    """
    from raven.curator import curator as curator_mod

    v = _resolve_vault_or_die(vault)
    yaml_path = v.root / "_meta" / "collections.yaml"

    result = curator_mod.execute(
        collection_id=collection_id,
        vault_root=v.root,
        collections_yaml_path=yaml_path,
        dry_run=not apply,
        trigger=trigger,
    )

    # human-readable 출력
    from raven.curator.reports import render_curation_report
    typer.echo(render_curation_report(result, collection_id))

    # status별 exit
    if result.status in ("ok", "skipped"):
        raise typer.Exit(0)
    elif result.status == "partial":
        raise typer.Exit(1)
    else:
        # error / pending_sync
        raise typer.Exit(2)


@curator_app.command("stats")
def curator_stats(
    collection_id: str = typer.Argument(..., help="collection id"),
) -> None:
    """collection 큐레이션 통계 (events/changes/reviews 집계)."""
    from raven.curator import db, reports

    conn = db.connect()
    db.init_schema(conn)
    stats = reports.curation_summary(conn, collection_id)
    conn.close()

    typer.echo(f"🐦‍⬛ raven curator stats — {collection_id}")
    for k, v in stats.items():
        typer.echo(f"   {k}: {v}")


@page_app.command("delete")
def page_delete(
    slug: str,
    vault: Optional[str] = typer.Option(None, "--vault"),
    force: bool = typer.Option(False, "--force"),
) -> None:
    """Archive page (moves to _archive/<original-path>-<timestamp>.md)."""
    v = _resolve_vault_or_die(vault)
    # v0.7.67 (평가 B#2): CLI/API/MCP가 각자 갖고 있던 archive 레시피를
    # core.archive.archive_page 단일 구현으로 수렴. slug validate + 존재
    # 확인은 confirm 프롬프트 전에 먼저 해 사용자가 "뭘 archive하는지" 알고
    # 확인하게 한다 (archive_page는 이 둘을 다시 한번 검증한다).
    try:
        safe_path = slug_module.validate(slug, vault_root=v.root)
    except slug_module.SlugError as e:
        typer.echo(f"❌ invalid slug: {e}", err=True)
        raise typer.Exit(1)
    if not safe_path.with_suffix(".md").exists():
        typer.echo(f"❌ not found: {slug}", err=True)
        raise typer.Exit(1)
    if not force:
        confirm = typer.confirm(f"Archive {slug!r}?", default=False)
        if not confirm:
            raise typer.Abort()
    result = archive_module.archive_page(v, slug)
    if not result.ok:
        typer.echo(f"❌ {result.error}", err=True)
        raise typer.Exit(1)
    typer.echo(f"✅ archived: {slug} → {result.archived_to}")


@page_app.command("rename")
def page_rename(
    old_slug: str,
    new_slug: str,
    vault: Optional[str] = typer.Option(None, "--vault", help="vault name (default: active)"),
) -> None:
    """Rename a page (slug), rewrite all inbound wikilinks, and rebuild DB."""
    v = _resolve_vault_or_die(vault)

    try:
        result = contracts.rename_page(v, old_slug, new_slug, actor="cli")
        if not result.ok:
            typer.echo(f"❌ Error: {result.message}", err=True)
            raise typer.Exit(1)
        db_module.build_db(v, run_lint=False)
        typer.echo(f"✅ Success: {result.message}")
    except typer.Exit:
        raise
    except Exception as e:
        typer.echo(f"❌ Error: {e}", err=True)
        raise typer.Exit(1)


# ────────────────────────── archive (vault _archive/ mgmt) ──────────────────────────


def _format_archive_entry(e) -> str:
    age = f"{e.age_days:.1f}d" if e.age_days is not None else "  ?  "
    ts = e.timestamp.strftime("%Y-%m-%d %H:%M") if e.timestamp else "(no ts)     "
    return f"  {age:>6s}  {ts}  {e.rel_path}  →  {e.original_slug}"


@archive_app.command("list")
def archive_list(
    vault: Optional[str] = typer.Option(None, "--vault"),
    older_than: int = typer.Option(0, "--older-than", help="only show entries older than N days (0 = all)"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """List all archived files in the active vault."""
    v = _resolve_vault_or_die(vault)
    entries = archive_module.list_archived(v)
    if older_than > 0:
        entries = [e for e in entries if e.age_days is not None and e.age_days > older_than]
    if json_out:
        typer.echo(json.dumps([e.to_dict() for e in entries], indent=2, ensure_ascii=False))
        return
    if not entries:
        typer.echo(f"📭 {v.meta.name}: no archived files" + (f" older than {older_than}d" if older_than else ""))
        return
    typer.echo(f"📦 {v.meta.name} — {len(entries)} archived files:")
    for e in entries:
        typer.echo(_format_archive_entry(e))


@archive_app.command("clean")
def archive_clean(
    vault: Optional[str] = typer.Option(None, "--vault"),
    older_than: int = typer.Option(30, "--older-than", help="delete entries older than N days (0 = all)"),
    apply: bool = typer.Option(False, "--apply", help="actually delete (default: dry-run)"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """Delete old archived files. Dry-run by default — use --apply to actually delete."""
    v = _resolve_vault_or_die(vault)
    result = archive_module.clean_archived(v, older_than_days=older_than, apply=apply)
    if json_out:
        typer.echo(json.dumps(result.to_dict(), indent=2, ensure_ascii=False))
        return
    target_label = "deleted" if apply else "would delete"
    target_list = result.deleted if apply else result.would_delete
    if not target_list:
        typer.echo(f"📭 {v.meta.name}: nothing to clean (older-than={older_than}d)")
        return
    if not apply:
        typer.echo(f"🔍 DRY-RUN: {len(target_list)} files would be deleted (use --apply to proceed):")
    else:
        typer.echo(f"✅ cleaned {len(target_list)} files:")
    for e in target_list:
        typer.echo(_format_archive_entry(e))
    if result.errors:
        typer.echo(f"❌ {len(result.errors)} errors:", err=True)
        for err in result.errors:
            typer.echo(f"   {err['path']}: {err['error']}", err=True)


@archive_app.command("restore")
def archive_restore(
    archive_path: str = typer.Argument(..., help="archive path (_archive/content/foo-20260625-123456.md) 또는 원래 slug (content/foo — 최신본 복원)"),
    vault: Optional[str] = typer.Option(None, "--vault"),
) -> None:
    """Restore an archived file back to its original slug location."""
    v = _resolve_vault_or_die(vault)
    result = archive_module.restore_archived(v, archive_path)
    if result.ok:
        typer.echo(f"✅ restored: {archive_path} → {result.restored_to}")
    else:
        typer.echo(f"❌ {result.error}", err=True)
        raise typer.Exit(1)


# ────────────────────────── link ──────────────────────────


@link_app.command("check")
def link_check(
    slug: Optional[str] = typer.Option(None, help="limit to one page (else whole vault)"),
    vault: Optional[str] = typer.Option(None, "--vault"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """Find broken / missing wikilinks in the active vault."""
    v = _resolve_vault_or_die(vault)
    broken = link_module.find_broken(v, slug=slug)
    missing = link_module.find_missing(v, slug=slug)
    if json_out:
        typer.echo(json.dumps({"broken": broken, "missing": missing}, indent=2, ensure_ascii=False))
        return
    typer.echo(f"🔗 {v.meta.name} — {len(broken)} broken, {len(missing)} missing")
    if broken:
        typer.echo("\n❌ broken (auto link with no target):")
        for b in broken[:20]:
            typer.echo(f"   {b['source_slug']} → [[{b['target']}]]")
        if len(broken) > 20:
            typer.echo(f"   ... +{len(broken) - 20} more")
    if missing:
        typer.echo("\n🔍 missing (intentional placeholders, no target yet):")
        for m in missing[:20]:
            typer.echo(f"   {m['source_slug']} → [[{m['target']}]]?")
        if len(missing) > 20:
            typer.echo(f"   ... +{len(missing) - 20} more")
    if not broken and not missing:
        typer.echo("✅ all wikilinks resolve or are intentional")


# ────────────────────────── build / export ──────────────────────────


@app.command()
def build(
    vault: Optional[str] = typer.Option(None, "--vault"),
    db: Optional[Path] = typer.Option(None, "--db", help="output db path (default: <vault>/wiki.db)"),
    lint_after: bool = typer.Option(True, "--lint/--no-lint", help="build 직후 lint 실행"),
) -> None:
    """Rebuild wiki.db for the active vault. lint 자동 실행."""
    v = _resolve_vault_or_die(vault)
    result = db_module.build_db(v, db_path=db, run_lint=lint_after)
    if result["ok"]:
        typer.echo(f"✅ built: {result.get('db_path') or v.db_path}")
        if "pages" in result:
            typer.echo(f"   pages: {result['pages']}")
        if lint_after and "lint" in result:
            c = result["lint"]["counts"]
            typer.echo(f"   lint: {c.get('critical', '?')}C / {c.get('warning', '?')}W / {c.get('info', '?')}I")
    else:
        typer.echo(f"❌ build failed (rc={result.get('returncode')})", err=True)
        typer.echo(result.get("stderr_tail", ""), err=True)
        raise typer.Exit(1)


@app.command()
def search(
    query: str = typer.Argument(..., help="검색어 (FTS5 BM25)"),
    vault: Optional[str] = typer.Option(None, "--vault"),
    top_k: int = typer.Option(10, "--top-k", help="상위 N건"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """Search pages in the active vault (FTS5 BM25, wiki.db 기반)."""
    # v0.7.66 (평가 P2#15): 사람의 검색 경로가 Dashboard/API/MCP뿐이었음.
    v = _resolve_vault_or_die(vault)
    if not v.db_path.exists():
        typer.echo("❌ wiki.db 없음 — `raven build` 먼저 실행하세요.", err=True)
        raise typer.Exit(1)
    try:
        results = db_module.search_fts(query=query, top_k=top_k, vault=v.root)
    except Exception as e:
        typer.echo(f"❌ 검색 실패: {e}", err=True)
        raise typer.Exit(1)
    if json_out:
        typer.echo(json.dumps(results, ensure_ascii=False, indent=2))
        return
    if not results:
        typer.echo(f"🔍 {v.meta.name} — '{query}' 결과 없음")
        return
    typer.echo(f"🔍 {v.meta.name} — '{query}' 상위 {len(results)}건")
    for r in results:
        typer.echo(f"  {r['slug']}  — {r.get('title') or ''}")
        snippet = (r.get("snippet") or "").replace("\n", " ").strip()
        if snippet:
            typer.echo(f"      {snippet}")


@app.command()
def export(
    vault: Optional[str] = typer.Option(None, "--vault"),
    out_dir: Optional[Path] = typer.Option(None, "--out", help="output dir (default: <codebase>/dashboard/public/api)"),
) -> None:
    """Export static JSON for the GUI (index/tree/graph/page-*/search)."""
    v = _resolve_vault_or_die(vault)
    result = export_module.export_static(v, out_dir=out_dir)
    if result.get("ok"):
        typer.echo(f"✅ exported: {result.get('out_dir')} (vault={v.meta.name})")
    else:
        reason = result.get("reason") or result.get("stdout_tail") or "?"
        typer.echo(f"❌ export failed: {reason.strip()}", err=True)
        typer.echo(result.get("stderr_tail", ""), err=True)
        raise typer.Exit(1)


# ────────────────────────── log (log.md 작업 이력) ──────────────────────────


def _format_log_entry(e: dict) -> str:
    """Format one log entry for human display."""
    header = f"  [{e['date']}] {e['action']:8s} | {e['subject']}"
    if e.get("details"):
        details_str = "; ".join(e["details"])
        return f"{header}\n      {details_str}"
    return header


@log_app.command("list")
def log_list(
    tail: Optional[int] = typer.Option(None, "--tail", "-n", help="최근 N개만 표시"),
    action: Optional[str] = typer.Option(None, "--action", "-a", help="액션 필터 (ingest/update/create/lint/build/...)"),
    vault: Optional[str] = typer.Option(None, "--vault"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """log.md의 작업 이력 조회."""
    v = _resolve_vault_or_die(vault)
    entries = log_module.list_entries(v, tail=tail, action=action)
    total = log_module.count(v)
    if json_out:
        typer.echo(json.dumps({
            "vault": v.meta.name,
            "total": total,
            "shown": len(entries),
            "entries": entries,
        }, indent=2, ensure_ascii=False))
        return
    typer.echo(f"📜 {v.meta.name} — {total} entries total, showing {len(entries)}")
    if not entries:
        typer.echo("   (empty — 첫 entry는 다음 작업 시 자동 생성)")
        return
    for e in entries:
        typer.echo(_format_log_entry(e))


@log_app.command("show")
def log_show(
    vault: Optional[str] = typer.Option(None, "--vault"),
    limit: int = typer.Option(20, "--limit", "-n"),
) -> None:
    """log.md 원본 (raw) 표시 — grep-style 확인용."""
    v = _resolve_vault_or_die(vault)
    path = log_module.log_path(v)
    if not path.exists():
        typer.echo(f"❌ log.md 없음: {path}", err=True)
        typer.echo(f"   자동 생성: `raven log append` 또는 `raven build`", err=True)
        raise typer.Exit(1)
    typer.echo(f"📄 {path} (last {limit} lines):\n")
    lines = path.read_text(encoding="utf-8").splitlines()
    for line in lines[-limit:]:
        typer.echo(line)


@log_app.command("append")
def log_append(
    subject: str = typer.Argument(..., help="entry 제목"),
    action: str = typer.Option("chore", "--action", "-a", help="ingest|update|create|archive|delete|lint|build|migrate|chore"),
    files: str = typer.Option("", "--files", help="콤마로 구분된 변경 파일 리스트"),
    note: str = typer.Option("", "--note", help="추가 메모"),
    vault: Optional[str] = typer.Option(None, "--vault"),
) -> None:
    """log.md에 수동 entry 추가 (자동 append 외 별도 기록용)."""
    v = _resolve_vault_or_die(vault)
    files_list = [f.strip() for f in files.split(",") if f.strip()] if files else None
    try:
        entry = log_module.append(
            v,
            action=action,
            subject=subject,
            files=files_list,
            note=note or None,
        )
    except ValueError as e:
        typer.echo(f"❌ {e}", err=True)
        raise typer.Exit(1)
    typer.echo(f"✅ appended: {entry.header()}")


@log_app.command("rotate")
def log_rotate(
    vault: Optional[str] = typer.Option(None, "--vault"),
    year: Optional[int] = typer.Option(None, "--year", help="rotate 파일명 연도 (기본: 현재 연도)"),
    force: bool = typer.Option(False, "--force", help="500 entries 미만이어도 강제 rotate"),
) -> None:
    """log.md를 log-YYYY.md로 rotate (500 entries 초과 시 자동)."""
    v = _resolve_vault_or_die(vault)
    total = log_module.count(v)
    if total < 500 and not force:
        typer.echo(f"⚠️  {total} entries (500 미만) — 강제 rotate는 --force")
        raise typer.Exit(1)
    target = log_module.rotate(v, year=year)
    typer.echo(f"✅ rotated: log.md → {target.name} ({total} entries 보관)")


@log_app.command("status")
def log_status(
    vault: Optional[str] = typer.Option(None, "--vault"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """log.md 상태 (entries 수, last entry, rotation 필요 여부)."""
    v = _resolve_vault_or_die(vault)
    path = log_module.log_path(v)
    total = log_module.count(v)
    entries = log_module.list_entries(v, tail=1)
    last = entries[0] if entries else None
    needs_rotate = total >= 500
    info = {
        "vault": v.meta.name,
        "log_path": str(path),
        "exists": path.exists(),
        "total_entries": total,
        "last_entry": last,
        "needs_rotate": needs_rotate,
        "rotate_threshold": 500,
    }
    if json_out:
        typer.echo(json.dumps(info, indent=2, ensure_ascii=False))
        return
    typer.echo(f"📜 {v.meta.name} log status:")
    typer.echo(f"   path:     {path}")
    typer.echo(f"   exists:   {path.exists()}")
    typer.echo(f"   entries:  {total} / 500")
    if last:
        typer.echo(f"   last:     [{last['date']}] {last['action']} | {last['subject']}")
    if needs_rotate:
        typer.echo(f"   ⚠️  rotation 권장: `raven log rotate`")


# ────────────────────────── lint (CHECK_REGISTRY 기반) ──────────────────────────


@lint_app.command("run")
def lint_run(
    vault: Optional[str] = typer.Option(None, "--vault"),
    check: Optional[str] = typer.Option(None, "--check", "-c", help="특정 check만 (예: #4)"),
    severity: Optional[str] = typer.Option(None, "--severity", "-s", help="critical|warning|info 만 표시"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="이슈 전체 표시"),
    json_out: bool = typer.Option(False, "--json"),
    write_log: bool = typer.Option(False, "--log", help="log.md에 lint entry 자동 append"),
) -> None:
    """vault에 대해 lint 전체 check 실행."""
    v = _resolve_vault_or_die(vault)
    result = lint_module.run_all(v)
    issues = result["issues"]
    # filter
    if check:
        issues = [i for i in issues if i.get("id") == check]
    if severity:
        issues = [i for i in issues if i.get("severity") == severity]
    if json_out:
        typer.echo(json.dumps({
            "vault": result["vault"],
            "ok": result["ok"],
            "counts": result["counts"],
            "by_check": result["by_check"],
            "issues": issues,
        }, indent=2, ensure_ascii=False))
        return
    c = result["counts"]
    marker = "✅" if result["ok"] else "❌"
    typer.echo(f"{marker} {result['vault']} — {c['critical']}C / {c['warning']}W / {c['info']}I (total {c['total']})")
    if result["by_check"]:
        typer.echo(f"\n📊 by check:")
        for cid in sorted(result["by_check"].keys()):
            n = result["by_check"][cid]
            typer.echo(f"   {cid}: {n}")
    if verbose and issues:
        typer.echo(f"\n🔍 issues ({len(issues)}):")
        for iss in issues[:50]:
            typer.echo(f"  [{iss.get('id', '?'):3s}] {iss.get('severity', '?'):8s} {iss.get('slug', '?'):40s} {iss.get('message', '')}")
        if len(issues) > 50:
            typer.echo(f"   ... +{len(issues) - 50} more (--json으로 전체 확인)")
    # log 기록
    if write_log:
        try:
            log_module.append(
                v,
                action="lint",
                subject=f"lint {len(lint_module.CHECK_REGISTRY)}개 ({c['critical']}C/{c['warning']}W/{c['info']}I)",
                extra={"by_check": json.dumps(result["by_check"], ensure_ascii=False)},
            )
        except Exception:
            pass
    # critical 있으면 exit 1
    if c["critical"] > 0:
        raise typer.Exit(1)


@lint_app.command("summary")
def lint_summary(
    vault: Optional[str] = typer.Option(None, "--vault"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """check별 통계 (빠른 헬스체크)."""
    v = _resolve_vault_or_die(vault)
    result = lint_module.run_all(v)
    if json_out:
        typer.echo(json.dumps({
            "vault": result["vault"],
            "ok": result["ok"],
            "counts": result["counts"],
            "by_check": result["by_check"],
        }, indent=2, ensure_ascii=False))
        return
    c = result["counts"]
    typer.echo(f"📊 {result['vault']} lint summary:")
    typer.echo(f"   total:     {c['total']}")
    typer.echo(f"   critical:  {c['critical']} 🔴")
    typer.echo(f"   warning:   {c['warning']}  🟡")
    typer.echo(f"   info:      {c['info']}     🔵")
    typer.echo(f"\n   by check:")
    for cid in sorted(lint_module.CHECK_REGISTRY, key=lambda c: int(c[1:])):
        n = result["by_check"].get(cid, 0)
        bar = "█" * min(n, 20)
        typer.echo(f"     {cid}  {n:3d}  {bar}")


@lint_app.command("check")
def lint_check(
    check_id: str = typer.Argument(..., help="실행할 check id (예: #4)"),
    vault: Optional[str] = typer.Option(None, "--vault"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """특정 check 1개만 실행 (디버깅/타겟 검증)."""
    v = _resolve_vault_or_die(vault)
    meta = lint_module.CHECK_REGISTRY.get(check_id)
    if meta is None:
        typer.echo(
            f"❌ unknown check: {check_id}. "
            f"{', '.join(sorted(lint_module.CHECK_REGISTRY, key=lambda c: int(c[1:])))} 중 하나.",
            err=True,
        )
        raise typer.Exit(1)
    fn_name = meta.get("fn")
    if fn_name is None:
        typer.echo(
            f"❌ {check_id} ({meta['name']})는 link_module 기반이라 개별 실행을 "
            f"지원하지 않습니다 — `raven link check` 사용",
            err=True,
        )
        raise typer.Exit(1)
    fn = getattr(lint_module, fn_name)
    issues = fn(v)
    if json_out:
        typer.echo(json.dumps(issues, indent=2, ensure_ascii=False))
        return
    if not issues:
        typer.echo(f"✅ {check_id} ({meta['name']}): no issues")
        return
    typer.echo(f"🔍 {check_id} ({meta['name']}): {len(issues)} issues")
    for iss in issues:
        typer.echo(f"  [{iss.get('severity', '?'):8s}] {iss.get('slug', '?'):40s} {iss.get('message', '')}")


# ────────────────────────── migrate (v0.5.2+) ──────────────────────────


_CATEGORY_LABELS = {
    "broken_to_missing": "broken wikilink → missing placeholder",
    "orphan_cleanup": "orphan 페이지 archive",
    "page_size_split": "200줄+ 페이지 분할 (수동)",
    "tag_promotion": "custom tag → core 승격 (수동)",
    "frontmatter_fill": "frontmatter created/updated 채움",
}


@migrate_app.command("plan")
def migrate_plan(
    vault: Optional[str] = typer.Option(None, "--vault"),
    category: Optional[str] = typer.Option(None, "--category", "-c", help="특정 카테고리만 (broken_to_missing, orphan_cleanup, ...)"),
    apply: bool = typer.Option(False, "--apply", help="실제 적용 (기본 dry-run)"),
    risk: Optional[str] = typer.Option(None, "--risk", help="적용 시 risk 단계만 (safe | review)"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """vault 마이그레이션 plan (lint 5 카테고리 분류).

    기본 = dry-run (데이터 변경 ❌). --apply 명시 시에만 실제 적용.
    """
    v = _resolve_vault_or_die(vault)
    cats = [category] if category else None
    plan = migrate_module.make_plan(v, categories=cats)
    if apply:
        if not typer.confirm(f"정말 {len(plan.fixes)}개 fix를 적용할까요?", default=False):
            typer.echo("❌ cancelled")
            raise typer.Abort()
        result = migrate_module.apply_plan(v, plan, risk_filter=risk)
        # log에 기록
        try:
            log_module.append(
                v, action="migrate",
                subject=f"migration apply (applied={len(result['applied'])}, skipped={len(result['skipped'])})",
                extra={"applied": str(len(result["applied"])), "skipped": str(len(result["skipped"]))},
            )
        except Exception:
            pass
        if json_out:
            typer.echo(json.dumps(result, indent=2, ensure_ascii=False))
            return
        typer.echo(f"✅ applied: {len(result['applied'])}")
        for a in result["applied"][:20]:
            typer.echo(f"   [{a['category']:20s}] {a['slug']:40s} ({a['action']})")
        if len(result["applied"]) > 20:
            typer.echo(f"   ... +{len(result['applied']) - 20} more")
        typer.echo(f"\n⚠️  skipped: {len(result['skipped'])}")
        for s in result["skipped"][:10]:
            typer.echo(f"   {s['slug']:40s} ({s['reason']})")
        if result["errors"]:
            typer.echo(f"\n❌ errors: {len(result['errors'])}", err=True)
            for e in result["errors"]:
                typer.echo(f"   {e['slug']}: {e['error']}", err=True)
        return
    # dry-run
    summary = plan.summary()
    if json_out:
        typer.echo(json.dumps({
            **summary,
            "fixes": [
                {"category": f.category, "slug": f.slug, "description": f.description, "risk": f.risk}
                for f in plan.fixes
            ],
        }, indent=2, ensure_ascii=False))
        return
    typer.echo(f"📋 {summary['vault']} migration plan (DRY-RUN):")
    typer.echo(f"   total fixes:    {summary['total_fixes']}")
    typer.echo(f"   safe (auto):    {summary['by_risk']['safe']} ✅")
    typer.echo(f"   review (확인):  {summary['by_risk']['review']} 🟡")
    typer.echo(f"   manual (수동):  {summary['by_risk']['manual']} 🔵")
    if summary["lint_summary"]:
        typer.echo(f"\n   lint context: {summary['lint_summary']}")
    typer.echo(f"\n📊 by category:")
    for cat in migrate_module.CATEGORIES:
        n = summary["by_category"].get(cat, 0)
        if n == 0:
            continue
        typer.echo(f"   {cat:20s} {n:3d}  {_CATEGORY_LABELS.get(cat, '')}")
    if plan.fixes:
        typer.echo(f"\n🔍 fixes (first 20):")
        for f in plan.fixes[:20]:
            risk_icon = "✅" if f.risk == "safe" else "🟡" if f.risk == "review" else "🔵"
            typer.echo(f"   {risk_icon} [{f.category:18s}] {f.slug:35s} {f.description[:60]}")
        if len(plan.fixes) > 20:
            typer.echo(f"   ... +{len(plan.fixes) - 20} more")
    typer.echo(f"\n💡 적용:  raven migrate plan --vault {v.meta.name} --apply")
    typer.echo(f"   안전만: raven migrate plan --vault {v.meta.name} --apply --risk safe")


@migrate_app.command("apply")
def migrate_apply(
    vault: Optional[str] = typer.Option(None, "--vault"),
    category: Optional[str] = typer.Option(None, "--category", "-c"),
    risk: Optional[str] = typer.Option(None, "--risk", help="safe | review (default: safe만)"),
    yes: bool = typer.Option(False, "--yes", "-y", help="확인 prompt skip"),
) -> None:
    """plan + apply 한 번에. --yes 없으면 confirm."""
    v = _resolve_vault_or_die(vault)
    cats = [category] if category else None
    plan = migrate_module.make_plan(v, categories=cats)
    risk_filter = risk or "safe"
    if not yes:
        if not typer.confirm(f"정말 {len(plan.fixes)}개 fix (risk={risk_filter}) 적용?", default=False):
            typer.echo("❌ cancelled")
            raise typer.Abort()
    result = migrate_module.apply_plan(v, plan, risk_filter=risk_filter)
    try:
        log_module.append(
            v, action="migrate",
            subject=f"migration apply --risk {risk_filter} (applied={len(result['applied'])})",
        )
    except Exception:
        pass
    typer.echo(f"✅ applied: {len(result['applied'])}")
    typer.echo(f"⚠️  skipped: {len(result['skipped'])}")
    if result["errors"]:
        typer.echo(f"❌ errors: {len(result['errors'])}", err=True)


@migrate_app.command("categories")
def migrate_categories(json_out: bool = typer.Option(False, "--json")) -> None:
    """5개 카테고리 + 위험도 설명."""
    if json_out:
        typer.echo(json.dumps({c: _CATEGORY_LABELS[c] for c in migrate_module.CATEGORIES}, indent=2, ensure_ascii=False))
        return
    typer.echo("📋 migration categories (5):")
    for cat in migrate_module.CATEGORIES:
        typer.echo(f"   {cat:20s} — {_CATEGORY_LABELS[cat]}")
    typer.echo(f"\n💡 dry-run:  raven migrate plan --vault <name>")
    typer.echo(f"   apply:    raven migrate plan --vault <name> --apply")


@app.command("garden")
def raven_garden(
    vault: Optional[str] = typer.Option(None, "--vault", "-v", help="대상 vault 이름"),
    stale: bool = typer.Option(False, "--stale", help="Stale 문서 정리만 실행"),
    orphan: bool = typer.Option(False, "--orphan", help="Orphan 문서 정리만 실행"),
) -> None:
    """지식 정원 가꾸기 (Knowledge Gardening) — Stale 및 Orphan 문서 정리."""
    v = _resolve_vault_or_die(vault)
    
    run_all = not stale and not orphan
    run_stale = stale or run_all
    run_orphan = orphan or run_all
    
    from raven.core.garden import get_stale_pages, get_orphan_pages, find_link_candidates, db_is_stale
    from raven.core import contracts as contracts_module
    from raven.core import archive as archive_module
    import sys

    # v0.7.66 (평가 P1#12): garden은 wiki.db 기준 — DB가 낡으면 거짓 안심을 준다.
    if db_is_stale(v):
        typer.echo(
            "⚠️  wiki.db가 마크다운보다 오래되었습니다 — 아래 결과가 부정확할 수 "
            "있습니다. `raven build` 후 다시 실행하세요."
        )

    # 1. Stale Pages Gardening
    if run_stale:
        stale_list = get_stale_pages(v)
        if not stale_list:
            typer.echo("✨ Stale (90일+ 미갱신) 문서가 없습니다.")
        else:
            typer.echo(f"📊 Stale 문서 목록 ({len(stale_list)}개):")
            for idx, item in enumerate(stale_list):
                typer.echo(f"  [{idx + 1}] {item['slug']} (updated: {item['updated']}, {item['age_days']}일 경과)")
            
            for item in stale_list:
                slug = item["slug"]
                typer.echo(f"\n🌱 문서 정원 관리 대상: {slug} ({item['age_days']}일 경과)")
                ans = typer.prompt(
                    "액션을 선택하세요. [u]pdate(보완), [a]rchive(아카이브), [s]kip(건너뛰기), [q]uit(종료)",
                    default="s"
                ).lower().strip()
                
                if ans == "q":
                    typer.echo("👋 Gardening을 종료합니다.")
                    sys.exit(0)
                elif ans == "u":
                    typer.echo(f"✏️  문서 '{slug}'를 업데이트합니다. 내용을 입력하세요 (종료하려면 Ctrl+D):")
                    lines = []
                    try:
                        while True:
                            line = input()
                            lines.append(line)
                    except EOFError:
                        pass
                    new_content = "\n".join(lines)
                    if new_content.strip():
                        res = contracts_module.write_page(v, slug, new_content, overwrite=True)
                        if res.ok:
                            typer.echo(f"✅ 업데이트 완료: {slug}")
                        else:
                            typer.echo(f"❌ 업데이트 실패: {res.error}")
                    else:
                        typer.echo("⚠️ 내용이 없어 업데이트를 취소합니다.")
                elif ans == "a":
                    if typer.confirm(f"정말 '{slug}' 문서를 아카이브 폴더로 이동할까요?", default=False):
                        res = archive_module.archive_page(v, slug)
                        if res.ok:
                            typer.echo(f"✅ 아카이브 완료: {slug}")
                        else:
                            typer.echo(f"❌ 아카이브 실패: {res.error}")
                elif ans == "s":
                    typer.echo("건너뜁니다.")

    # 2. Orphan Pages Gardening
    if run_orphan:
        orphan_list = get_orphan_pages(v)
        if not orphan_list:
            typer.echo("✨ Orphan (인바운드 0) 문서가 없습니다.")
        else:
            typer.echo(f"\n📊 Orphan 문서 목록 ({len(orphan_list)}개):")
            for idx, item in enumerate(orphan_list):
                typer.echo(f"  [{idx + 1}] {item['slug']} (created: {item['created']}, {item['age_days']}일 경과)")
            
            for item in orphan_list:
                slug = item["slug"]
                typer.echo(f"\n🌱 외톨이 문서 연결 대상: {slug} ({item['age_days']}일 경과)")
                
                candidates = find_link_candidates(v, slug)
                if candidates:
                    typer.echo("💡 연결 가능한 추천 문서:")
                    for idx, cand in enumerate(candidates):
                        typer.echo(f"  ({idx + 1}) {cand['slug']} [{cand['title']}] ({cand['reason']})")
                else:
                    typer.echo("💡 추천 문서가 없습니다.")
                
                ans = typer.prompt(
                    "액션을 선택하세요. [l]ink(링크 맺기), [a]rchive(아카이브), [s]kip(건너뛰기), [q]uit(종료)",
                    default="s"
                ).lower().strip()
                
                if ans == "q":
                    typer.echo("👋 Gardening을 종료합니다.")
                    sys.exit(0)
                elif ans == "l":
                    target = typer.prompt("연결할 대상 문서의 slug를 입력하세요").strip()
                    if target:
                        target_path = v.content_root / f"{target}.md"
                        if not target_path.exists():
                            target_path = v.root / f"{target}.md"
                        
                        if target_path.exists():
                            orig_text = target_path.read_text(encoding="utf-8")
                            updated_text = orig_text.rstrip() + f"\n\n관련 연결:\n- [[{slug}]]\n"
                            res = contracts_module.write_page(v, target, updated_text, overwrite=True)
                            if res.ok:
                                typer.echo(f"✅ 연결 완료! '{target}' 문서에 [[{slug}]] 링크를 추가했습니다.")
                            else:
                                typer.echo(f"❌ 연결 실패: {res.error}")
                        else:
                            typer.echo(f"❌ 대상 문서가 존재하지 않습니다: {target}")
                elif ans == "a":
                    if typer.confirm(f"정말 '{slug}' 문서를 아카이브 폴더로 이동할까요?", default=False):
                        res = archive_module.archive_page(v, slug)
                        if res.ok:
                            typer.echo(f"✅ 아카이브 완료: {slug}")
                        else:
                            typer.echo(f"❌ 아카이브 실패: {res.error}")
                elif ans == "s":
                    typer.echo("건너뜁니다.")


# ────────────────────────── entrypoint ──────────────────────────


def main() -> int:
    try:
        app()
    except KeyboardInterrupt:
        return 130
    return 0


# ────────────────────────── docs (Tier 1 raven-internal) ──────────────────────────
# v2026-06-26: 2-tier boundary enforcement. These docs are Tier 1 (raven package),
# not Tier 2 (user vault). They are never copied into vaults automatically.
# Use `raven docs <topic>` to read them.


@docs_app.command("list")
def docs_list() -> None:
    """List available Tier 1 raven-internal docs."""
    from importlib import resources

    items = [
        ("operations", "templates/system/OPERATIONS.md", "Raven 빌드/lint/마이그레이션 운영"),
        ("agent-tools", "templates/agent/TOOLS.md", "에이전트 인터페이스 + scope"),
        ("policy", "templates/wikisys-policy.md", "raven 운영 정책"),
    ]
    typer.echo("📚 Tier 1 raven-internal docs (vault에 복사되지 않음):\n")
    for name, path, desc in items:
        exists = resources.files("raven.core").joinpath(path).is_file()
        marker = "✓" if exists else "✗"
        typer.echo(f"  {marker} {name:20s} {desc}")
    typer.echo(f"\n💡 사용법: raven docs show operations  (또는: raven docs show policy)")


@docs_app.command("show")
def docs_show(
    topic: str = typer.Argument(
        ...,
        help="operations | agent-tools | policy",
    ),
) -> None:
    """Print a Tier 1 doc to stdout. Never writes to disk."""
    from importlib import resources
    topic_map = {
        "operations": "templates/system/OPERATIONS.md",
        "agent-tools": "templates/agent/TOOLS.md",
        "policy": "templates/wikisys-policy.md",
    }
    if topic not in topic_map:
        typer.echo(f"❌ unknown topic: {topic!r}. Try: {', '.join(topic_map)}", err=True)
        raise typer.Exit(code=1)

    src = resources.files("raven.core").joinpath(topic_map[topic])
    if not src.is_file():
        typer.echo(f"❌ doc not found: {topic_map[topic]}", err=True)
        raise typer.Exit(code=1)

    typer.echo(src.read_text(encoding="utf-8"))


@app.command("ingest")
def raven_ingest(
    source_path: str = typer.Argument(..., help="Ingest할 소스 파일 또는 디렉토리 경로"),
    vault: Optional[str] = typer.Option(None, "--vault", "-v", help="대상 vault 이름"),
) -> None:
    """외부 자료를 raw/ 폴더로 Ingest하고 wiki.db 및 index.md를 빌드합니다."""
    import shutil
    from raven.core import log as log_module
    from raven.core.db import build_db

    v = _resolve_vault_or_die(vault)
    
    src = Path(source_path)
    if not src.exists():
        typer.echo(f"❌ 소스 파일이 존재하지 않습니다: {source_path}")
        raise typer.Exit(code=1)

    raw_dir = v.root / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    dest = raw_dir / src.name
    try:
        if src.is_dir():
            shutil.copytree(src, dest, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dest)
        typer.echo(f"📥 소스 복사 완료: {src} -> {dest}")
    except Exception as e:
        typer.echo(f"❌ 소스 복사 실패: {e}")
        raise typer.Exit(code=1)

    # log.md에 ingest 기록
    try:
        log_module.append(
            v,
            action="ingest",
            subject=f"ingested {src.name}",
            files=[str(dest.relative_to(v.root))],
            note=f"source={source_path}"
        )
    except Exception as le:
        typer.echo(f"⚠️  log.md 갱신 실패: {le}")

    # wiki.db 및 index.md 자동 갱신을 위해 build_db 호출
    typer.echo("🔨 wiki.db 빌드 및 index.md 갱신을 시작합니다...")
    build_result = build_db(v, run_lint=True)
    if build_result.get("ok"):
        typer.echo("✅ Ingest 및 빌드가 성공적으로 끝났습니다.")
        typer.echo(f"💡 이제 에이전트(MCP)에게 '{src.name}'에 기반한 위키 정제(Curation)를 요청하십시오.")
    else:
        typer.echo("⚠️  빌드 중 오류가 발생했습니다. log.md를 확인하십시오.")


if __name__ == "__main__":
    sys.exit(main())

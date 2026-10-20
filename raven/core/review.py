"""raven.core.review — 에이전트가 쓴 초안(status: draft)의 검토 대기열과 승인.

spec: docs/superpowers/specs/2026-10-20-draft-review-queue-design.md

승인은 status를 current로 바꾸고 tags에서 draft만 뺀다. 본문과 나머지 frontmatter는 그대로 두고,
쓰기는 contracts.write_page를 탄다. 누가 승인할 수 있는지(운영자 전용)는 API 게이트가 정한다.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

from raven.core import frontmatter as frontmatter_module
from raven.core import log as log_module
from raven.core import slug as slug_module
from raven.core.contracts import precondition_for_path, write_page
from raven.core.vault import Vault

DRAFT = "draft"
APPROVED = "approved"
NOT_FOUND = "not_found"
NOT_DRAFT = "not_draft"
STALE = "stale_precondition"
ERROR = "error"


def _status(meta: dict) -> str:
    value = meta.get("status")
    return value.strip() if isinstance(value, str) else ""


def _last_agent(meta: dict) -> Optional[str]:
    agents = meta.get("agents")
    if not isinstance(agents, list) or not agents:
        return None
    last = agents[-1]
    if isinstance(last, dict):
        name = last.get("name")
        return str(name) if name else None
    return str(last) if last else None


def _tags_without_draft(meta: dict) -> Optional[list[str]]:
    """draft를 뺀 tags. 원래 tags 키가 없으면 None (write_page가 그대로 둔다)."""
    if "tags" not in meta:
        return None
    raw = meta["tags"]
    if isinstance(raw, str):
        items = raw.split(",")
    elif isinstance(raw, (list, tuple)):
        items = list(raw)
    else:
        items = []
    return [t for t in (str(x).strip() for x in items) if t and t != DRAFT]


def list_drafts(vault: Vault) -> list[dict]:
    """content/ 아래 status: draft 문서. updated 내림차순, 같으면 제목순."""
    rows: list[dict] = []
    for fp in vault.content_root.rglob("*.md"):
        try:
            meta, _ = frontmatter_module.parse(fp.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if _status(meta) != DRAFT:
            continue
        slug = fp.relative_to(vault.root).as_posix()[:-3]
        rows.append({
            "slug": slug,
            "title": str(meta.get("title") or slug),
            "type": str(meta.get("type") or "?"),
            "created": str(meta.get("created") or ""),
            "updated": str(meta.get("updated") or ""),
            "last_agent": _last_agent(meta),
        })
    rows.sort(key=lambda r: r["title"])
    rows.sort(key=lambda r: r["updated"], reverse=True)
    return rows


def _resolve(vault: Vault, slug: str) -> Optional[Path]:
    try:
        safe = slug_module.validate(slug_module.normalize_prefix(slug), vault_root=vault.root)
    except slug_module.SlugError:
        return None
    fp = safe.with_suffix(".md")
    return fp if fp.is_file() else None


def _approve_one(vault: Vault, slug: str, precondition: Optional[str]) -> str:
    fp = _resolve(vault, slug)
    if fp is None:
        return NOT_FOUND
    # 읽는 시점의 토큰을 write_page에 넘겨, 읽기와 쓰기 사이에 바뀐 문서를 덮어쓰지 않는다.
    token = precondition_for_path(fp)
    if precondition is not None and precondition != token:
        return STALE
    meta, body = frontmatter_module.parse(fp.read_text(encoding="utf-8"))
    if _status(meta) != DRAFT:
        return NOT_DRAFT
    result = write_page(
        vault,
        slug,
        body,
        tags=_tags_without_draft(meta),
        extra_meta={"status": "current"},
        overwrite=True,
        enforce_protected_paths=True,
        append_log=False,
        precondition=token,
    )
    if not result.ok:
        return STALE if result.error == "stale_precondition" else ERROR
    try:
        log_module.append(
            vault,
            action="update",
            subject=result.slug,
            files=[result.slug],
            note="검토 승인: draft → current",
        )
    except Exception:
        pass  # write_page와 같이 로그는 best-effort
    return APPROVED


def approve(vault: Vault, items: Iterable[dict]) -> list[dict]:
    """items: [{"slug", "precondition"?}]. 건별로 처리하고 실패해도 나머지는 반영한다."""
    return [
        {"slug": item["slug"], "result": _approve_one(vault, item["slug"], item.get("precondition"))}
        for item in items
    ]

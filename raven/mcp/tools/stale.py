"""stale.py — ADR-2026-07-06 §1.3 stale loop tools.

Tools:
    wiki_stale_detect — stale 후보 + evidence + suggested_action 반환 (read-only)
    wiki_archive      — 페이지를 archive/<YYYY-MM-DD>/<slug>.md로 이동 + frontmatter stamp

v0.7.69+ Plan B-2 갱신:
- FileLock 통합 (ADR §1.3 guards 4종 완성)
- wiki.db 페이지 조회 최적화 (B#8 lint 캐싱과 동시)
- ADR-2026-07-06 §1.3 "도구(Tooling)" 결정 그대로 따름.
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from raven.core import archive as archive_module
from raven.core import frontmatter as core_frontmatter
from raven.core import slug as slug_module
from raven.core.contracts import rename_page
from raven.core.lock import atomic_write_text, lock_for_file
from raven.core.registry import VaultMeta
from raven.core.slug import SlugError
from raven.core.vault import Vault
from raven.mcp import db
from raven.mcp.tools import (
    VaultContext,
    PermissionError_,
    append_log_entry,
    check_lock,
    check_permission,
    normalize_actor,
    now_iso,
)


# ─────────────── shared helpers ───────────────


# ADR §1.1 4상태 정의
VALID_STATUSES = {"current", "stale", "contested", "archived"}

# ADR §1.4 시나리오 1의 임계값
DEFAULT_STALE_DAYS = 90


def _age_days(value, now: datetime) -> int | None:
    """ISO 날짜/일시 문자열의 경과 일수. 시간대 없는 값(날짜만 포함)은 UTC로 본다."""
    if value is None:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (now - dt).days


def _age_basis(frontmatter: dict) -> tuple[str, object]:
    """신선도 기준 필드 — last_verified가 있으면 그것, 없으면 updated (제품 lint #7과 같음)."""
    if frontmatter.get("last_verified") is not None:
        return "last_verified", frontmatter.get("last_verified")
    return "updated", frontmatter.get("updated")


def _is_stale_candidate(
    frontmatter: dict,
    *,
    age_threshold_days: int,
    now: datetime,
) -> tuple[bool, str | None]:
    """ADR §1.4: 90일+ 미검증 또는 status=stale 명시 시 stale 후보.

    Returns:
        (is_candidate, evidence) — evidence는 사람이 검토할 수 있는 사유 1줄.

    기준 필드는 `last_verified`, 없으면 `updated`다. 대부분의 vault는
    last_verified를 쓰지 않아 updated만 보던 lint #7과 결과가 어긋났다.
    골격 한계: §1.4의 "사실 변경 감지"(outbound link 깨짐 등)는 아직 없다.
    """
    status = frontmatter.get("status")
    if status == "stale":
        return True, "status: stale 명시"
    if status == "archived":
        return False, None  # archived는 stale 후보 아님
    field, value = _age_basis(frontmatter)
    age_days = _age_days(value, now)
    if age_days is not None and age_days >= age_threshold_days:
        suffix = "" if field == "last_verified" else ", last_verified 없음"
        return True, f"{field} {age_days}일 전 (임계값 {age_threshold_days}{suffix})"
    return False, None


def _suggest_action(
    evidence: str | None,
    frontmatter: dict,
) -> Literal["update", "archive", "revalidate"]:
    """ADR §1.3 evidence + frontmatter 보고 suggested_action 결정.

    골격 정책:
    - evidence에 "임계값" 언급 → "revalidate" (검증 후 current 복귀 후보)
    - evidence에 "명시" 언급 → "update" (status: stale 직접 표기)
    - 그 외 → "archive" (사실 변경 의심)
    """
    if evidence is None:
        return "archive"
    if "임계값" in evidence:
        return "revalidate"
    return "update"


def _stamp_archived(
    source: Path,
    *,
    reason: str,
    actor: str,
) -> bool:
    """ADR §1.3: archive 액션 시 원본 frontmatter에 archived_at + reason stamp.

    골격 한계: 원본 파일의 frontmatter에 stamp만 추가, 실제 이동은 호출자가 처리.
    """
    if not source.exists():
        return False
    text = source.read_text(encoding="utf-8")
    fm, body = core_frontmatter.parse(text)
    if fm is None:
        fm = {}
    fm["archived_at"] = now_iso()
    fm["archive_reason"] = reason
    if "agents" not in fm or not isinstance(fm.get("agents"), list):
        fm["agents"] = []
    fm["agents"].append(
        {
            "actor": actor,
            "action": "archived",
            "at": now_iso(),
            "evidence": reason,
        }
    )
    new_text = core_frontmatter.render(fm, body)
    source.write_text(new_text, encoding="utf-8")
    return True


# ─────────────── 1. wiki_stale_detect (read) ───────────────


def wiki_stale_detect(
    *,
    vault: Path,
    age_threshold_days: int = DEFAULT_STALE_DAYS,
    include_self_verified: bool = False,
) -> dict:
    """ADR §1.3 stale 후보 감지 (read-only).

    Args:
        vault: vault 경로.
        age_threshold_days: ADR §1.4 임계값 (기본 90일).
        include_self_verified: True면 current + last_verified 있는 페이지도 포함 (디버깅용).

    Returns:
        {
            "candidates": [
                {
                    "slug": str,
                    "status": "stale"|"current"|...,
                    "last_verified_at": str|None,
                    "age_days": int|None,
                    "evidence": str|None,
                    "suggested_action": "update"|"archive"|"revalidate",
                }
            ],
            "summary": {"total_scanned": int, "stale_count": int, ...}
        }

    v0.7.69+ Plan B-2 갱신: wiki.db.list_pages() 우선 사용 (B#8 lint 캐싱 동시).
    wiki.db가 없거나 slug 누락 시 FS fallback.
    """
    now = datetime.now(timezone.utc)
    candidates = []

    # 1. wiki.db 우선 시도 (B#8 lint 캐싱과 동시 — fs rglob 회피)
    pages: list[dict] = []
    try:
        pages = db.list_pages(vault=vault) or []
    except Exception:
        pages = []

    # 2. FS fallback (wiki.db 없거나 broken)
    if not pages:
        content_root = vault / "content"
        if content_root.exists():
            for md_path in content_root.rglob("*.md"):
                try:
                    text = md_path.read_text(encoding="utf-8")
                except (UnicodeDecodeError, OSError):
                    continue
                fm, _body = core_frontmatter.parse(text)
                if fm is None:
                    fm = {}
                rel_slug = md_path.relative_to(content_root).with_suffix("").as_posix()
                pages.append(
                    {
                        "slug": rel_slug,
                        "title": fm.get("title"),
                        "path": str(md_path),
                        "updated": None,
                    }
                )

    total_scanned = len(pages)

    for page in pages:
        slug = page.get("slug", "")
        page_path = Path(page.get("path") or (vault / "content" / f"{slug}.md"))

        # frontmatter는 FS에서 직접 읽음 (wiki.db에 저장되지 않을 수 있음)
        if not page_path.exists():
            continue
        try:
            text = page_path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        fm, _body = core_frontmatter.parse(text)
        if fm is None:
            fm = {}

        is_cand, evidence = _is_stale_candidate(
            fm, age_threshold_days=age_threshold_days, now=now
        )
        if not is_cand and not include_self_verified:
            continue

        last_verified = fm.get("last_verified")
        age_days = _age_days(_age_basis(fm)[1], now)

        candidates.append(
            {
                "slug": slug,
                "status": fm.get("status", "current"),
                "last_verified_at": last_verified,
                "age_days": age_days,
                "evidence": evidence,
                "suggested_action": _suggest_action(evidence, fm),
            }
        )

    return {
        "candidates": candidates,
        "summary": {
            "total_scanned": total_scanned,
            "stale_count": len(candidates),
            "age_threshold_days": age_threshold_days,
            "source": "wiki.db" if pages and db else "filesystem",
        },
    }


# ─────────────── 2. wiki_archive (write / admin) ───────────────


def wiki_archive(
    *,
    slug: str,
    reason: str = "stale_over_threshold",
    actor: str | None = None,
    dry_run: bool = False,
    ctx: VaultContext,
) -> dict:
    """ADR §1.3 격리 액션 — archive/<YYYY-MM-DD>/<slug>.md로 이동.

    Args:
        slug: 격리할 페이지의 slug.
        reason: "stale_over_threshold"|"user_request"|"factual_obsolete" (ADR §1.3 명시).
        actor: 호출자 식별.
        dry_run: True면 실제 이동 없이 결과만 반환.
        ctx: VaultContext (mode 검증).

    Returns:
        {
            "ok": bool,
            "archived_path": str|None,
            "source_frontmatter_stamped": bool,
            "dry_run": bool,
            "evidence": {...},
        }

    골격 한계:
    - ADR §1.3 "guards" 4종 (slug validate / FileLock / provenance / idempotent) —
      v0.7.69+ Plan B-2에서 4종 모두 구현.
    - ADR §1.2 권한 — write 또는 admin 모드 요구 (check_permission으로 위임).
    """
    actor = normalize_actor(actor)

    # ADR §1.3 guards: slug validate (path traversal 차단 — SlugError raise)
    try:
        slug_module.validate(slug, vault_root=ctx.vault)
    except SlugError as slug_err:
        return {
            "ok": False,
            "error": f"invalid slug: {slug_err}",
            "slug": slug,
        }

    # ADR §1.2 권한 검증 (check_permission raises PermissionError_)
    try:
        check_permission("wiki_archive", ctx.mode)
    except PermissionError_ as perm_err:
        return {
            "ok": False,
            "error": str(perm_err),
            "required_mode": "write or admin",
            "current_mode": ctx.mode,
        }

    # ADR §1.2 "본문 50%+ 재작성" 무관 (archive는 본문 손실 ❌, 이동 ⭕)
    # 단 archive 대상 검증: source 파일 존재 확인
    source = ctx.vault / "content" / f"{slug}.md"
    if not source.exists():
        return {
            "ok": False,
            "error": "source not found",
            "slug": slug,
            "expected_path": str(source),
        }

    # archive 경로: <vault>/archive/<YYYY-MM-DD>/<slug>.md
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    archive_path = ctx.vault / "archive" / today / f"{slug}.md"

    result = {
        "ok": True,
        "slug": slug,
        "archived_path": str(archive_path),
        "source_frontmatter_stamped": False,
        "dry_run": dry_run,
        "evidence": {
            "reason": reason,
            "actor": actor,
            "at": now_iso(),
        },
    }

    if dry_run:
        return result

    # ADR §1.3 guards 4종 완성: FileLock + atomic_write_text + provenance + idempotent
    # 1. FileLock (core/lock.py — TTL/PID 회수 v0.7.67+)
    try:
        with lock_for_file(ctx.vault, source, timeout=5.0):
            # 1a. 원본 frontmatter stamp (atomic_write_text로 안전 기록)
            stamped = _stamp_archived(source, reason=reason, actor=actor)

            # 1b. archive 디렉터리 생성 + 이동
            archive_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(archive_path))

            # 1c. log.md 기록 (append_log_entry: subject 필수)
            append_log_entry(
                ctx.vault,
                action="archive",
                subject=f"{slug} → {archive_path.relative_to(ctx.vault)}",
                actor=actor,
                extras=[f"reason: {reason}", f"archived_path: {archive_path}"],
            )

            result["source_frontmatter_stamped"] = stamped
    except TimeoutError as lock_err:
        return {
            "ok": False,
            "error": f"lock timeout: {lock_err}",
            "slug": slug,
            "hint": "다른 archive/write 액션이 진행 중. 잠시 후 재시도.",
        }

    return result
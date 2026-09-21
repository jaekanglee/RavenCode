"""semantic_lint.py — wiki_semantic_lint_queue (read-only candidate aggregator).

Lint 신호(#4/#5/#6/#7/#17/#20)를 슬러그 단위로 모아 "판단이 필요한 후보 큐"를
만든다. 판단(판정 기준/결정트리 적용)은 호출자(외부 에이전트 또는 vault owner)가
수행한다 — Raven은 중립적인 조회 도구만 제공하며, 판정 기준은 제공하지 않는다
(2026-07-13 spec, 2026-07-22 경계 정리).
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from raven.mcp.errors import InvalidToolArgument
from raven.core import frontmatter as core_frontmatter
from raven.core.lint import run_all
from raven.core.registry import VaultMeta
from raven.core.vault import Vault

ALLOWED_CHECKS: tuple[str, ...] = ("#4", "#5", "#6", "#7", "#17", "#20")

GUIDE_REF = "판정 기준은 호출자(vault owner + 에이전트 프로필)가 제공"

_FRONTMATTER_FIELDS: tuple[str, ...] = ("status", "confidence", "updated", "sources")

_PAIR_SEP = " ↔ "


def _frontmatter_for_slug(vault_root: Path, slug: str) -> dict:
    fp = vault_root / f"{slug}.md"
    if not fp.exists():
        return {}
    try:
        text = fp.read_text(encoding="utf-8")
    except OSError:
        return {}
    fm, _body = core_frontmatter.parse(text)
    return fm or {}


def _new_candidate(vault_root: Path, slug: str) -> dict:
    fm = _frontmatter_for_slug(vault_root, slug)
    title = fm.get("title")
    return {
        "slug": slug,
        "title": title if isinstance(title, str) else None,
        "frontmatter": {k: fm[k] for k in _FRONTMATTER_FIELDS if k in fm},
        "matched_checks": [],
    }


def wiki_semantic_lint_queue(
    *,
    vault: Path,
    checks: Optional[list[str]] = None,
    limit: int = 20,
) -> dict:
    """Lint 신호를 슬러그 단위로 모아 반환 (read-only, 판단은 호출자 책임).

    Args:
        vault: vault 루트 경로 (이미 resolve된 절대 경로).
        checks: 좁힐 체크 id 부분집합. 생략 시 ALLOWED_CHECKS 전부.
            허용목록 밖 id가 있으면 ValueError.
        limit: 반환할 최대 candidate 수. 초과분은 잘리고 truncated=True.

    Returns:
        {"ok", "vault", "checks_considered", "guide_ref",
         "candidate_count", "truncated", "candidates": [...]}
    """
    selected = list(checks) if checks is not None else list(ALLOWED_CHECKS)
    bad = [c for c in selected if c not in ALLOWED_CHECKS]
    if bad:
        raise InvalidToolArgument(
            f"checks에 허용목록 밖 id가 있음: {bad}. "
            f"허용목록: {list(ALLOWED_CHECKS)}"
        )
    selected_set = set(selected)

    vault_obj = Vault(meta=VaultMeta(name=vault.name, path=vault), root=vault)
    result = run_all(vault_obj)
    issues = [iss for iss in result["issues"] if iss.get("id") in selected_set]

    grouped: dict[str, dict] = {}

    def _ensure(slug: str) -> dict:
        if slug not in grouped:
            grouped[slug] = _new_candidate(vault, slug)
        return grouped[slug]

    for iss in issues:
        raw_slug = iss.get("slug", "")
        check_entry = {
            "id": iss.get("id"),
            "severity": iss.get("severity"),
            "message": iss.get("message"),
        }
        if iss.get("id") == "#17" and _PAIR_SEP in raw_slug:
            slug_a, slug_b = [s.strip() for s in raw_slug.split(_PAIR_SEP, 1)]
            entry_a = dict(check_entry)
            entry_a["paired_with"] = slug_b
            _ensure(slug_a)["matched_checks"].append(entry_a)
            entry_b = dict(check_entry)
            entry_b["paired_with"] = slug_a
            _ensure(slug_b)["matched_checks"].append(entry_b)
        else:
            _ensure(raw_slug)["matched_checks"].append(check_entry)

    candidates = sorted(grouped.values(), key=lambda c: c["slug"])
    truncated = len(candidates) > limit
    candidates = candidates[:limit]

    return {
        "ok": True,
        "vault": vault_obj.meta.name,
        "checks_considered": selected,
        "guide_ref": GUIDE_REF,
        "candidate_count": len(candidates),
        "truncated": truncated,
        "candidates": candidates,
    }

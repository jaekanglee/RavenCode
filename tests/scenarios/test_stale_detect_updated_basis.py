"""wiki_stale_detect — last_verified가 없으면 updated로 판정한다.

vault 대부분은 last_verified를 쓰지 않고 updated만 갱신한다(제품 lint #7도 updated 기준).
last_verified만 보던 탓에 이런 vault에서는 후보가 항상 0건이었다.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from raven.mcp.tools import stale as stale_tools


def _days_ago(n: int) -> str:
    return (date.today() - timedelta(days=n)).isoformat()


def _candidate(vault, slug):
    result = stale_tools.wiki_stale_detect(vault=vault)
    return next((c for c in result["candidates"] if c["slug"] == slug), None)


def test_old_updated_without_last_verified_is_candidate(isolated_vault, make_page):
    make_page(isolated_vault, "old-page", frontmatter={"title": "Old", "updated": _days_ago(120)}, body="본문")

    cand = _candidate(isolated_vault, "old-page")

    assert cand is not None
    assert cand["age_days"] >= 119
    assert "updated" in cand["evidence"]
    assert cand["suggested_action"] == "revalidate"


def test_recent_updated_is_not_candidate(isolated_vault, make_page):
    make_page(isolated_vault, "fresh-page", frontmatter={"title": "Fresh", "updated": _days_ago(10)}, body="본문")

    assert _candidate(isolated_vault, "fresh-page") is None


def test_recent_last_verified_wins_over_old_updated(isolated_vault, make_page):
    make_page(
        isolated_vault,
        "verified-page",
        frontmatter={
            "title": "Verified",
            "updated": _days_ago(200),
            "last_verified": datetime.now(timezone.utc).isoformat(),
        },
        body="본문",
    )

    assert _candidate(isolated_vault, "verified-page") is None


def test_date_only_last_verified_does_not_crash(isolated_vault, make_page):
    """날짜만 있는 값은 naive datetime이 된다 — aware now와 빼면 TypeError였다."""
    make_page(isolated_vault, "date-only", frontmatter={"title": "D", "last_verified": _days_ago(100)}, body="본문")

    cand = _candidate(isolated_vault, "date-only")

    assert cand is not None
    assert cand["age_days"] >= 99

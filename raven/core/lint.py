# -*- coding: utf-8 -*-
"""raven.core.lint — vault-aware lint runner (v0.5.1+ 14 checks).

Markdown PKM vault의 무결성을 확인한다. 일부 check는 Karpathy LLM Wiki
패턴에서 영감을 받았지만, Raven 기본 vault에도 적용 가능한 일반 lint다.

14 checks (severity: critical / warning / info):
    #1  broken wikilinks              (link_module.find_broken)
    #2  broken-intent false positive  (link_module: [[x]]! 인데 target 존재)
    #3  missing wikilinks              (link_module.find_missing)
    #4  orphan pages (7일 grace)       (check_orphans)
    #5  contradictions                 (check_contradictions)
    #6  confidence low                 (check_confidence_low)
    #7  stale pages (90일)             (check_stale)
    #8  page size > 200줄              (check_page_size)
    #9  tag not in core taxonomy       (check_tag_audit)
    #10 frontmatter 완전성             (check_frontmatter_completeness)
    #11 index 완전성 (FS vs DB)        (check_index_completeness)
    #12 log size > 500 entries         (check_log_size)
    #13 cognitive governance           (check_cognitive_governance)
    #14 tier integrity                 (check_tier_integrity)
    #15 slug-title 1:1 매칭 (ADR-2026-07-08, check_slug_title_1to1)
    #16 vault growth rate anomaly      (v0.7.107, check_vault_growth_rate)
    #17 duplicate title candidate      (v0.7.107, check_duplicate_title)
    #18 audit violation pattern         (v0.7.109, check_audit_violation_pattern)

v0.5.0: #12 (log_size) + #1-3 (link_module) 선반영.
v0.5.1: #4-#11 추가. 12/12 완성.
v0.5.3: #13 cognitive governance 추가.
v0.6.33: #14 tier integrity 추가.

grace period (orphan): vault 메타의 .vault.json에 `lint_orphan_grace_days` 키로
override 가능 (없으면 기본 7일).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
from datetime import date, datetime
from pathlib import Path
from typing import Optional

from .vault import Vault
from . import link as link_module
from .relations import SEMANTIC_RELATION_TYPES, has_relation_evidence, has_relation_reason


# vault lint defaults
LOG_ROTATE_THRESHOLD = 500
ORPHAN_GRACE_DAYS_DEFAULT = 7
STALE_DAYS = 90
PAGE_SIZE_LINES = 200
TAG_PROMOTION_THRESHOLD = 3  # 같은 custom 태그 N+ 페이지 → core 승격 추천 (#9)
INDEX_COMPLETE_BUILD_REQUIRED = True  # build 후에만 검증

# v0.7.107+: #16 (vault growth rate) — 7일 rolling page count 증가율
VAULT_GROWTH_WINDOW_DAYS = 7
VAULT_GROWTH_BASELINE_DAYS = 30
VAULT_GROWTH_SIGMA_THRESHOLD = 3.0  # 3σ over baseline

# v0.7.107+: #17 (duplicate title candidate) — title 유사도 threshold
DUPLICATE_TITLE_THRESHOLD = 0.8  # TF/IDF or Levenshtein ratio

# #13 cognitive governance (Zettelkasten/LLM Wiki quality signal, v0.5.3+)
# 면제: type ∈ {rule, journal, query, issue} 또는 _meta/ 안 페이지 (운영 문서).
COG_GOV_EXEMPT_TYPES: frozenset[str] = frozenset({"rule", "journal", "query", "issue"})
# 본문 wikilink가 cross-discipline 후보로 인정받으려면 다음 단어가 slug에 포함.
# (heuristic — 사람/예술/생물/역사/철학 카테고리 위주)
COG_GOV_DISCIPLINE_KEYWORDS: tuple[str, ...] = (
    "human", "person", "art", "music", "paint", "literature", "poetry",
    "biology", "evolution", "ecology", "anatomy",
    "history", "ancient", "medieval", "renaissance",
    "philosophy", "ethics", "metaphysic", "epistemolog", "logic",
    "society", "culture", "religion", "mythology",
    "psychology", "cognitive", "linguistic",
)
# 명시적 cross-discipline 마커 (frontmatter.tags 또는 본문)
COG_GOV_CROSS_MARKERS: tuple[str, ...] = (
    "humanities", "art", "biology", "history", "philosophy",
)
# 반대 입장 헤딩 패턴
COG_GOV_OPPOSE_HEADINGS: tuple[str, ...] = (
    "반대 입장", "fights against", "alternatives", "alternative view",
    "counterargument", "criticism", "limitations",
)
# Why it matters 시그널 (본문 첫 문단/헤딩)
COG_GOV_WHY_PATTERNS: tuple[str, ...] = (
    "why it matters", "왜 중요", "why this matters",
)
# confidence 필드 화이트리스트
COG_GOV_CONFIDENCE_LEVELS: frozenset[str] = frozenset({"high", "medium", "low"})

# core tag fallback (SCHEMA.md에 명시 안 됐을 때 사용)
CORE_TAGS_FALLBACK = {
    # 시스템
    "system", "tool", "ui", "search", "viewer", "schema", "mcp", "dashboard",
    "meta", "workflow", "index", "home",
    # 컨텐츠
    "concept", "person", "comparison", "project", "rule", "query", "journal", "issue",
    # 도메인
    "ai", "wiki", "karpathy", "llm-wiki", "tailscale", "react", "python", "docker",
    # 상태
    "draft", "review", "final", "deprecated", "orphan",
}


# ────────────────────────── 체크 레지스트리 (단일 소스, v0.8.1+) ──────────────────────────
#
# CLI(`raven lint summary`/`check`)와 API/대시보드가 각자 체크 이름·개수를
# 하드코딩해 발생한 drift(대시보드 14개 vs 실제 23개)를 근본 해결하기 위한
# 단일 소스. 새 check_* 함수를 추가할 때는 반드시 이 dict에도 등록할 것 —
# tests/test_lint_check_registry.py가 누락을 감지한다.
CHECK_REGISTRY: dict[str, dict] = {
    "#1":  {"name": "깨진 위키링크", "fn": None},
    "#2":  {"name": "깨진 의도 링크 오탐", "fn": None},
    "#3":  {"name": "누락된 위키링크", "fn": None},
    "#4":  {"name": "고아 문서", "fn": "check_orphans"},
    "#5":  {"name": "모순 감지", "fn": "check_contradictions"},
    "#6":  {"name": "신뢰도 낮음", "fn": "check_confidence_low"},
    "#7":  {"name": "오래된 문서", "fn": "check_stale"},
    "#8":  {"name": "문서 길이 초과", "fn": "check_page_size"},
    "#9":  {"name": "핵심 분류 밖 태그", "fn": "check_tag_audit"},
    "#10": {"name": "frontmatter 완전성", "fn": "check_frontmatter_completeness"},
    "#11": {"name": "index 완전성", "fn": "check_index_completeness"},
    "#12": {"name": "로그 크기 과다", "fn": "check_log_size"},
    "#13": {"name": "인지 거버넌스", "fn": "check_cognitive_governance"},
    "#14": {"name": "계층 무결성", "fn": "check_tier_integrity"},
    "#15": {"name": "slug-title 매칭", "fn": "check_slug_title_1to1"},
    "#16": {"name": "vault 성장률 이상", "fn": "check_vault_growth_rate"},
    "#17": {"name": "중복 제목 후보", "fn": "check_duplicate_title"},
    "#18": {"name": "감사 위반 패턴", "fn": "check_audit_violation_pattern"},
    "#20": {"name": "플레이스홀더 텍스트", "fn": "check_placeholder_text"},
    "#21": {"name": "맥락 없는 위키링크", "fn": "check_contextless_wikilinks"},
    "#22": {"name": "저널 요약 완전성", "fn": "check_journal_summary_completeness"},
    "#23": {"name": "의미 관계 무결성", "fn": "check_semantic_relations"},
}


# ────────────────────────── 데이터 구조 ──────────────────────────


# Issue는 dict: {"id": "#N", "severity": "critical|warning|info",
#                 "slug": "content/foo", "message": "..."}
# 또는 link_module 결과 그대로 {"source_slug", "target", "intent"}


def _mk_issue(check_id: str, severity: str, slug: str, message: str) -> dict:
    return {"id": check_id, "severity": severity, "slug": slug, "message": message}


# ────────────────────────── helpers ──────────────────────────


def _repo_root() -> Optional[Path]:
    return Path(__file__).resolve().parents[2]


class _ScanCache:
    """run_all() 1회 호출 동안만 유효한 파일 스캔/파싱 캐시 (v0.7.68, 평가 B#8).

    이전엔 체크 14개가 각각 독립적으로 vault를 rglob하고(~11회) frontmatter를
    재파싱해(~6회) 쓰기 1회 = lint 1회에 파일 I/O가 크게 중복됐다. 캐시는
    thread-local이라 동시 요청 간에 서로의 결과를 보지 않고, run_all()의
    try/finally로만 채워지고 비워져 run_all() 호출 경계 밖(개별 check_* 직접
    호출, 파일 변경 후 재호출되는 run_all())에는 절대 공유되지 않는다.
    """

    def __init__(self) -> None:
        self.pages: Optional[list[Path]] = None
        self.text: dict[Path, str] = {}
        self.frontmatter: dict[Path, dict] = {}
        self.link_pages: Optional[list[tuple[str, str]]] = None
        self.content_files: Optional[list[Path]] = None


_scan_local = threading.local()


def _is_archived_page(vault: Vault, fp: Path) -> bool:
    """Return True for markdown pages under any `_archive/` folder.

    Archived pages are retained for provenance, but they are no longer active
    vault content. Linting them re-surfaces resolved/generated issues and can
    make `wiki_lint` counts grow instead of converge.
    """
    try:
        rel = fp.relative_to(vault.root)
    except ValueError:
        rel = fp
    return "_archive" in rel.parts


def _content_files(vault: Vault) -> list[Path]:
    """`content_root` 아래 모든 .md (필터 없음) — run_all() 동안 1회만 rglob.

    v0.7.179: `_all_pages()`(=`_archive` 제외 + `_meta` 포함)와 link 체크
    (=`content_root` 원본)는 스코프가 달라 결과 목록을 공유할 수 없다. 대신
    **원본 glob 1회**를 여기서 캐시하고 각자 필요한 스코프를 파생시킨다.
    """
    cache: Optional[_ScanCache] = getattr(_scan_local, "cache", None)
    if cache is not None and cache.content_files is not None:
        return cache.content_files
    files = list(vault.content_root.rglob("*.md"))
    if cache is not None:
        cache.content_files = files
    return files


def _all_pages(vault: Vault) -> list[Path]:
    """vault 안 active .md 페이지 (content/ + _meta/), excluding `_archive/`."""
    cache: Optional[_ScanCache] = getattr(_scan_local, "cache", None)
    if cache is not None and cache.pages is not None:
        return cache.pages
    out = [fp for fp in _content_files(vault) if not _is_archived_page(vault, fp)]
    meta_dir = vault.meta_root
    if meta_dir.exists():
        out.extend(fp for fp in meta_dir.rglob("*.md") if not _is_archived_page(vault, fp))
    result = sorted(out)
    if cache is not None:
        cache.pages = result
    return result


def _slug_of(vault: Vault, fp: Path) -> str:
    return str(fp.relative_to(vault.root))[:-3]


def _read_text(fp: Path) -> str:
    """`fp` 전체 텍스트 읽기 (run_all() 스캔 동안 캐시)."""
    cache: Optional[_ScanCache] = getattr(_scan_local, "cache", None)
    if cache is not None and fp in cache.text:
        return cache.text[fp]
    text = fp.read_text(errors="replace")
    if cache is not None:
        cache.text[fp] = text
    return text


def _parse_fm(fp: Path) -> dict:
    """frontmatter parse (없으면 {})."""
    cache: Optional[_ScanCache] = getattr(_scan_local, "cache", None)
    if cache is not None and fp in cache.frontmatter:
        return cache.frontmatter[fp]
    from . import frontmatter as fm_mod
    meta, _ = fm_mod.parse(_read_text(fp))
    if cache is not None:
        cache.frontmatter[fp] = meta
    return meta


def _core_tags(vault: Vault) -> set[str]:
    """vault의 _meta/agents/SCHEMA.md에서 core tags 동적 파싱, 실패 시 fallback.

    v0.7.66 (평가 P1#11): 옛 경로(_meta/SCHEMA.md)는 어떤 부트스트랩에서도
    생성된 적이 없어 태그 승격(core 목록 추가)이 항상 무효였음.
    """
    schema = vault.meta_root / "agents" / "SCHEMA.md"
    if not schema.exists():
        return set(CORE_TAGS_FALLBACK)
    text = schema.read_text(errors="replace")
    # "### Core (...)" 헤딩 아래의 `- 그룹: \`tag\`, ...` 패턴 추출.
    # 다른 헤딩(### Custom, ### 승격 절차, ## ...)이 나오면 섹션 종료.
    tags: set[str] = set()
    in_core = False
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            in_core = bool(re.search(r"\bcore\b", line, re.IGNORECASE))
            continue
        if in_core:
            # 태그 문자: 유니코드 단어문자 + 하이픈 (한글 태그 승격 지원, v0.7.66+)
            # 형식 1: `- 시스템: \`tag1\`, \`tag2\`, ...` (한 줄에 여러 tag)
            m = re.match(r"^\s*[-*]\s*[^*]+:\s*`?([\w가-힣-]+)`?", line)
            if m:
                tags.add(m.group(1).lower())
                # 같은 줄에 더 있는 tag도 추출
                for extra in re.findall(r"`([\w가-힣-]+)`", line):
                    tags.add(extra.lower())
                continue
            # 형식 2: `- \`tag\`` (한 줄에 한 tag)
            m = re.match(r"^\s*[-*]\s*`?([\w가-힣-]+)`?\s*$", line)
            if m:
                tags.add(m.group(1).lower())
    return tags if tags else set(CORE_TAGS_FALLBACK)


def _orphan_grace_days(vault: Vault) -> int:
    """vault 메타의 .vault.json에서 grace 기간 override."""
    vf = vault.root / ".vault.json"
    if vf.exists():
        try:
            data = json.loads(vf.read_text())
            v = data.get("lint_orphan_grace_days")
            if isinstance(v, int) and v >= 0:
                return v
        except Exception:
            pass
    return ORPHAN_GRACE_DAYS_DEFAULT


# ────────────────────────── check 함수들 (v0.5.1+ 신규) ──────────────────────────


def check_orphans(vault: Vault) -> list[dict]:
    """#4 orphan: inbound wikilink 0 인 페이지. grace 기간 (기본 7일) 지나면 warning.

    Returns: [{"id":"#4", "severity":"warning|info", "slug":..., "message":...}, ...]

    면제 (v0.5.2+ SCHEMA): _meta/ 안 페이지 (rule/reference). 운영 문서는 inbound 0이 정상.
    """
    grace = _orphan_grace_days(vault)
    today = date.today()

    # inbound map (slug → count)
    inbound: dict[str, int] = {}
    for fp in _all_pages(vault):
        text = _read_text(fp)
        src_slug = _slug_of(vault, fp)
        for lnk in link_module.parse(text):
            if lnk.intent != "auto":
                continue
            tgt = lnk.target.split("|", 1)[0].strip()
            if not tgt or "/" not in tgt:
                continue
            inbound[tgt] = inbound.get(tgt, 0) + 1

    out: list[dict] = []
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        if inbound.get(slug, 0) > 0:
            continue
        # 면제: _meta/ 안 (rule/reference, 운영 문서)
        if slug.startswith("_meta/"):
            continue
        # orphan: created 기준 grace 계산
        fm = _parse_fm(fp)
        created_str = fm.get("created")
        try:
            created = date.fromisoformat(created_str) if created_str else today
        except Exception:
            created = today
        age = (today - created).days
        if age >= grace:
            out.append(_mk_issue(
                "#4", "warning", slug,
                f"orphan (no inbound, age {age}d ≥ grace {grace}d)",
            ))
        else:
            out.append(_mk_issue(
                "#4", "info", slug,
                f"orphan (no inbound, age {age}d < grace {grace}d — grace 중)",
            ))
    return out


def check_contradictions(vault: Vault) -> list[dict]:
    """#5 contradictions: frontmatter.contradictions: [a, b] 인데 a/b 미존재 → warning."""
    out: list[dict] = []
    existing = {_slug_of(vault, fp) for fp in _all_pages(vault)}
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        fm = _parse_fm(fp)
        cont = fm.get("contradictions")
        if not cont:
            continue
        if not isinstance(cont, list):
            out.append(_mk_issue(
                "#5", "info", slug,
                f"contradictions field is not a list: {cont!r}",
            ))
            continue
        for ref in cont:
            if ref not in existing:
                out.append(_mk_issue(
                    "#5", "warning", slug,
                    f"contradictions: [{ref}] 가 vault에 없음",
                ))
    return out


def check_confidence_low(vault: Vault) -> list[dict]:
    """#6 confidence low: frontmatter.confidence: low 인 페이지 → info."""
    out: list[dict] = []
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        fm = _parse_fm(fp)
        if fm.get("confidence") == "low":
            out.append(_mk_issue(
                "#6", "info", slug,
                "confidence: low (단일 출처 / 미검증 주장)",
            ))
    return out


def check_stale(vault: Vault) -> list[dict]:
    """#7 stale: updated > 90일 + content/RAG/위키 등 도메인 페이지 → info.

    운영 문서 (`type: rule` 또는 `_meta/` 안) 면제 (v0.5.2+).
    """
    today = date.today()
    out: list[dict] = []
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        if slug.startswith("_meta/"):
            continue
        fm = _parse_fm(fp)
        if fm.get("type") == "rule":
            continue
        updated_str = fm.get("updated")
        try:
            updated = date.fromisoformat(updated_str) if updated_str else None
        except Exception:
            updated = None
        if not updated:
            continue
        age = (today - updated).days
        if age >= STALE_DAYS:
            out.append(_mk_issue(
                "#7", "info", slug,
                f"stale (updated {age}d 전, {STALE_DAYS}d+ 기준)",
            ))
    return out


def check_page_size(vault: Vault) -> list[dict]:
    """#8 page size > 200줄 → info (분할 권장).

    면제 (v0.5.2+ SCHEMA): _meta/ 안 (rule/reference, 운영 문서).
    """
    out: list[dict] = []
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        if slug.startswith("_meta/"):
            continue  # 운영 문서 면제
        try:
            n = sum(1 for _ in fp.open(encoding="utf-8", errors="replace"))
        except Exception:
            continue
        if n > PAGE_SIZE_LINES:
            out.append(_mk_issue(
                "#8", "info", slug,
                f"page size {n}줄 > {PAGE_SIZE_LINES}줄 (분할 권장)",
            ))
    return out


def check_tag_audit(vault: Vault) -> list[dict]:
    """#9 tag not in core taxonomy → info (custom 태그는 허용된 사용법).

    v0.7.66 (평가 P2#17): "custom은 OK"라면서 warning을 내던 자기모순 해소.
    v0.7.66 (평가 P2#22): 같은 custom 태그가 TAG_PROMOTION_THRESHOLD(3)+ 페이지에서
    쓰이면 core 승격 추천 1건 — SCHEMA.md가 약속만 하고 미구현이던 기능.
    """
    core = _core_tags(vault)
    out: list[dict] = []
    custom_pages: dict[str, set[str]] = {}
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        fm = _parse_fm(fp)
        tags = fm.get("tags")
        if not isinstance(tags, list):
            continue
        for t in tags:
            if not isinstance(t, str):
                continue
            t_norm = t.lower().strip()
            if t_norm and t_norm not in core:
                custom_pages.setdefault(t_norm, set()).add(slug)
                out.append(_mk_issue(
                    "#9", "info", slug,
                    f"tag {t!r} not in core taxonomy (custom은 OK)",
                ))
    for t, slugs in sorted(custom_pages.items()):
        if len(slugs) >= TAG_PROMOTION_THRESHOLD:
            out.append(_mk_issue(
                "#9", "info", "(vault)",
                f"tag {t!r} {len(slugs)}개 페이지에서 사용 — core 승격 추천 "
                "(`type: issue`로 발의, 승인 시 _meta/agents/SCHEMA.md Core 목록에 추가)",
            ))
    return out


def check_frontmatter_completeness(vault: Vault) -> list[dict]:
    """#10 frontmatter 완전성: title/type/created/updated 필수. created/updated는 warning, 나머지는 info.

    면제 (SCHEMA.md "System Areas"): _meta/**, raw/**, content/_index/**,
    content/index — 시스템 자동 생성/운영 영역은 type 9종 정책 밖 (Raven Product
    Feedback Brief 2026-09-03: 문서엔 면제로 명시돼 있었지만 구현이 빠져 있었음).
    """
    out: list[dict] = []
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        if (
            slug.startswith("_meta/")
            or slug.startswith("raw/")
            or slug.startswith("content/_index/")
            or slug == "content/index"
        ):
            continue
        fm = _parse_fm(fp)
        if not fm:
            out.append(_mk_issue(
                "#10", "warning", slug, "no frontmatter",
            ))
            continue
        if not fm.get("title"):
            out.append(_mk_issue("#10", "info", slug, "frontmatter.title missing"))
        if not fm.get("type"):
            out.append(_mk_issue("#10", "info", slug, "frontmatter.type missing"))
        if not fm.get("created"):
            out.append(_mk_issue("#10", "warning", slug, "frontmatter.created missing"))
        if not fm.get("updated"):
            out.append(_mk_issue("#10", "warning", slug, "frontmatter.updated missing"))
    return out


def check_index_completeness(vault: Vault) -> list[dict]:
    """#11 index 완전성: filesystem 페이지 vs wiki.db. DB 없으면 info (build 필요).

    `raven build` 후 실행 가정. DB 없으면 build 요청.
    """
    out: list[dict] = []
    db_path = vault.db_path
    if not db_path.exists():
        out.append(_mk_issue(
            "#11", "info", "(vault)",
            f"wiki.db 없음: `raven build` 필요 ({db_path})",
        ))
        return out
    # DB의 pages 테이블 slug 조회
    try:
        import sqlite3
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cur = con.execute("SELECT slug FROM pages")
        db_slugs = {r[0] for r in cur.fetchall()}
        con.close()
    except Exception as e:
        out.append(_mk_issue(
            "#11", "warning", "(vault)",
            f"wiki.db 읽기 실패: {e}",
        ))
        return out

    fs_slugs = {_slug_of(vault, fp) for fp in _all_pages(vault)}
    only_fs = fs_slugs - db_slugs
    # v0.7.66 (평가 P1#4): log.md(및 rotate된 log-YYYY.md)는 페이지가 아니라
    # 인프라 — DB에는 색인되지만 페이지 스캔(content/+_meta/) 대상이 아니어서
    # "DB에만 있음" 영구 오탐을 냈음.
    only_db = {
        s for s in db_slugs - fs_slugs
        if not (s == "log" or re.match(r"^log-\d{4}$", s))
    }
    for slug in sorted(only_fs):
        out.append(_mk_issue(
            "#11", "warning", slug, "filesystem에만 있음 (build 필요)",
        ))
    for slug in sorted(only_db):
        out.append(_mk_issue(
            "#11", "warning", slug, "DB에만 있음 (stale build, 재build 필요)",
        ))
    return out


def check_log_size(vault: Vault) -> list[dict]:
    """#12 log size > 500 entries → info."""
    from . import log as _log
    path = _log.log_path(vault)
    if not path.exists():
        return []
    entries = _log.count(vault)
    if entries >= LOG_ROTATE_THRESHOLD:
        return [_mk_issue(
            "#12", "info", "(vault)",
            f"log.md {entries} entries ≥ {LOG_ROTATE_THRESHOLD} (rotate 권장)",
        )]
    return []


def check_audit_violation_pattern(vault: Vault) -> list[dict]:
    """#18 audit log violation pattern (v0.7.109+, G5 audit log 기반).

    최근 30일 log.md에서 "audit blocked write" 패턴을 분석:
    - 단일 actor가 5회+ permission_denied → 🟡 warning (반복 위반)
    - 단일 path(slug prefix)에 10회+ 차단 → 🟡 warning (반복 시도)

    north star "원문 보존" 직접 보호. 큐레이션: actor 차단 / vault 운영자 경고.
    """
    from . import log as _log
    path = _log.log_path(vault)
    if not path.exists():
        return []
    entries = _log.list_entries(vault)
    if not entries:
        return []

    # 30일 이내 audit entry만 필터
    today = date.today()
    from datetime import timedelta
    cutoff = (today - timedelta(days=30)).isoformat()
    audit_recent: list[dict] = []
    for e in entries:
        if e["date"] < cutoff:
            continue
        subj = (e.get("subject", "") or "").lower()
        if "audit blocked" in subj or "permission_denied" in subj:
            audit_recent.append(e)

    if not audit_recent:
        return []

    # actor별 카운트
    actor_count: dict[str, int] = {}
    path_count: dict[str, int] = {}
    for e in audit_recent:
        # subject에서 actor/path 추출 (heuristic: "audit blocked write: <path> (actor=<actor>, ...)")
        subj = e.get("subject", "") or ""
        m_actor = re.search(r"actor=([^,\)]+)", subj)
        m_path = re.search(r"audit blocked write: ([^\s(]+)", subj)
        if m_actor:
            actor = m_actor.group(1).strip()
            actor_count[actor] = actor_count.get(actor, 0) + 1
        if m_path:
            path = m_path.group(1).strip()
            # slug 첫 segment만 (디렉토리 단위)
            first_seg = path.split("/")[0] if "/" in path else path
            path_count[first_seg] = path_count.get(first_seg, 0) + 1

    out: list[dict] = []
    for actor, cnt in actor_count.items():
        if cnt >= 5:
            out.append(_mk_issue(
                "#18", "warning", "(vault)",
                f"audit violation pattern: actor '{actor}' {cnt}회 차단 (30일 내). "
                f"north star '원문 보존' 위반 반복 — actor 차단 또는 사람 운영자 경고 권장",
            ))
    for path, cnt in path_count.items():
        if cnt >= 10:
            out.append(_mk_issue(
                "#18", "warning", "(vault)",
                f"audit violation pattern: path '{path}/*' {cnt}회 차단 (30일 내). "
                f"north star '원문 보존' 위반 반복 — 권한 정책 검토 권장",
            ))
    return out


def check_vault_growth_rate(vault: Vault) -> list[dict]:
    """#16 vault growth rate anomaly (v0.7.107+, SCHEMA.md L248).

    7일 rolling window의 page count 증가율이 과거 30일 baseline의 3σ 초과 시
    info. north star "증분 누적" 위반 패턴 감지 → 사람 운영자 큐레이션 트리거.

    면제: _meta/ 안 페이지 (운영 문서). baseline 30일 데이터 부족 시 skip.
    """
    today = date.today()
    baseline_start = today.toordinal() - VAULT_GROWTH_BASELINE_DAYS
    window_start = today.toordinal() - VAULT_GROWTH_WINDOW_DAYS

    # 일별 created 카운트
    daily: dict[int, int] = {}
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        if slug.startswith("_meta/"):
            continue
        fm = _parse_fm(fp)
        created_str = fm.get("created")
        try:
            created = date.fromisoformat(created_str) if created_str else None
        except Exception:
            created = None
        if not created:
            continue
        d_ord = created.toordinal()
        if d_ord < baseline_start:
            continue
        daily[d_ord] = daily.get(d_ord, 0) + 1

    if not daily:
        return []

    # baseline (7일 window 제외한 나머지) 일별 평균 + σ
    baseline_days = [d for d in daily if d < window_start]
    if len(baseline_days) < 3:
        return []  # baseline 부족

    base_counts = [daily[d] for d in baseline_days]
    mean = sum(base_counts) / len(base_counts)
    variance = sum((c - mean) ** 2 for c in base_counts) / len(base_counts)
    sigma = variance ** 0.5

    # 7일 window 합계
    window_count = sum(daily.get(d, 0) for d in range(window_start, today.toordinal() + 1))

    # 일평균 환산
    window_mean = window_count / VAULT_GROWTH_WINDOW_DAYS
    z_score = (window_mean - mean) / sigma if sigma > 0 else 0

    if z_score > VAULT_GROWTH_SIGMA_THRESHOLD:
        return [_mk_issue(
            "#16", "info", "(vault)",
            f"vault growth rate anomaly: 7일 window {window_count} pages "
            f"(일평균 {window_mean:.1f}) > baseline {mean:.1f} + {VAULT_GROWTH_SIGMA_THRESHOLD}σ ({z_score:.1f}σ). "
            f"north star '증분 누적' 위반 패턴 — 사람 큐레이션 권장",
        )]
    return []


def _normalize_title(s: str) -> str:
    """정규화: 소문자 + 공백/특수문자 collapse + 한국어 처리.

    "X Y"와 "X-Y"가 동등 비교되도록. 한글/영문 모두 지원.
    """
    import re as _re
    s = s.lower().strip()
    # 대시/언더스코어/공백 → 단일 공백
    s = _re.sub(r"[\s_\-]+", " ", s)
    # 문장부호 제거 (한글 ㄱ-ㅎ, ㅏ-ㅣ, 가-힣 보존)
    s = _re.sub(r"[^\w\s가-힣]", "", s, flags=_re.UNICODE)
    return s.strip()


def _tokenize(s: str) -> list[str]:
    """공백 기준 tokenize. 한글은 character-level로 fallback."""
    tokens = s.split()
    out: list[str] = []
    for t in tokens:
        if not t:
            continue
        # 한글 비중 높으면 character-level (TF/IDF에 유리)
        han_count = sum(1 for c in t if "가" <= c <= "힣")
        if han_count >= 2:
            out.extend(t)  # character-level
        else:
            out.append(t)
    return out


def _tfidf_similarity(t1: str, t2: str) -> float:
    """TF/IDF cosine similarity (간이). v0.7.109+."""
    from collections import Counter
    import math
    toks1 = _tokenize(_normalize_title(t1))
    toks2 = _tokenize(_normalize_title(t2))
    if not toks1 or not toks2:
        return 0.0
    c1, c2 = Counter(toks1), Counter(toks2)
    vocab = set(c1.keys()) | set(c2.keys())
    # TF: raw count
    # IDF: 단어 1개만 출현하면 log(2/1)=0.693, 양쪽 다 출현하면 log(2/2)=0 → 약점
    # 개선: 양쪽 모두 출현하는 단어에 가중치
    def vec(c: Counter) -> dict[str, float]:
        # 양쪽 모두 출현하는 token은 1.5x 가중 (단순 IDF 우회)
        return {t: (1.5 if t in c1 and t in c2 else 1.0) * c[t] for t in vocab if t in c}

    v1, v2 = vec(c1), vec(c2)
    dot = sum(v1.get(t, 0) * v2.get(t, 0) for t in vocab)
    n1 = math.sqrt(sum(x * x for x in v1.values()))
    n2 = math.sqrt(sum(x * x for x in v2.values()))
    if n1 == 0 or n2 == 0:
        return 0.0
    return dot / (n1 * n2)


def _levenshtein_ratio(t1: str, t2: str) -> float:
    """Levenshtein distance 기반 ratio (1 - dist/max)."""
    from difflib import SequenceMatcher
    return SequenceMatcher(None, t1, t2).ratio()


def _title_similarity(t1: str, t2: str) -> tuple[float, str]:
    """복합 유사도: max(TF/IDF, Levenshtein) + 어떤 방식인지 반환."""
    n1, n2 = _normalize_title(t1), _normalize_title(t2)
    if not n1 or not n2:
        return 0.0, "empty"
    tfidf = _tfidf_similarity(n1, n2)
    lev = _levenshtein_ratio(n1, n2)
    if tfidf >= lev:
        return tfidf, f"tfidf={tfidf:.2f}"
    return lev, f"levenshtein={lev:.2f}"


def check_duplicate_title(vault: Vault) -> list[dict]:
    """#17 duplicate title candidate (v0.7.107+, v0.7.109+ TF/IDF+Levenshtein).

    TF/IDF cosine 또는 Levenshtein ratio > 0.8 페이지 2개+ → 🟡 warning.
    큐레이션: [[wikilink]] 상호 link 또는 합병 발의 (type: issue).

    면제: _meta/ 안 페이지 (운영 문서).
    v0.7.109+: SequenceMatcher 단일 ratio → max(TF/IDF, Levenshtein) + 정규화.
    """
    titles: list[tuple[str, str]] = []  # (slug, title)
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        if slug.startswith("_meta/"):
            continue
        fm = _parse_fm(fp)
        title = fm.get("title")
        if not title or not isinstance(title, str):
            continue
        titles.append((slug, title.strip()))

    out: list[dict] = []
    seen_pairs: set[tuple[str, str]] = set()
    n = len(titles)
    for i in range(n):
        for j in range(i + 1, n):
            slug_i, t_i = titles[i]
            slug_j, t_j = titles[j]
            pair = tuple(sorted([slug_i, slug_j]))
            if pair in seen_pairs:
                continue
            sim, method = _title_similarity(t_i, t_j)
            if sim >= DUPLICATE_TITLE_THRESHOLD:
                seen_pairs.add(pair)
                out.append(_mk_issue(
                    "#17", "warning", f"{slug_i} ↔ {slug_j}",
                    f"duplicate title candidate ({method}): "
                    f"'{t_i[:40]}' ↔ '{t_j[:40]}' — 큐레이션: [[wikilink]] 상호 link 또는 type: issue 합병 발의",
                ))
    return out


def check_slug_title_1to1(vault: Vault) -> list[dict]:
    """#15 slug-title 1:1 매칭 (ADR-2026-07-08, v0.7.100+).

    frontmatter title 슬러그화 결과 ≠ 파일명 → 🟡 warning. SCHEMA.md L81-85 정의.
    """
    import unicodedata
    def slugify(s: str) -> str:
        s = unicodedata.normalize("NFC", s)
        s = re.sub(r"[^\w\s가-힣\-\+\(\)]", "-", s, flags=re.UNICODE)
        s = re.sub(r"[\s_]+", "-", s)
        s = s.replace("+-", "plus").replace("+", "-")
        s = re.sub(r"-+", "-", s).strip("-")
        out = []
        for c in s:
            if c.isascii() and c.isalpha():
                out.append(c.lower())
            else:
                out.append(c)
        return "".join(out)

    out: list[dict] = []
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        if slug.startswith("_meta/"):
            continue
        # ADR 컨벤션: decision/adr-YYYY-MM-DD-* + journal/{title-slug}.md
        if slug.startswith("decision/adr-"):
            continue
        if slug.startswith("journal/"):
            continue
        if slug.endswith("/index") or slug == "index" or slug.startswith("content/_index/"):
            continue  # _index 자동 카탈로그 (Raven Product Feedback Brief 2026-09-03:
            # content/_index/{type} 카탈로그는 "/index"로 끝나지 않아 이 면제에 안 걸렸음)
        fm = _parse_fm(fp)
        title = fm.get("title")
        if not title or not isinstance(title, str):
            continue
        title_slug = slugify(title)
        cur_base = slug.split("/")[-1]
        if cur_base != title_slug:
            # main name + 부속어 예외: 첫 N 단어가 매치하면 1:1 통과
            cur_words = cur_base.split("-")
            title_words = title_slug.split("-")
            # main name이 일치하면 1:1로 간주 (단 짧은 title은 그대로 검사)
            if len(title_words) <= 1:
                continue
            if cur_words[:len(title_words)] != title_words:
                out.append(_mk_issue(
                    "#15", "warning", slug,
                    f"slug-title 불일치: slug='{cur_base}', title_slug='{title_slug}' "
                    f"(ADR-2026-07-08 §2.1 — 운영자 명시 결정으로 wiki_rename)",
                ))
    return out


# v0.6.33+: Tier 1 leak 패턴 — Karpathy LLM Wiki 3-Layer 분리의 vault 침투 감지.
#
# 카파시 LLM Wiki 패턴의 핵심: vault는 Layer 2 (사용자/에이전트가 쓰는 곳)지,
# Layer 1 (raven internal docs — OPERATIONS.md / agent/* / raven-policy.md) 이
# vault에 복사되면 안 됨. 사람이 실수로 vault clone 시 Tier 1 문서가 누설되는
# 것을 자동 검증.
#
# v0.6.39+: 옵션화. vault.meta.allow_tier1_leak = True인 vault는
# critical 대신 warning으로 강등 (사용자 명시적 안전벨트 해제).
TIER1_LEAK_PATTERNS = (
    "OPERATIONS.md",
    "agent/",
    "raven-policy.md",
)


def check_tier_integrity(vault: Vault) -> list[dict]:
    """#14 tier_integrity — Tier 1 leak 감지.

    vault.content/ 하위에 Tier 1 문서 패턴이 있으면 기본 critical 보고.
    vault.meta.allow_tier1_leak = True이면 warning으로 강등 (사용자 옵트인).

    카파시 3-Layer 분리 (raw/wiki/schema)를 lint 레벨에서 강제. 기본은
    안전망. 사용자가 명시적으로 allow_tier1_leak = True 설정 시 강등.
    """
    out: list[dict] = []
    content_root = vault.content_root
    if not content_root.exists():
        return out
    # v0.6.39+: 사용자가 옵트인하면 critical → warning 강등
    severity = "warning" if getattr(vault.meta, "allow_tier1_leak", False) else "critical"
    leak_label = "Tier 1 leak (warning, allow_tier1_leak=True)" if severity == "warning" \
        else "Tier 1 leak"
    for fp in content_root.rglob("*"):
        if not fp.is_file():
            continue
        rel = fp.relative_to(content_root)
        rel_str = str(rel)
        for pattern in TIER1_LEAK_PATTERNS:
            if pattern in rel_str:
                slug = str(rel.with_suffix("")).replace("\\", "/")
                out.append(_mk_issue(
                    "#14", severity, slug,
                    f"{leak_label}: '{rel}' — "
                    f"matches '{pattern}' (Karpathy 3-Layer 위반)",
                ))
                break
    return out


def check_cognitive_governance(vault: Vault) -> list[dict]:
    """#13 cognitive governance (Zettelkasten/LLM Wiki quality signal, v0.5.3+).

    concept/comparison/page 타입에 다음 4 신호 중 누락 시 1 issue당 1 line 출력:
      1. **Why it matters** — 본문 첫 문단 또는 헤딩에 명시
      2. **반대 입장 (Fights against)** — `## 반대 입장` / `## Fights against` /
         `## Alternatives` (및 영어 변형) 헤딩 존재
      3. **Cross-disciplinary links** — 본문에 wikilink ≥ 1 (slug에 discipline
         키워드 또는 명시적 cross-discipline 마커)
      4. **confidence 등급** — frontmatter.confidence ∈ {high, medium, low}

    면제:
      - type ∈ {rule, journal, query} (SCHEMA §X)
      - _meta/ 안 페이지 (운영 문서)
      - .vault.json 내 disable_cognitive_governance=True 인 경우 (글로벌 비활성화)
      - wip/, scratch/ 하위 경위 페이지 (임시 작성 영역)
      - tags 내 wip, draft, scratch, memo, quick 단어가 포함된 경우 (초안 면제)
      - status ∈ {draft, stale, contested, archived} (v0.7.113+ status 머신 5종 연동)

    v0.5.3: info 등급 — 페이지 lint 통과에 영향 ❌. v0.6.x에서 warning 격상 후보.
    """
    # 글로벌 비활성화 체크
    vf = vault.root / ".vault.json"
    if vf.exists():
        try:
            data = json.loads(vf.read_text(encoding="utf-8"))
            if data.get("disable_cognitive_governance") or data.get("features", {}).get("cognitive_governance") is False:
                return []
        except Exception:
            pass

    out: list[dict] = []
    exempt_tags = {"wip", "draft", "scratch", "memo", "quick"}
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        # 면제: _meta/ 안 페이지 (운영 문서)
        if slug.startswith("_meta/"):
            continue
        # 면제: wip/, scratch/ 하위 (임시 작업)
        if slug.startswith("content/wip/") or slug.startswith("content/scratch/") or slug.startswith("wip/") or slug.startswith("scratch/"):
            continue
        try:
            text = _read_text(fp)
        except Exception:
            continue
        meta, body = _split_fm_body(text)
        # frontmatter 자체가 없으면 #10(no frontmatter) 담당 — 이중 보고 금지
        # (v0.7.66, 평가 P2#24)
        if not meta:
            continue
        # 면제: type 면제
        ptype = (meta.get("type") or "").strip().lower()
        if ptype in COG_GOV_EXEMPT_TYPES:
            continue
        # 면제: status 머신 draft/stale/contested/archived (v0.7.113+)
        pstatus = (meta.get("status") or "current").strip().lower()
        if pstatus in {"draft", "stale", "contested", "archived"}:
            continue
        # 면제: 초안/임시 태그 면제
        tags = meta.get("tags") or []
        if isinstance(tags, list):
            tags_set = {t.strip().lower() for t in tags if isinstance(t, str)}
            if tags_set & exempt_tags:
                continue

        missing: list[str] = []

        # 1) Why it matters — 헤딩 또는 본문 첫 문단
        if not _has_why_it_matters(body):
            missing.append("Why it matters")

        # 2) 반대 입장 헤딩
        if not _has_oppose_heading(body):
            missing.append("반대 입장")

        # 3) Cross-disciplinary wikilink (heuristic)
        if not _has_cross_discipline_link(body, slug, meta):
            missing.append("Cross-disciplinary link")

        # 4) confidence 등급
        conf = meta.get("confidence")
        if not isinstance(conf, str) or conf.strip().lower() not in COG_GOV_CONFIDENCE_LEVELS:
            missing.append("confidence")

        if missing:
            sev = "info"
            out.append(_mk_issue(
                "#13", sev, slug,
                f"cognitive governance 누락 ({len(missing)}/4): {', '.join(missing)}",
            ))
    return out


# ────────────────────────── helpers for #13 ──────────────────────────


def _split_fm_body(text: str) -> tuple[dict, str]:
    """frontmatter와 body 분리. (frontmatter dict, body str) 반환."""
    from . import frontmatter as fm_mod
    meta, body = fm_mod.parse(text)
    return meta, body


def _first_paragraph(body: str, max_chars: int = 400) -> str:
    """본문 첫 문단 (frontmatter 제외, 첫 '#' 헤딩 다음)."""
    if not body:
        return ""
    # 첫 h1/h2 헤딩 다음 빈 줄까지 또는 max_chars 까지
    lines = body.splitlines()
    started = False
    para: list[str] = []
    for line in lines:
        s = line.strip()
        if not started:
            if s.startswith("#"):
                started = True
                continue
            continue
        if not s:
            if para:
                break
            continue
        para.append(s)
        if sum(len(p) for p in para) >= max_chars:
            break
    return " ".join(para)[:max_chars].lower()


def _has_why_it_matters(body: str) -> bool:
    """헤딩 또는 본문 첫 문단에 'why it matters' 시그널."""
    body_lower = body.lower() if body else ""
    if any(p in body_lower for p in COG_GOV_WHY_PATTERNS):
        return True
    first_para = _first_paragraph(body or "")
    return any(p in first_para for p in COG_GOV_WHY_PATTERNS)


def _has_oppose_heading(body: str) -> bool:
    """'## 반대 입장' / '## Fights against' / '## Alternatives' 헤딩 존재."""
    if not body:
        return False
    body_lower = body.lower()
    for line in body.splitlines():
        s = line.strip().lower()
        if not s.startswith("## "):
            continue
        heading = s[3:].strip()
        for pat in COG_GOV_OPPOSE_HEADINGS:
            if pat in heading or heading.startswith(pat):
                return True
    # 본문 어딘가에 헤딩 텍스트가 직접 등장해도 OK (마크다운 형식이 약간 달라도 허용)
    return any(pat in body_lower for pat in COG_GOV_OPPOSE_HEADINGS)


def _has_cross_discipline_link(body: str, slug: str, meta: dict) -> bool:
    """본문 wikilink 중 cross-discipline 후보가 ≥ 1.

    heuristic:
      - wikilink target slug에 discipline 키워드 (사람/예술/생물/역사/철학) 매치
      - 또는 frontmatter.tags에 cross-discipline 마커
    """
    if not body:
        return False
    # 1) tags에 cross-discipline 마커
    tags = meta.get("tags") or []
    if isinstance(tags, list):
        for t in tags:
            if not isinstance(t, str):
                continue
            t_low = t.strip().lower()
            if any(m in t_low for m in COG_GOV_CROSS_MARKERS):
                return True
    # 2) wikilink target slug 추출
    targets = _extract_wikilink_targets(body)
    if not targets:
        return False
    for tgt in targets:
        tgt_low = tgt.lower()
        if any(kw in tgt_low for kw in COG_GOV_DISCIPLINE_KEYWORDS):
            return True
    return False


def _extract_wikilink_targets(body: str) -> list[str]:
    """[[target]] / [[target|alias]] / [[target?]] / [[target!]] 에서 target 추출."""
    out: list[str] = []
    if not body:
        return out
    for m in re.finditer(r"\[\[([^\[\]]+?)\]\]", body):
        raw = m.group(1).strip()
        # alias 제거
        target = raw.split("|", 1)[0].strip()
        # intent marker 제거
        target = target.rstrip("?!.").strip()
        if target:
            out.append(target)
    return out


# ────────────────────────── 합쳐서 run ──────────────────────────


def _link_scan_pages(vault: Vault) -> list[tuple[str, str]]:
    """link 체크 3종이 공유하는 (slug, text) 목록.

    v0.7.179 (docs/issues/link-module-rglob-3회-잔여.md): `_all_pages()`와 스코프가
    다르다 — link 체크는 `content_root` 전체를 보고 `_meta/`를 보지 않으며
    `_archive/`도 제외하지 않는다. 그래서 `cache.pages`를 재사용하면 성능 개선이
    아니라 lint #1-#3 결과 변경이 된다. 본문 텍스트만 `_read_text()`로 공유해
    다른 체크가 이미 읽은 파일을 다시 읽지 않는다.
    """
    cache: Optional[_ScanCache] = getattr(_scan_local, "cache", None)
    if cache is not None and cache.link_pages is not None:
        return cache.link_pages
    pages = [
        (str(fp.relative_to(vault.root))[:-3], _read_text(fp))
        for fp in _content_files(vault)
    ]
    if cache is not None:
        cache.link_pages = pages
    return pages


def _legacy_link_issues(vault: Vault) -> list[dict]:
    """#1-3 (link_module 결과를 lint issue 형식으로 변환)."""
    pages = _link_scan_pages(vault)
    out: list[dict] = []
    for b in link_module.find_broken(vault, pages=pages):
        # [[x]]인데 target 없음 → critical
        out.append({
            "id": "#1",
            "severity": "critical",
            "slug": b["source_slug"],
            "message": f"broken wikilink [[{b['target']}]] — target 없음",
            "target": b["target"],
        })
    # #2: [[x]]! 인데 target 존재 → critical (v0.5.1+)
    for b in link_module.find_broken_intent(vault, pages=pages):
        out.append({
            "id": "#2",
            "severity": "critical",
            "slug": b["source_slug"],
            "message": f"broken-intent false positive: [[{b['target']}]]! 인데 target 존재 — intent 잘못",
            "target": b["target"],
        })
    for m in link_module.find_missing(vault, pages=pages):
        # [[x]]? 인데 target 없음 → info (의도적 placeholder)
        out.append({
            "id": "#3",
            "severity": "info",
            "slug": m["source_slug"],
            "message": f"missing wikilink [[{m['target']}]]? — 의도적 placeholder (OK)",
            "target": m["target"],
        })
    return out


def run_all(vault: Vault) -> dict:
    """17 check 모두 실행 (v0.7.107+). counts + issues list 반환.

    v0.6.33+: #14 tier_integrity 추가 — Karpathy 3-Layer 분리를 lint로 자동 검증.
    v0.7.68 (평가 B#8): 이 호출 동안만 파일 스캔/frontmatter 파싱을 캐시한다
    (`_ScanCache`) — 개별 check_* 직접 호출이나 다른 run_all() 호출로는 절대
    새지 않아, 파일이 바뀐 뒤 재실행하는 기존 호출 패턴을 그대로 보존한다.
    v0.7.100+ (ADR-2026-07-08): #15 slug-title 1:1 매칭.
    v0.7.107+: #16 vault growth rate anomaly, #17 duplicate title candidate.
    """
    _scan_local.cache = _ScanCache()
    try:
        issues: list[dict] = []
        # #1-3 link
        issues.extend(_legacy_link_issues(vault))
        # #4-14
        issues.extend(check_orphans(vault))
        issues.extend(check_contradictions(vault))
        issues.extend(check_confidence_low(vault))
        issues.extend(check_stale(vault))
        issues.extend(check_page_size(vault))
        issues.extend(check_tag_audit(vault))
        issues.extend(check_frontmatter_completeness(vault))
        issues.extend(check_index_completeness(vault))
        issues.extend(check_log_size(vault))
        issues.extend(check_cognitive_governance(vault))
        issues.extend(check_tier_integrity(vault))  # v0.6.33+
        # v0.7.100+ (ADR-2026-07-08)
        issues.extend(check_slug_title_1to1(vault))
        # v0.7.107+
        issues.extend(check_vault_growth_rate(vault))
        issues.extend(check_duplicate_title(vault))
        # v0.7.109+ — audit log 패턴 분석 (G5)
        issues.extend(check_audit_violation_pattern(vault))
        # v0.7.127+ (Semantic Quality Guards)
        issues.extend(check_placeholder_text(vault))
        issues.extend(check_contextless_wikilinks(vault))
        issues.extend(check_journal_summary_completeness(vault))
        # v0.8.0+ (Semantic Relation Integrity)
        issues.extend(check_semantic_relations(vault))
    finally:
        _scan_local.cache = None

    counts = {"critical": 0, "warning": 0, "info": 0, "total": 0}
    by_check: dict[str, int] = {}
    for iss in issues:
        sev = iss.get("severity", "info")
        counts[sev] = counts.get(sev, 0) + 1
        counts["total"] += 1
        cid = iss.get("id", "?")
        by_check[cid] = by_check.get(cid, 0) + 1

    return {
        "ok": counts["critical"] == 0,
        "vault": vault.meta.name,
        "counts": counts,
        "issues": issues,
        "by_check": by_check,
        "checks": {cid: meta["name"] for cid, meta in CHECK_REGISTRY.items()},
        # `wiki_lint`/run_all is intentionally read-only. Historical versions
        # auto-promoted stale draft issues here; keep the response key for
        # compatibility but do not mutate vault files from the linter path.
        "draft_promoted": 0,
    }


# ────────────────────────── legacy run_lint (back-compat) ──────────────────────────


def run_lint(vault: Vault) -> dict:
    """기존 호출자 호환용 wrapper. run_all() 호출 후 counts만 추출.

    v0.5.0의 단순 wrapper는 _inline_scan / _run_legacy 양쪽 모두 합친 결과 반환.
    새 코드는 run_all()을 직접 호출 권장.
    """
    repo_root = _repo_root()
    script = repo_root / "scripts" / "lint.py" if repo_root else None
    legacy = {"output_tail": "", "returncode": 0}
    if script and script.exists():
        try:
            argv = [sys.executable, str(script), str(vault.root)]
            env = os.environ.copy()
            result = subprocess.run(argv, capture_output=True, text=True, env=env, timeout=10)
            legacy["output_tail"] = ((result.stdout or "") + (result.stderr or ""))[-800:]
            legacy["returncode"] = result.returncode
        except Exception:
            pass
    full = run_all(vault)
    return {
        "ok": full["ok"],
        "vault": full["vault"],
        "counts": full["counts"],
        "returncode": legacy["returncode"],
        "output_tail": legacy["output_tail"],
        "issues": full["issues"],
        "by_check": full["by_check"],
    }


# ────────────────────────── v0.7.113+ draft 자동 current 머신 (ADR-2026-07-08) ──────────────────────────

from datetime import datetime, timedelta, timezone  # noqa: E402

_DRAFT_AUTO_PROMOTE_DAYS = 7
_ISO_FMT = "%Y-%m-%d"


def _parse_iso_date(s):
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], _ISO_FMT).replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _audit_violation_clean(vault):
    """lint #18 audit violation 패턴이 감지되지 않으면 True."""
    try:
        violations = check_audit_violation_pattern(vault)
        return not violations
    except Exception:
        return False


def _auto_promote_draft_issues(vault):
    """type=issue + status=draft + created+7일+ → status=current 자동 승격.
    lint #18 audit 위반 없음이 전제. log.md에 audit 레코드 append.
    """
    if not _audit_violation_clean(vault):
        return 0

    cutoff = datetime.now(timezone.utc) - timedelta(days=_DRAFT_AUTO_PROMOTE_DAYS)
    promoted = 0
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        if slug.startswith("_meta/"):
            continue
        try:
            text = _read_text(fp)
        except Exception:
            continue
        meta, body = _split_fm_body(text)
        if not meta:
            continue
        ptype = (meta.get("type") or "").strip().lower()
        pstatus = (meta.get("status") or "").strip().lower()
        if ptype != "issue" or pstatus != "draft":
            continue
        created = _parse_iso_date(meta.get("created"))
        if not created or created > cutoff:
            continue
        new_text = _swap_status_in_fm(text, "draft", "current")
        if new_text:
            stamp_line = (
                f"\n- {{actor: agent, action: draft→current, "
                f"at: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}, "
                f"evidence: ADR-2026-07-08 lint #13}}\n"
            )
            new_text = _append_agent_stamp(new_text, stamp_line)
            fp.write_text(new_text, encoding="utf-8")
            promoted += 1
            try:
                _append_log_audit(vault, slug, "draft→current")
            except Exception:
                pass
    return promoted


def _swap_status_in_fm(text, old, new):
    """frontmatter 안의 status 필드를 swap. 실패 시 None."""
    import re
    m = re.search(r"^(---\n)(.+?)(\n---)", text, re.DOTALL | re.MULTILINE)
    if not m:
        return None
    head, fm, tail = m.group(1), m.group(2), m.group(3)
    new_fm_lines = []
    replaced = False
    for line in fm.split("\n"):
        if line.startswith("status:"):
            new_fm_lines.append(f"status: {new}")
            replaced = True
        else:
            new_fm_lines.append(line)
    if not replaced:
        new_fm_lines.append(f"status: {new}")
    return head + "\n".join(new_fm_lines) + tail


def _append_agent_stamp(text, line):
    """frontmatter 직후 body에 agents: 리스트 stamp append (없으면 만들기)."""
    import re
    m = re.search(r"^(---\n.+?\n---\n)", text, re.DOTALL | re.MULTILINE)
    if not m:
        return text + line
    head = m.group(1)
    rest = text[len(head):]
    if rest.lstrip().startswith("agents:"):
        idx = rest.index("agents:")
        return head + rest[:idx] + "agents:\n" + line + rest[idx + len("agents:"):]
    return head + "agents:\n" + line + rest


def _append_log_audit(vault, slug, action):
    log_path = vault.root / "log.md"
    if not log_path.exists():
        return
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    line = (
        f"\n## [{date_str}] auto-promote | {slug} | "
        f"action={action} | actor=agent | reason=ADR-2026-07-08\n"
    )
    with log_path.open("a", encoding="utf-8") as f:
        f.write(line)

def check_placeholder_text(vault: Vault) -> list[dict]:
    """#20 empty or placeholder text (v0.7.127+).

    본문이나 frontmatter 내에 TBD, N/A, '추후 작성', '임시', 'placeholder' 문구 감지 시 critical 에러 반환.
    면제:
      - _meta/ 하위 페이지
      - wip/, scratch/ 하위 페이지
      - tags에 wip, draft, scratch, memo, quick이 포함된 경우
      - status ∈ {draft, archived}
    """
    out: list[dict] = []
    exempt_tags = {"wip", "draft", "scratch", "memo", "quick"}
    patterns = [
        r"\btbd\b", r"\bn/a\b", r"\bplaceholder\b",
        r"추후\s*작성", r"임시\s*작성", r"내용\s*없음", r"비어\s*있음"
    ]
    regexes = [re.compile(p, re.IGNORECASE) for p in patterns]

    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        if slug.startswith("_meta/"):
            continue
        if slug.startswith("content/wip/") or slug.startswith("content/scratch/") or slug.startswith("wip/") or slug.startswith("scratch/"):
            continue
        try:
            text = _read_text(fp)
        except Exception:
            continue
        meta, body = _split_fm_body(text)
        if not meta:
            continue

        pstatus = (meta.get("status") or "current").strip().lower()
        if pstatus in {"draft", "archived"}:
            continue

        tags = meta.get("tags") or []
        if isinstance(tags, list):
            tags_set = {t.strip().lower() for t in tags if isinstance(t, str)}
            if tags_set & exempt_tags:
                continue

        # Frontmatter 텍스트 검사
        fm_text = ""
        m = re.search(r"^(---\n)(.+?)(\n---)", text, re.DOTALL | re.MULTILINE)
        if m:
            fm_text = m.group(2)

        detected = []
        for rx in regexes:
            if rx.search(fm_text) or rx.search(body):
                detected.append(rx.pattern)

        if detected:
            out.append(_mk_issue(
                "#20", "critical", slug,
                f"플레이스홀더 또는 비어 있는 텍스트 발견: {', '.join(detected)}",
            ))
    return out


def check_contextless_wikilinks(vault: Vault) -> list[dict]:
    """#21 contextless wikilinks (v0.7.127+).

    [[wikilink]] 뒤에 맥락적 설명(예: 하이픈 '—' 또는 ':' 뒤의 텍스트가 8자 미만)이 결여된 경우 warning 반환.
    면제:
      - _meta/ 하위 페이지
      - content/_index/ 하위 페이지 및 content/index.md (자동 생성 카탈로그 영역)
      - wip/, scratch/ 하위 페이지
      - status ∈ {archived}
    """
    out: list[dict] = []
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        if slug.startswith("_meta/") or slug.startswith("content/_index/") or slug == "content/index":
            continue
        if slug.startswith("content/wip/") or slug.startswith("content/scratch/") or slug.startswith("wip/") or slug.startswith("scratch/"):
            continue
        try:
            text = _read_text(fp)
        except Exception:
            continue
        meta, body = _split_fm_body(text)
        if not meta:
            continue

        pstatus = (meta.get("status") or "current").strip().lower()
        if pstatus == "archived":
            continue

        lines = body.splitlines()
        for idx, line in enumerate(lines):
            for m in re.finditer(r"\[\[([^\[\]]+?)\]\]", line):
                raw_link = m.group(0)
                link_end_idx = m.end()

                right_text = line[link_end_idx:].strip()

                context_desc = right_text
                for separator in ["—", "-", ":"]:
                    if separator in right_text:
                        context_desc = right_text.split(separator, 1)[1].strip()
                        break

                cleaned_desc = re.sub(r"[\[\]\(\)\{\}\.\,\!\?\*\#\-\s]", "", context_desc)
                if len(cleaned_desc) < 8:
                    out.append(_mk_issue(
                        "#21", "warning", slug,
                        f"라인 {idx+1}: 맥락 없는 wikilink {raw_link} 감지 (최소 8자 이상의 설명 필요)",
                    ))
    return out


def check_journal_summary_completeness(vault: Vault) -> list[dict]:
    """#22 journal/issue 요약 검증 (v0.7.127+).

    type=journal 또는 type=issue인 경우, 본문 최상단에 `# 요약` 섹션이 존재하고,
    3줄 이하의 유의미한 요약이 포함되어 있는지 검증.
    """
    out: list[dict] = []
    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        if slug.startswith("_meta/"):
            continue
        try:
            text = _read_text(fp)
        except Exception:
            continue
        meta, body = _split_fm_body(text)
        if not meta:
            continue
        ptype = (meta.get("type") or "").strip().lower()
        if ptype not in {"journal", "issue"}:
            continue

        pstatus = (meta.get("status") or "current").strip().lower()
        if pstatus == "archived":
            continue

        lines = body.splitlines()
        summary_idx = -1
        for idx, line in enumerate(lines):
            if re.match(r"^#\s+요약\b", line.strip()):
                summary_idx = idx
                break

        if summary_idx == -1:
            out.append(_mk_issue(
                "#22", "warning", slug,
                f"{ptype} 문서에 '# 요약' 섹션이 누락되었습니다.",
            ))
            continue

        summary_lines = []
        for line in lines[summary_idx+1:]:
            s = line.strip()
            if s.startswith("#"):
                break
            if s:
                summary_lines.append(s)

        if not summary_lines:
            out.append(_mk_issue(
                "#22", "warning", slug,
                f"요약 섹션이 비어 있습니다.",
            ))
            continue

        if len(summary_lines) > 3:
            out.append(_mk_issue(
                "#22", "warning", slug,
                f"요약 섹션이 3줄을 초과합니다 (현재 {len(summary_lines)}줄).",
            ))

        combined_summary = " ".join(summary_lines)
        log_patterns = [
            r"exit code\s+\d+", r"errorcode\s+\d+", r"\[\d{4}-\d{2}-\d{2}\]",
            r"\bexception\b", r"\btraceback\b", r"build\s+failed", r"lint\s+failed"
        ]
        detected_logs = [p for p in log_patterns if re.search(p, combined_summary, re.IGNORECASE)]
        if detected_logs:
            out.append(_mk_issue(
                "#22", "warning", slug,
                f"요약 섹션에 단순 기계 로그/에러 메시지 복사 정황 감지: {', '.join(detected_logs)}",
            ))

    return out


def check_semantic_relations(vault: Vault) -> list[dict]:
    """#23 semantic relations integrity (v0.8.0+).

    frontmatter의 relations 필드 형식 및 5대 핵심 관계, 대상 존재 여부,
    그리고 evidence/reason 필수 기재 여부를 검증합니다.
    """
    out: list[dict] = []
    
    # vault 내 모든 페이지의 slug 목록을 구함
    all_slugs = set()
    for fp in _all_pages(vault):
        try:
            slug = _slug_of(vault, fp)
            all_slugs.add(slug)
        except Exception:
            continue

    # 단축 slug 매칭용 캐시
    # rsplit('/', 1)[-1] -> full_slug 매핑
    short_slug_map = {}
    for slug in all_slugs:
        base = slug.rsplit("/", 1)[-1]
        short_slug_map.setdefault(base, []).append(slug)

    relations_map = {}
    pages_meta = {}

    for fp in _all_pages(vault):
        slug = _slug_of(vault, fp)
        if slug.startswith("_meta/") or slug.startswith("content/_index/") or slug == "content/index":
            continue
        try:
            text = _read_text(fp)
        except Exception:
            continue
        meta, _ = _split_fm_body(text)
        if not meta:
            continue
        pages_meta[slug] = meta

        if "relations" not in meta:
            continue

        relations = meta.get("relations")
        if not isinstance(relations, list):
            out.append(_mk_issue(
                "#23", "critical", slug,
                "frontmatter의 'relations' 필드가 리스트(list) 형식이 아닙니다.",
            ))
            continue

        for idx, rel in enumerate(relations):
            if not isinstance(rel, dict):
                out.append(_mk_issue(
                    "#23", "critical", slug,
                    f"relations[{idx}] 항목이 사전(dict) 형식이 아닙니다.",
                ))
                continue

            rel_type = rel.get("type")
            target = rel.get("target")

            # 1. 필수 필드 검증 (type, target)
            if not rel_type:
                out.append(_mk_issue(
                    "#23", "warning", slug,
                    f"relations[{idx}] 항목에 'type' 필드가 누락되었거나 비어 있습니다.",
                ))
            elif rel_type not in SEMANTIC_RELATION_TYPES:
                out.append(_mk_issue(
                    "#23", "warning", slug,
                    f"relations[{idx}] 항목의 관계 타입 '{rel_type}'은 허용되지 않습니다. (허용 목록: {', '.join(sorted(SEMANTIC_RELATION_TYPES))})",
                ))

            if not target:
                out.append(_mk_issue(
                    "#23", "warning", slug,
                    f"relations[{idx}] 항목에 'target' 필드가 누락되었거나 비어 있습니다.",
                ))
                continue

            target = str(target).strip()

            # 2. 자기 참조 검사
            if target == slug:
                out.append(_mk_issue(
                    "#23", "warning", slug,
                    f"자기 자신({slug})을 가리키는 관계는 허용되지 않습니다.",
                ))

            # 3. target 문서 존재 여부 검사 (단축 slug 포함)
            target_exists = False
            resolved_target = None
            if target in all_slugs:
                target_exists = True
                resolved_target = target
            else:
                # 단축 slug 해소 시도
                base = target.rsplit("/", 1)[-1]
                candidates = short_slug_map.get(base, [])
                if candidates:
                    target_exists = True
                    resolved_target = candidates[0]
            
            if not target_exists:
                out.append(_mk_issue(
                    "#23", "warning", slug,
                    f"관계 대상인 '{target}' 문서가 존재하지 않습니다.",
                ))

            # 4. evidence 및 reason 필수 검증
            evidence = rel.get("evidence")
            reason = rel.get("reason")

            if not has_relation_evidence(evidence) or not has_relation_reason(reason):
                out.append(_mk_issue(
                    "#23", "warning", slug,
                    f"관계 '{rel_type or 'unknown'} ➔ {target}'에 대한 evidence(근거) 또는 reason(이유)이 누락되었습니다.",
                ))

            if target_exists and resolved_target and rel_type:
                relations_map.setdefault(slug, []).append({
                    "target": resolved_target,
                    "type": rel_type
                })

    # 5. 상호/대칭 관계 린트 자동 검증 (Symmetric Relation Validation)
    for src, rels in relations_map.items():
        for rel in rels:
            tgt = rel["target"]
            rtype = rel["type"]
            
            if rtype == "implements":
                tgt_rels = relations_map.get(tgt, [])
                has_symmetric = any(r["target"] == src and r["type"] == "implemented_by" for r in tgt_rels)
                if not has_symmetric:
                    out.append(_mk_issue(
                        "#23", "warning", src,
                        f"대칭 관계 누락: 이 문서가 '{tgt}'을(를) implements 하지만, '{tgt}' 문서에는 이 문서에 대한 implemented_by 관계가 정의되어 있지 않습니다."
                    ))
            elif rtype == "implemented_by":
                tgt_rels = relations_map.get(tgt, [])
                has_symmetric = any(r["target"] == src and r["type"] == "implements" for r in tgt_rels)
                if not has_symmetric:
                    out.append(_mk_issue(
                        "#23", "warning", src,
                        f"대칭 관계 누락: 이 문서가 '{tgt}'에 의해 implemented_by 되지만, '{tgt}' 문서에는 이 문서에 대한 implements 관계가 정의되어 있지 않습니다."
                    ))

    # 6. 의존성 경고 및 상태 추적 (Broken Dependency Alert)
    for src, rels in relations_map.items():
        for rel in rels:
            tgt = rel["target"]
            rtype = rel["type"]
            
            if rtype == "depends_on":
                tgt_meta = pages_meta.get(tgt)
                if tgt_meta:
                    tgt_type = tgt_meta.get("type")
                    tgt_status = tgt_meta.get("status")
                    tgt_issue_status = tgt_meta.get("issue_status")
                    tgt_archived = bool(tgt_meta.get("archived", False))
                    
                    is_issue_rejected = (tgt_type == "issue" and 
                                         (tgt_status == "rejected" or tgt_issue_status == "rejected"))
                    is_archived = (tgt_status == "archived" or 
                                   tgt_archived is True or 
                                   tgt_type == "archived")
                    
                    if is_issue_rejected or is_archived:
                        out.append(_mk_issue(
                            "#23", "warning", src,
                            f"의존성 경고: 이 문서가 의존하는 '{tgt}' 문서의 상태가 issue/rejected 이거나 archived 입니다."
                        ))

    return out

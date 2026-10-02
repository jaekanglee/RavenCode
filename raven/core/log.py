"""raven.core.log — vault 작업 이력 (log.md) 관리.

카파시 LLM Wiki gist의 "log.md is chronological, append-only, grep-parseable"
패턴을 차용. 위치는 **vault 루트 고정** (`<vault>/log.md`).

Public surface:
    log_path(vault)                    → Path
    ensure_log(vault)                  → Path (없으면 템플릿에서 생성)
    append(vault, action, subject,
           files=None, note=None)      → None (log.md에 한 줄 추가)
    load(vault)                        → list[dict] (파싱된 entries)
    list_entries(vault, tail=None,
                 action=None)          → list[dict]
    count(vault)                       → int
    rotate(vault, year=None)           → Path (rotate된 파일 경로)

log.md 형식 (카파시):
    ## [YYYY-MM-DD] action | subject
    - files: [a.md, b.md]
    - reason: 한 줄
    - extra: key=value

    ## [2026-06-26] ingest | karpathy LLM Wiki gist
    - files: [content/llm-wiki]
    - source: https://gist.github.com/karpathy/...

Actions: ingest, update, create, archive, delete, lint, build, migrate, chore
"""
from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Optional

from .lock import atomic_write_text, lock_for_file
from .vault import Vault

# v0.7.109+: 자동 rotate 임계값 (사람 명시 rotate와 별개로 append 시 자동 트리거).
# PWW §6.5 #12 (사람 명시 rotate)와 별도. audit log 누적 시 자동 rotate로 무한 누적 방지.
_LOG_ROTATE_THRESHOLD = 500


# ── 경로 ─────────────────────────────────────────

def log_path(vault: Vault) -> Path:
    """log.md 경로. vault 루트 고정."""
    return vault.root / "log.md"


# ── entry 데이터 클래스 ──────────────────────────

@dataclass(frozen=True)
class LogEntry:
    date: str             # "2026-06-26"
    action: str           # "ingest" | "update" | "create" | "archive" | "delete" | "lint" | "build" | "migrate" | "chore"
    subject: str          # free text
    details: list[str] = field(default_factory=list)  # 추가 "- key: val" 줄들

    def header(self) -> str:
        return f"## [{self.date}] {self.action} | {self.subject}"

    def to_md(self) -> str:
        lines = [self.header()]
        for d in self.details:
            lines.append(f"- {d}")
        return "\n".join(lines) + "\n"


# ── 파싱 ─────────────────────────────────────────

# `## [YYYY-MM-DD] action | subject` (action은 alphanumeric/-)
_HEADER_RE = re.compile(
    r"^##\s+\[(\d{4}-\d{2}-\d{2})\]\s+([a-z][a-z0-9_-]*)\s*\|\s*(.+?)\s*$"
)
# `- key: value` (value는 자유)
_DETAIL_RE = re.compile(r"^-\s+(.+?):\s*(.*)$")

_ALLOWED_ACTIONS = {
    "ingest", "update", "create", "archive", "delete",
    "lint", "build", "migrate", "chore",
    # v0.7.67 (평가 A#1): MCP wiki_rename이 쓰는 액션 — CLI/MCP 로그 규약 통일.
    "rename",
    # v0.7.182 §36: MCP wiki_gardening_record — 가드닝 회차 결과(보류·제안 목록 포함).
    "gardening",
}


def _parse_entry(lines: list[str], start: int) -> tuple[Optional[LogEntry], int]:
    """`## [...]` 헤더 한 줄 + 그 뒤의 `-` 디테일들 파싱.

    Returns: (entry, next_index)
    next_index: 이 entry가 끝난 다음 줄 index (빈 줄 포함).
    """
    header = lines[start]
    m = _HEADER_RE.match(header)
    if not m:
        return None, start + 1
    date_str, action, subject = m.group(1), m.group(2), m.group(3)
    details: list[str] = []
    i = start + 1
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            break  # 빈 줄 = entry 끝
        if line.startswith("## "):
            break  # 다음 entry 시작
        dm = _DETAIL_RE.match(line)
        if dm:
            key, val = dm.group(1), dm.group(2)
            details.append(f"{key}: {val}")
        # `- key: val` 형식이 아니면 무시 (preamble 등)
        i += 1
    return LogEntry(date=date_str, action=action, subject=subject, details=details), i


def load(vault: Vault) -> list[LogEntry]:
    """log.md를 통째로 파싱. entry 리스트 반환 (시간 순)."""
    path = log_path(vault)
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    out: list[LogEntry] = []
    i = 0
    while i < len(lines):
        if lines[i].startswith("## [") and _HEADER_RE.match(lines[i]):
            entry, i = _parse_entry(lines, i)
            if entry:
                out.append(entry)
        else:
            i += 1
    return out


def count(vault: Vault) -> int:
    """log.md의 entry 수."""
    return len(load(vault))


def list_entries(
    vault: Vault,
    tail: Optional[int] = None,
    action: Optional[str] = None,
) -> list[dict]:
    """entry 리스트 (dict). tail로 최근 N개, action으로 필터."""
    entries = load(vault)
    if action:
        entries = [e for e in entries if e.action == action]
    if tail is not None and tail > 0:
        entries = entries[-tail:]
    return [
        {
            "date": e.date,
            "action": e.action,
            "subject": e.subject,
            "details": e.details,
        }
        for e in entries
    ]


# ── 생성/추가 ───────────────────────────────────

def ensure_log(vault: Vault) -> Path:
    """log.md 없으면 템플릿에서 생성. 있으면 그대로 반환.

    idempotent. 위치는 vault 루트.
    """
    from importlib import resources

    path = log_path(vault)
    if path.exists():
        return path
    try:
        src = resources.files("raven.core").joinpath("templates/log.md")
        path.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    except Exception:
        # 템플릿이 없거나 패키지 깨짐 — 최소 헤더만 생성
        path.write_text(
            "# Vault Log\n\n"
            "> Chronological record of all vault actions. Append-only.\n"
            "> Format: `## [YYYY-MM-DD] action | subject`\n\n"
            f"## [{date.today().isoformat()}] create | log.md initialized\n"
            f"- reason: raven v0.5.0 (자동 생성)\n",
            encoding="utf-8",
        )
    return path


def append(
    vault: Vault,
    action: str,
    subject: str,
    files: Optional[list[str]] = None,
    note: Optional[str] = None,
    extra: Optional[dict[str, str]] = None,
    date_str: Optional[str] = None,
) -> LogEntry:
    """log.md에 한 entry 추가 (append-only, 원자적 write).

    Args:
        vault: 대상 vault
        action: 9종 액션 중 하나 (ingest/update/create/archive/delete/lint/build/migrate/chore)
        subject: 한 줄 설명
        files: 변경된 파일 리스트 (slug 또는 path)
        note: 추가 한 줄 메모
        extra: 추가 `- key: val` 줄들
        date_str: 기본은 오늘, override 가능 (테스트용)

    Returns:
        추가된 LogEntry

    Raises:
        ValueError: action이 허용 목록에 없을 때
    """
    if action not in _ALLOWED_ACTIONS:
        raise ValueError(
            f"action {action!r} not allowed; "
            f"choose from {sorted(_ALLOWED_ACTIONS)}"
        )

    path = ensure_log(vault)
    entry_date = date_str or date.today().isoformat()
    details: list[str] = []
    if files:
        # raven page slug 형식 유지 (앞에 `content/` 등)
        formatted = ", ".join(files)
        details.append(f"files: [{formatted}]")
    if note:
        details.append(f"reason: {note}")
    if extra:
        # v0.7.117: extra value 타입별 분기.
        #   str → 기존 그대로 "{k}: {v}"
        #   dict → "{k}: <key>=<val>, <key>=<val>, ..." (lint by_check 등 가독성)
        # 기존 caller는 모두 str을 미리 직렬화해서 넘기므로 회귀 없음.
        for k, v in extra.items():
            if isinstance(v, dict):
                items = ", ".join(f"{kk}={vv}" for kk, vv in v.items())
                details.append(f"{k}: {items}")
            elif isinstance(v, list):
                details.extend(f"{k}: {item}" for item in v)
            else:
                details.append(f"{k}: {v}")

    entry = LogEntry(
        date=entry_date,
        action=action,
        subject=subject,
        details=details,
    )

    # lock log.md path during read-modify-write cycle
    should_rotate = False
    try:
        with lock_for_file(vault.root, path):
            existing = path.read_text(encoding="utf-8")
            if existing and not existing.endswith("\n"):
                existing += "\n"
            if existing and not existing.endswith("\n\n"):
                existing += "\n"  # entry 간 빈 줄 보장
            new_content = existing + entry.to_md() + "\n"
            atomic_write_text(path, new_content)
            # v0.7.109+: 500 entries 초과 시 자동 rotate (PWW §12 사람 전용 rotate와 별개).
            try:
                if _LOG_ROTATE_THRESHOLD and count(vault) > _LOG_ROTATE_THRESHOLD:
                    should_rotate = True
            except Exception:
                pass
    except TimeoutError as exc:
        raise RuntimeError(f"Failed to append to log.md due to lock timeout: {exc}")

    if should_rotate:
        rotate(vault)

    return entry


# ── rotate ──────────────────────────────────────

def rotate(vault: Vault, year: Optional[int] = None) -> Path:
    """log.md가 500 entries 초과 시 (또는 명시 호출 시) rotate.

    `log.md` → `log-YYYY.md` (또는 `log-overflow-YYYY.md` 이미 있으면 suffix),
    새 log.md 템플릿으로 재생성.

    Returns: rotate된 파일 경로.
    """
    from importlib import resources

    path = log_path(vault)
    if not path.exists():
        # 없으면 만들 필요 없음
        return path
    target_year = year or date.today().year
    target = vault.root / f"log-{target_year}.md"
    if target.exists():
        # 충돌 회피: log-YYYY-N.md
        i = 1
        while True:
            cand = vault.root / f"log-{target_year}-{i}.md"
            if not cand.exists():
                target = cand
                break
            i += 1
    shutil.move(str(path), str(target))
    # 새 log.md 생성
    try:
        src = resources.files("raven.core").joinpath("templates/log.md")
        path.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    except Exception:
        path.write_text(
            "# Vault Log\n\n"
            "> Chronological record of all vault actions. Append-only.\n"
            "> Format: `## [YYYY-MM-DD] action | subject`\n\n"
            f"## [{date.today().isoformat()}] create | log.md rotated\n"
            f"- reason: 이전 로그는 log-{target_year}.md\n",
            encoding="utf-8",
        )
    # rotation 자체를 새 log에 기록
    append(
        vault,
        action="chore",
        subject=f"log rotated → {target.name}",
        files=[target.name],
        note="500 entries 초과 또는 수동 rotate",
    )
    return target

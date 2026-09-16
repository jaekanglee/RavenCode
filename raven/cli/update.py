"""raven update — git 체크아웃 기반 자체 업데이트.

배포 채널이 곧 레포 접근권이다. 소스는 `scripts/install.sh`(curl 원라이너)가
체크아웃 + venv로 깔고, 그 뒤의 갱신은 체크아웃을 origin으로 fast-forward 하는
것이 곧 업데이트다 — 따로 받아야 할 "바이너리"가 없다.

GitHub release 자산을 쓰지 않는 이유
------------------------------------
릴리스/태그(v0.1.0)는 데스크톱 앱(Raven.app) 버전선이고, 파이썬 패키지는 별도
버전선(raven/__init__.py __version__, 0.7.x)을 따른다. 태그를 업데이트 기준으로
삼으면 최신 태그가 master보다 수십 커밋 뒤처져 있어 다운그레이드가 된다.
데스크톱 앱 자체는 Tauri updater(latest.json)가 따로 처리한다.

안전 규칙: fast-forward만 수행하고, 커밋되지 않은 변경이나 갈라진 히스토리는
덮어쓰지 않고 거부한다 — 업데이트가 작업물을 삼키는 경로를 만들지 않는다.
"""
from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# 이 파일들이 바뀐 범위를 당겨오면 의존성 재설치가 필요하다.
DEP_FILES = ("requirements.txt", "scripts/pyproject.toml")


class GitError(RuntimeError):
    """사용자에게 그대로 보여줄 수 있는 git 실패 — traceback 대신 이유를 전달한다."""


class DepsError(RuntimeError):
    """fast-forward는 끝났고 의존성 재설치에서만 실패 — 소스는 이미 새 버전이다."""


@dataclass(frozen=True)
class RepoStatus:
    root: Path
    branch: str
    dirty: bool
    behind: int
    ahead: int
    changed_files: tuple[str, ...] = field(default=())


@dataclass(frozen=True)
class UpdatePlan:
    action: str  # "up-to-date" | "update" | "blocked"
    reason: str
    reinstall_deps: bool


def resolve_repo_root(start: Optional[Path] = None) -> Optional[Path]:
    """체크아웃 루트를 찾는다. 번들 앱처럼 .git이 없으면 None."""
    if start is None:
        start = Path(__file__).resolve()
    start = start.resolve()
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def read_version_from_checkout(root: Path) -> Optional[str]:
    """당겨온 뒤의 버전은 메모리가 아니라 파일에서 읽어야 최신이다."""
    init_py = root / "raven" / "__init__.py"
    try:
        text = init_py.read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r'^__version__\s*=\s*["\']([^"\']+)["\']', text, re.MULTILINE)
    return match.group(1) if match else None


def plan_update(status: RepoStatus) -> UpdatePlan:
    if status.dirty:
        return UpdatePlan(
            "blocked",
            "커밋되지 않은 변경이 있습니다 — `git stash` 또는 커밋 후 다시 시도하세요.",
            False,
        )
    if status.behind and status.ahead:
        return UpdatePlan(
            "blocked",
            f"로컬이 원격과 갈라졌습니다 (로컬 {status.ahead} / 원격 {status.behind}) — 수동으로 정리하세요.",
            False,
        )
    if status.behind == 0:
        return UpdatePlan("up-to-date", "이미 최신입니다.", False)
    reinstall = any(f in DEP_FILES for f in status.changed_files)
    return UpdatePlan("update", f"{status.behind}개 커밋을 받을 수 있습니다.", reinstall)


def _git(root: Path, *args: str) -> str:
    """git 호출. 실패하면 git이 실제로 말한 이유를 GitError로 올린다.

    check=True + capture_output의 기본 동작은 stderr를 CalledProcessError 안에
    가둬서 화면에는 exit code만 남는다 — detached HEAD나 upstream 미설정처럼
    사용자가 고칠 수 있는 상태일수록 그 메시지가 필요하다.
    """
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError as exc:  # git 자체가 없음
        raise GitError("git 명령을 찾을 수 없습니다.") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip() or f"git {' '.join(args)} 실패 (exit {exc.returncode})"
        raise GitError(detail) from exc
    return result.stdout.strip()


def read_repo_status(root: Path) -> RepoStatus:
    # 네트워크(fetch) 전에 로컬에서 판정 가능한 상태부터 걸러 전용 안내를 준다.
    branch = _git(root, "rev-parse", "--abbrev-ref", "HEAD")
    if branch == "HEAD":
        raise GitError("detached HEAD 상태입니다 — `git switch <브랜치>` 후 다시 시도하세요.")
    try:
        _git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    except GitError:
        raise GitError(
            f"'{branch}' 브랜치에 upstream이 없습니다 — "
            f"`git branch -u origin/{branch}` 후 다시 시도하세요."
        ) from None

    _git(root, "fetch", "--quiet", "origin")
    dirty = bool(_git(root, "status", "--porcelain"))
    behind = int(_git(root, "rev-list", "--count", "HEAD..@{u}") or 0)
    ahead = int(_git(root, "rev-list", "--count", "@{u}..HEAD") or 0)
    changed = _git(root, "diff", "--name-only", "HEAD..@{u}")
    return RepoStatus(
        root=root,
        branch=branch,
        dirty=dirty,
        behind=behind,
        ahead=ahead,
        changed_files=tuple(f for f in changed.splitlines() if f),
    )


def runtime_python(root: Path) -> str:
    """의존성을 설치할 인터프리터 — raven.sh와 같은 규칙.

    sys.executable은 '사용자가 친 파이썬'이라 런타임 venv와 다를 수 있다. 시스템
    파이썬으로 실행하면 pip이 엉뚱한 곳(또는 externally-managed 에러)으로 간다.
    """
    venv_python = root / "scripts" / ".venv" / "bin" / "python"
    return str(venv_python) if venv_python.exists() else sys.executable


def apply_update(root: Path, reinstall_deps: bool) -> None:
    # --ff-only: merge 커밋도, rebase도 만들지 않는다. 깔끔한 전진이 아니면 실패.
    _git(root, "merge", "--ff-only", "@{u}")
    if not reinstall_deps:
        return
    python = runtime_python(root)
    for target in (["-r", str(root / "requirements.txt")], ["-e", str(root / "scripts")]):
        proc = subprocess.run(
            [python, "-m", "pip", "install", "--quiet", *target],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise DepsError((proc.stderr or "").strip() or "pip install 실패")

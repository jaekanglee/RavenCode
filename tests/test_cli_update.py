"""raven update — git 체크아웃 기반 자체 업데이트 검증.

배포 채널이 GitHub release 자산이 아니라 레포 접근권 자체이기 때문에
(`pip install -e ./scripts` editable 설치), 업데이트는 origin/master로의
fast-forward로 처리한다. 태그(v0.1.0)는 데스크톱 앱 버전선이라 파이썬
패키지(0.7.x)의 업데이트 기준으로 쓸 수 없다.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from raven.cli import update as update_module
from raven.cli.update import RepoStatus, plan_update, resolve_repo_root
from raven.cli.__main__ import app

runner = CliRunner()


def _status(**kw) -> RepoStatus:
    base = dict(
        root=Path("/tmp/repo"),
        branch="master",
        dirty=False,
        behind=0,
        ahead=0,
        changed_files=(),
    )
    base.update(kw)
    return RepoStatus(**base)


# ────────────────────────── resolve_repo_root ──────────────────────────


def test_resolve_repo_root_finds_checkout(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    nested = tmp_path / "raven" / "cli"
    nested.mkdir(parents=True)
    assert resolve_repo_root(nested) == tmp_path


def test_resolve_repo_root_returns_none_when_not_a_checkout(tmp_path: Path) -> None:
    # 번들 앱(/Applications/Raven.app/.../resources/raven)에는 .git이 없다.
    bundled = tmp_path / "Raven.app" / "Contents" / "Resources" / "resources" / "raven"
    bundled.mkdir(parents=True)
    assert resolve_repo_root(bundled) is None


# ────────────────────────── plan_update ──────────────────────────


def test_plan_update_reports_up_to_date_when_not_behind() -> None:
    plan = plan_update(_status(behind=0))
    assert plan.action == "up-to-date"
    assert plan.reinstall_deps is False


def test_plan_update_blocks_on_dirty_tree() -> None:
    # 커밋 안 된 작업을 fast-forward가 덮어쓰지 않도록 먼저 막는다.
    plan = plan_update(_status(dirty=True, behind=3))
    assert plan.action == "blocked"
    assert "커밋" in plan.reason


def test_plan_update_blocks_when_diverged() -> None:
    plan = plan_update(_status(behind=2, ahead=1))
    assert plan.action == "blocked"
    assert plan.reinstall_deps is False


def test_plan_update_allows_local_only_commits_when_not_behind() -> None:
    # 로컬이 앞서 있기만 하면 업데이트할 게 없는 것이지 에러가 아니다.
    plan = plan_update(_status(behind=0, ahead=4))
    assert plan.action == "up-to-date"


def test_plan_update_flags_dep_reinstall_when_requirements_changed() -> None:
    plan = plan_update(_status(behind=1, changed_files=("requirements.txt", "raven/core/db.py")))
    assert plan.action == "update"
    assert plan.reinstall_deps is True


def test_plan_update_flags_dep_reinstall_when_scripts_pyproject_changed() -> None:
    plan = plan_update(_status(behind=1, changed_files=("scripts/pyproject.toml",)))
    assert plan.reinstall_deps is True


def test_plan_update_skips_dep_reinstall_for_code_only_changes() -> None:
    plan = plan_update(_status(behind=2, changed_files=("raven/cli/__main__.py",)))
    assert plan.action == "update"
    assert plan.reinstall_deps is False


# ────────────────────────── version parsing ──────────────────────────


def test_read_version_from_checkout(tmp_path: Path) -> None:
    pkg = tmp_path / "raven"
    pkg.mkdir()
    (pkg / "__init__.py").write_text('"""doc."""\n__version__ = "9.9.9"  # SOT\n', encoding="utf-8")
    assert update_module.read_version_from_checkout(tmp_path) == "9.9.9"


def test_read_version_from_checkout_missing_returns_none(tmp_path: Path) -> None:
    assert update_module.read_version_from_checkout(tmp_path) is None


# ────────────────────────── CLI wiring ──────────────────────────


def test_update_errors_outside_git_checkout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(update_module, "resolve_repo_root", lambda _start=None: None)
    result = runner.invoke(app, ["update"])
    assert result.exit_code != 0
    assert "git 체크아웃" in result.stdout


def test_update_check_does_not_mutate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(update_module, "resolve_repo_root", lambda _start=None: tmp_path)
    monkeypatch.setattr(
        update_module, "read_repo_status", lambda root: _status(root=root, behind=2)
    )

    def _boom(*a, **kw):  # pragma: no cover - 호출되면 테스트 실패
        raise AssertionError("--check 는 저장소를 변경하면 안 된다")

    monkeypatch.setattr(update_module, "apply_update", _boom)
    result = runner.invoke(app, ["update", "--check"])
    assert result.exit_code == 0, result.stdout
    assert "2" in result.stdout


def test_update_check_still_answers_on_dirty_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # --check는 읽기 전용이다. dirty 판정에 untracked가 포함돼 개발 트리는 상시
    # dirty이므로, 여기서 막으면 "받을 게 있는지"조차 물어볼 수 없게 된다.
    monkeypatch.setattr(update_module, "resolve_repo_root", lambda _start=None: tmp_path)
    monkeypatch.setattr(
        update_module,
        "read_repo_status",
        lambda root: _status(root=root, behind=3, dirty=True),
    )
    result = runner.invoke(app, ["update", "--check"])
    assert result.exit_code == 0, result.stdout
    assert "3" in result.stdout
    assert "커밋" in result.stdout  # 차단 사유도 함께 안내


def test_update_reports_git_error_reason(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # detached HEAD / upstream 미설정 등은 traceback이 아니라 이유가 보여야 한다.
    monkeypatch.setattr(update_module, "resolve_repo_root", lambda _start=None: tmp_path)

    def _raise(_root):
        raise update_module.GitError("detached HEAD 상태입니다 — `git switch <브랜치>` 후 다시 시도하세요.")

    monkeypatch.setattr(update_module, "read_repo_status", _raise)
    result = runner.invoke(app, ["update"])
    assert result.exit_code != 0
    assert "detached HEAD" in result.stdout
    assert "Traceback" not in result.stdout


def test_update_reports_half_applied_state_when_deps_fail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # ff는 끝났는데 pip이 죽으면 소스만 새 버전인 반쪽 상태다 — 숨기면 안 된다.
    pkg = tmp_path / "raven"
    pkg.mkdir()
    (pkg / "__init__.py").write_text('__version__ = "2.0.0"\n', encoding="utf-8")
    monkeypatch.setattr(update_module, "resolve_repo_root", lambda _start=None: tmp_path)
    monkeypatch.setattr(
        update_module,
        "read_repo_status",
        lambda root: _status(root=root, behind=1, changed_files=("requirements.txt",)),
    )

    def _deps_fail(_root, _reinstall):
        raise update_module.DepsError("error: externally-managed-environment")

    monkeypatch.setattr(update_module, "apply_update", _deps_fail)
    result = runner.invoke(app, ["update"])
    assert result.exit_code != 0
    assert "소스는" in result.stdout
    assert "make install" in result.stdout


def test_runtime_python_prefers_checkout_venv(tmp_path: Path) -> None:
    # sys.executable은 '사용자가 친 파이썬'이라 런타임 venv와 다를 수 있다.
    venv_python = tmp_path / "scripts" / ".venv" / "bin" / "python"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("", encoding="utf-8")
    assert update_module.runtime_python(tmp_path) == str(venv_python)


def test_runtime_python_falls_back_to_sys_executable(tmp_path: Path) -> None:
    assert update_module.runtime_python(tmp_path) == sys.executable


def test_update_blocked_status_exits_nonzero(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(update_module, "resolve_repo_root", lambda _start=None: tmp_path)
    monkeypatch.setattr(
        update_module, "read_repo_status", lambda root: _status(root=root, behind=1, dirty=True)
    )
    result = runner.invoke(app, ["update"])
    assert result.exit_code != 0
    assert "커밋" in result.stdout


# ────────────────────────── 실제 git 배관 ──────────────────────────
# 위 순수 로직 테스트는 git 명령어 문자열(rev-list --count HEAD..@{u} 등)의
# 오타를 잡지 못한다. 진짜 remote/clone을 만들어 배관 자체를 검증한다.


def _git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(cwd), *args], capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


@pytest.fixture
def repo_pair(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """(원격을 대신 조작할 seed 클론, 업데이트 대상 work 클론)."""
    if shutil.which("git") is None:  # pragma: no cover
        pytest.skip("git 없음")
    # 전역 git 설정(commit.gpgsign, core.hooksPath 등)이 켜진 머신에서도 깨지지 않게 격리.
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)

    seed = tmp_path / "seed"
    subprocess.run(["git", "clone", "-q", str(remote), str(seed)], check=True)
    _git(seed, "config", "user.email", "t@example.com")
    _git(seed, "config", "user.name", "t")
    (seed / "raven").mkdir()
    (seed / "raven" / "__init__.py").write_text('__version__ = "1.0.0"\n', encoding="utf-8")
    (seed / "requirements.txt").write_text("typer\n", encoding="utf-8")
    _git(seed, "add", "-A")
    _git(seed, "commit", "-qm", "seed")
    _git(seed, "push", "-q", "origin", "HEAD:refs/heads/master")

    work = tmp_path / "work"
    subprocess.run(["git", "clone", "-q", "-b", "master", str(remote), str(work)], check=True)
    return seed, work


def test_read_repo_status_reports_clean_and_current(repo_pair: tuple[Path, Path]) -> None:
    _seed, work = repo_pair
    status = update_module.read_repo_status(work)
    assert status.behind == 0 and status.ahead == 0
    assert status.dirty is False
    assert plan_update(status).action == "up-to-date"


def test_read_repo_status_detects_dirty_tree(repo_pair: tuple[Path, Path]) -> None:
    _seed, work = repo_pair
    (work / "raven" / "__init__.py").write_text('__version__ = "1.0.0"\n# edit\n', encoding="utf-8")
    assert update_module.read_repo_status(work).dirty is True


def test_apply_update_fast_forwards_and_reports_new_version(
    repo_pair: tuple[Path, Path]
) -> None:
    seed, work = repo_pair
    (seed / "raven" / "__init__.py").write_text('__version__ = "1.1.0"\n', encoding="utf-8")
    (seed / "requirements.txt").write_text("typer\nrich\n", encoding="utf-8")
    _git(seed, "add", "-A")
    _git(seed, "commit", "-qm", "bump")
    _git(seed, "push", "-q", "origin", "HEAD:refs/heads/master")

    status = update_module.read_repo_status(work)
    assert status.behind == 1
    plan = plan_update(status)
    assert plan.action == "update"
    # requirements.txt가 바뀌었으니 의존성 재설치가 필요하다고 판단해야 한다.
    assert plan.reinstall_deps is True

    assert update_module.read_version_from_checkout(work) == "1.0.0"
    # 재설치(pip)는 테스트에서 돌리지 않는다 — git 전진만 검증.
    update_module.apply_update(work, reinstall_deps=False)
    assert update_module.read_version_from_checkout(work) == "1.1.0"
    assert update_module.read_repo_status(work).behind == 0

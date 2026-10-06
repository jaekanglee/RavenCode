"""MCP SDK 핀 단일화 가드 (v0.7.184).

사고 배경 — 데스크톱 번들만 MCP 엔드포인트를 못 띄우던 원인은 핀이 다섯 군데로
갈라져 있었던 것이다. `requirements.txt`는 `mcp>=1.12,<2.0`이었는데
`scripts/prepare-bundle.sh`는 상한 없는 `mcp>=1.28`을 따로 들고 있었고, mcp 2.0.0이
릴리스되자 번들만 2.0을 물었다. 2.0은 `mcp.server.fastmcp`를 제거했으므로 번들
런타임은 `ModuleNotFoundError`로 죽었고, 외부 에이전트는 "MCP가 안 떠 있다"만 봤다.

핀은 requirements.txt 한 곳에만 둔다. 다른 설치 경로(번들·Docker·Makefile·
scripts 패키지)는 그 파일을 설치할 뿐, 자기 핀을 다시 선언하지 않는다.
"""
from __future__ import annotations

import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# 설치를 수행하는 모든 경로. 여기에 mcp 핀이 직접 박히면 안 된다.
INSTALL_SURFACES = (
    "scripts/prepare-bundle.sh",
    "Dockerfile",
    "Makefile",
    "scripts/pyproject.toml",
)

# 주석이 아닌 줄에서 mcp 패키지 핀을 찾는다 ("mcp>=…", 'mcp[cli]>=…' 등).
_MCP_PIN = re.compile(r"""["']?mcp(\[[a-z,]+\])?\s*[<>=!~]=""")


def _uncommented_lines(text: str, comment_prefixes: tuple[str, ...]) -> list[str]:
    out = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(comment_prefixes):
            continue
        out.append(line)
    return out


def test_requirements_declares_the_mcp_pin():
    """단일 진실 원천에는 핀이 반드시 있어야 한다 (그리고 2.x여야 한다)."""
    lines = _uncommented_lines((ROOT / "requirements.txt").read_text(encoding="utf-8"), ("#",))
    pins = [ln for ln in lines if _MCP_PIN.search(ln)]
    assert len(pins) == 1, f"requirements.txt의 mcp 핀은 정확히 1줄이어야 한다: {pins}"
    pin = pins[0]
    assert ">=2.1" in pin and "<3.0" in pin, (
        f"mcp 2.1+로 고정되어야 한다 (1.x는 MCPServer 부재, 2.0.0은 UnexpectedToolError 부재, "
        f"3.0은 미검증): {pin!r}"
    )


def test_no_other_install_surface_pins_mcp():
    """번들·이미지·Makefile·scripts 패키지는 자기 mcp 핀을 갖지 않는다."""
    offenders: list[str] = []
    for rel in INSTALL_SURFACES:
        path = ROOT / rel
        if not path.exists():
            continue
        prefixes = ("#",) if not rel.endswith(".toml") else ("#",)
        for line in _uncommented_lines(path.read_text(encoding="utf-8"), prefixes):
            if _MCP_PIN.search(line):
                offenders.append(f"{rel}: {line.strip()}")
    assert not offenders, (
        "mcp 핀이 requirements.txt 밖에서 재선언됐다 — 번들 드리프트 재발 경로다:\n  "
        + "\n  ".join(offenders)
    )


def test_bundle_installs_from_requirements():
    """prepare-bundle.sh가 requirements.txt를 실제로 설치하는지."""
    script = (ROOT / "scripts/prepare-bundle.sh").read_text(encoding="utf-8")
    assert "-r \"$REPO_ROOT/requirements.txt\"" in script, (
        "prepare-bundle.sh는 requirements.txt를 설치해야 한다 (핀 하드코딩 금지)"
    )


def test_bundle_pip_command_is_isolated_and_preserves_spaces(tmp_path):
    script = (ROOT / "scripts/prepare-bundle.sh").read_text(encoding="utf-8")
    declaration = next(line for line in script.splitlines() if line.startswith("BUNDLED_PIP="))
    resources = tmp_path / "bundle resources"
    result = subprocess.run(
        ["bash", "-c", declaration + '\nprintf "%s\\0" "${BUNDLED_PIP[@]}"'],
        env={**os.environ, "RESOURCES": str(resources)},
        capture_output=True,
        check=True,
        timeout=10,
    )
    assert result.stdout.decode().split("\0")[:-1] == [
        str(resources / "python/bin/python3"), "-I", "-m", "pip", "--isolated",
    ]
    assert '"${BUNDLED_PIP[@]}" install' in script
    assert '"${BUNDLED_PIP[@]}" list' in script


def test_bundle_validation_rejects_user_site_dependency(tmp_path):
    script = (ROOT / "scripts/prepare-bundle.sh").read_text(encoding="utf-8")
    invocation, remainder = script.split(" <<'PY'\n", 1)
    flags = shlex.split(invocation.splitlines()[-1])[1:-1]
    validator = remainder.split("\nPY\n", 1)[0]
    userbase = tmp_path / "userbase"
    env = {key: value for key, value in os.environ.items() if not key.startswith("PYTHON")}
    env["PYTHONUSERBASE"] = str(userbase)
    python = sys._base_executable
    probe = subprocess.run(
        [python, "-c", "import site; print(site.getusersitepackages())"],
        env=env, capture_output=True, text=True, check=True, timeout=10,
    )
    metadata = Path(probe.stdout.strip()) / "raven_bundle_probe-1.0.dist-info"
    metadata.mkdir(parents=True)
    (metadata / "METADATA").write_text("Name: raven-bundle-probe\nVersion: 1.0\n", encoding="utf-8")
    requirements = tmp_path / "requirements.txt"
    requirements.write_text("raven-bundle-probe>=1.0\n", encoding="utf-8")
    # Control: the host's user package would satisfy the old validator.
    control = subprocess.run(
        [python, "-", str(requirements)], input=validator, env=env,
        capture_output=True, text=True, timeout=10,
    )
    assert control.returncode == 0, control.stderr
    isolated = subprocess.run(
        [python, *flags, str(requirements)], input=validator, env=env,
        capture_output=True, text=True, timeout=10,
    )
    assert isolated.returncode != 0
    assert "raven-bundle-probe" in isolated.stderr


# 실제 import 문만 본다 — docstring의 이력 설명("2.0 removed mcp.server.fastmcp")은
# 남겨두는 게 맞으므로 산문까지 잡으면 안 된다.
_FASTMCP_IMPORT = re.compile(
    r"^\s*(?:from\s+mcp\.server\.fastmcp[\w.]*\s+import\b|import\s+mcp\.server\.fastmcp\b)",
    re.MULTILINE,
)


def test_source_and_tests_import_mcp_2x_server_class():
    """mcp 2.0 진입점만 import하는지 — 잔존 fastmcp import는 번들에서 즉사한다."""
    offenders: list[str] = []
    for base in ("raven", "tests", "scripts"):
        for path in ROOT.joinpath(base).rglob("*.py"):
            if "__pycache__" in path.parts:
                continue
            for match in _FASTMCP_IMPORT.finditer(path.read_text(encoding="utf-8")):
                offenders.append(f"{path.relative_to(ROOT)}: {match.group().strip()}")
    assert not offenders, (
        "mcp 2.0에서 제거된 mcp.server.fastmcp를 import한다 "
        f"(→ mcp.server.mcpserver.MCPServer): {offenders}"
    )

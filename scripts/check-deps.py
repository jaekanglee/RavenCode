#!/usr/bin/env python3
"""requirements.txt 핀과 실제 venv 설치본이 어긋났는지 검사한다 (v0.7.185+).

왜 있는가: venv 가 uv 로 만들어져 pip 가 없자 Makefile 의 install/venv-check 가
"venv 없음"으로 단정해 의존성 동기화가 아예 돌지 못했다. 그 결과 requirements.txt
는 `mcp>=2.0` 을 가리키는데 venv 에는 1.29.0 이 남아, MCP 테스트 10건이 조용히
깨진 채로 있었다. 사람이 눈치채기 전에 `make deps-check` 가 말해주게 한다.

exit 0 = 일치, exit 1 = 어긋남(무엇이 어긋났는지 출력).
"""
from __future__ import annotations

import importlib.metadata as md
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def main() -> int:
    try:
        from packaging.requirements import Requirement
    except ImportError:
        print("⚠️  packaging 미설치 — 의존성 대조를 건너뜁니다.")
        return 0

    problems: list[str] = []
    for raw in (REPO / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        try:
            req = Requirement(line)
        except Exception:
            continue
        try:
            installed = md.version(req.name)
        except md.PackageNotFoundError:
            problems.append(f"  {req.name}: 미설치 (요구: {req.specifier or 'any'})")
            continue
        if req.specifier and not req.specifier.contains(installed, prereleases=True):
            problems.append(f"  {req.name}: 설치 {installed} ≠ 요구 {req.specifier}")

    if problems:
        print("❌ requirements.txt 와 venv 가 어긋났습니다 — 'make install' 을 실행하세요:")
        print("\n".join(problems))
        return 1
    print("✅ 의존성이 requirements.txt 와 일치합니다")
    return 0


if __name__ == "__main__":
    sys.exit(main())

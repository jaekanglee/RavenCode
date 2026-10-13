"""데스크톱 앱 버전 SOT 계약 — tauri.conf.json 하나에서만 버전이 나온다.

배경: 0.1.0이 Makefile / make-dmg.sh / install-app.sh / Cargo.toml에 흩어져
하드코딩돼 있었다. 그 상태로 버전을 올리면 DMG 이름·Info.plist·업로드 경로가
조용히 어긋나고, tauri.conf.json과 latest.json의 버전이 달라지면 Tauri updater가
업데이트를 못 띄우거나 무한 재설치를 한다. 드리프트를 테스트로 고정한다.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TAURI_CONF = ROOT / "desktop" / "src-tauri" / "tauri.conf.json"
CARGO_TOML = ROOT / "desktop" / "src-tauri" / "Cargo.toml"
CARGO_LOCK = ROOT / "desktop" / "src-tauri" / "Cargo.lock"

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def _tauri_version() -> str:
    return json.loads(TAURI_CONF.read_text(encoding="utf-8"))["version"]


def test_tauri_conf_version_is_semver() -> None:
    assert SEMVER.match(_tauri_version())


def test_cargo_toml_matches_tauri_conf() -> None:
    match = re.search(r'^version\s*=\s*"([^"]+)"', CARGO_TOML.read_text(encoding="utf-8"), re.M)
    assert match, "Cargo.toml에 version 줄이 없습니다"
    assert match.group(1) == _tauri_version()


def test_cargo_lock_matches_tauri_conf() -> None:
    match = re.search(
        r'^name = "raven-desktop"\nversion = "([^"]+)"',
        CARGO_LOCK.read_text(encoding="utf-8"),
        re.M,
    )
    assert match, "Cargo.lock에 raven-desktop 블록이 없습니다"
    assert match.group(1) == _tauri_version()


@pytest.mark.parametrize(
    "relpath",
    ["Makefile", "scripts/make-dmg.sh", "scripts/install-app.sh", "scripts/sign-update.sh"],
)
def test_release_scripts_do_not_hardcode_dmg_name(relpath: str) -> None:
    # DMG 파일명이 릴리스 경로의 접점이다. 리터럴로 박히면 버전을 올린 순간
    # 존재하지 않는 파일을 업로드하려 든다. (문서·주석의 이력 표기는 무해하므로
    # 광범위한 버전 스캔 대신 이 접점만 정밀하게 고정한다.)
    text = (ROOT / relpath).read_text(encoding="utf-8")
    hardcoded = re.findall(r"Raven_\d+\.\d+\.\d+", text)
    assert not hardcoded, f"{relpath}에 하드코딩된 DMG 이름: {hardcoded}"


def test_makefile_derives_version_from_sot() -> None:
    text = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert "tauri.conf.json" in text, "Makefile이 버전 SOT를 참조하지 않습니다"
    assert "$(DESKTOP_VERSION)" in text, "Makefile이 파생 버전 변수를 쓰지 않습니다"


def test_make_dmg_derives_version_from_sot() -> None:
    text = (ROOT / "scripts" / "make-dmg.sh").read_text(encoding="utf-8")
    assert "tauri.conf.json" in text, "make-dmg.sh가 버전을 SOT에서 읽지 않습니다"


def test_updater_endpoint_points_at_current_repo() -> None:
    # 레포가 RavenWiki → RavenCode로 리네임됐다. 리다이렉트에 기대면 누군가 옛
    # 이름으로 새 레포를 만드는 순간 서명된 업데이트 경로가 조용히 깨진다.
    conf = json.loads(TAURI_CONF.read_text(encoding="utf-8"))
    endpoints = conf["plugins"]["updater"]["endpoints"]
    assert endpoints, "updater 엔드포인트가 비어 있습니다"
    for url in endpoints:
        assert "RavenWiki" not in url, f"옛 레포 이름이 남아 있습니다: {url}"


@pytest.mark.parametrize("relpath", ["Makefile", "scripts/install.sh", "scripts/install-app.sh"])
def test_scripts_do_not_reference_old_repo_name(relpath: str) -> None:
    text = (ROOT / relpath).read_text(encoding="utf-8")
    assert "RavenWiki" not in text, f"{relpath}에 옛 레포 이름(RavenWiki)이 남아 있습니다"


# ── Issue #18 — 코어 버전 노출 + 세 버전의 관계 고정 ────────────────────────────
#
# 결정(제품): 세 버전을 한 값으로 통일하지 않는다. 릴리스 주기가 다르고(코어는
# 매 코어 릴리스마다 오르고, 셸은 자기 주기로 DMG를 굽고, 대시보드는 셸에 번들
# 되는 private 패키지다), 통일하면 코어 릴리스마다 셸을 재빌드·재서명해야 한다.
# 대신 사용자에게 보이는 두 표면을 라벨로 구분하고 각 값을 자기 SOT에서
# 파생시킨다(화면에 리터럴 하드코딩 금지):
#   코어     = raven/__init__.py::__version__  → /api/system/info `core_version`
#   셸       = desktop/src-tauri/tauri.conf.json → 셸 IPC `app_version`
#   대시보드 = dashboard/package.json (private 번들 — 릴리스 버전으로 노출하지 않는다)
# 그래서 여기서는 "두 값이 같다"가 아니라 "코어 값이 자기 SOT에서 온다"를 고정한다.


def _client():
    from fastapi.testclient import TestClient

    from raven.api.server import app

    return TestClient(app)


def test_system_info_exposes_the_core_version_from_its_sot() -> None:
    """관리 화면이 코어 버전을 볼 수 있어야 한다 (셸 버전만 보이던 상태의 회귀 가드)."""
    import raven

    from raven.api import server

    assert server.app.version == raven.__version__  # OpenAPI(/docs)도 코어 SOT를 따른다
    data = _client().get("/api/system/info").json()
    assert data["core_version"] == raven.__version__


def test_system_info_core_version_is_derived_not_hardcoded(monkeypatch: pytest.MonkeyPatch) -> None:
    """코어 버전은 문자열 리터럴이 아니라 raven.__version__에서 파생돼야 한다."""
    from raven.api import server

    monkeypatch.setattr(server, "raven_version", "9.9.9")
    assert _client().get("/api/system/info").json()["core_version"] == "9.9.9"

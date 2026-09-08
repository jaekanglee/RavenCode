"""The API must find the built dashboard in both layouts it ships in.

Regression: shared links (`http://<lan-ip>:8765/page/<vault>/<slug>`) returned
404 from the desktop app because server.py only looked for dashboard/dist two
levels above itself (repo layout). Inside Raven.app the package lives under
Resources/resources/raven/ while make-dmg.sh puts dist at Resources/dashboard/dist.
"""
from __future__ import annotations

from pathlib import Path

from raven.api.server import _resolve_dashboard_dist


def _make_dist(root: Path) -> Path:
    dist = root / "dashboard" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html></html>")
    return dist


def test_repo_layout(tmp_path: Path):
    repo = tmp_path / "repo"
    dist = _make_dist(repo)
    server_py = repo / "raven" / "api" / "server.py"
    server_py.parent.mkdir(parents=True)
    server_py.touch()
    assert _resolve_dashboard_dist(server_py) == dist


def test_bundle_layout(tmp_path: Path):
    resources = tmp_path / "Raven.app" / "Contents" / "Resources"
    dist = _make_dist(resources)
    server_py = resources / "resources" / "raven" / "raven" / "api" / "server.py"
    server_py.parent.mkdir(parents=True)
    server_py.touch()
    assert _resolve_dashboard_dist(server_py) == dist


def test_env_override_wins_and_requires_index(tmp_path: Path):
    dist = _make_dist(tmp_path / "custom")
    somewhere = tmp_path / "x" / "y" / "z" / "server.py"
    somewhere.parent.mkdir(parents=True)
    somewhere.touch()
    assert _resolve_dashboard_dist(somewhere, str(dist)) == dist
    assert _resolve_dashboard_dist(somewhere, str(tmp_path / "missing")) is None


def test_no_dist_anywhere(tmp_path: Path):
    lonely = tmp_path / "a" / "b" / "c" / "d" / "e" / "server.py"
    lonely.parent.mkdir(parents=True)
    lonely.touch()
    assert _resolve_dashboard_dist(lonely) is None


def test_spa_fallback_serves_pages_but_not_unknown_api_paths():
    """Repo checkout has dashboard/dist, so the fallback route is registered."""
    import pytest
    from fastapi.testclient import TestClient
    from raven.api import server

    if server._DASHBOARD_DIST is None:
        pytest.skip("dashboard/dist not built in this checkout")
    client = TestClient(server.app)

    page = client.get("/page/some-vault/content/journal/anything")
    assert page.status_code == 200
    assert page.headers["content-type"].startswith("text/html")

    missing_api = client.get("/api/definitely/not/a/route")
    assert missing_api.status_code == 404
    assert missing_api.headers["content-type"].startswith("application/json")

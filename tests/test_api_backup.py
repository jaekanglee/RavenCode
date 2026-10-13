"""POST /api/backup/export|import — loopback 전용 경로 API 회귀 가드.

Issue #67: every request needs a Bearer token, loopback included. ``local`` below is a
TestClient, which conftest gives the test session credential (like the desktop webview).
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from raven.api.server import app
from raven.core.vault import Vault

local = TestClient(app, client=("127.0.0.1", 50000))
remote = TestClient(app, client=("192.168.0.20", 50000))


def test_export_and_import_from_loopback(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "a"))
    Vault.create("alpha", tmp_path / "a" / "alpha")
    dest = tmp_path / "b.zip"

    res = local.post("/api/backup/export", json={"dest_path": str(dest)})
    assert res.status_code == 200, res.text
    assert res.json()["vaults"] == [{"name": "alpha", "file_count": 1}]

    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "b"))
    res = local.post("/api/backup/import", json={"src_path": str(dest)})
    assert res.status_code == 200, res.text
    assert res.json()["items"][0]["imported_as"] == "alpha"


def test_ipv6_loopback_allowed(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "a"))
    Vault.create("alpha", tmp_path / "a" / "alpha")
    c = TestClient(app, client=("::1", 50000))
    assert c.post("/api/backup/export", json={"dest_path": str(tmp_path / "x.zip")}).status_code == 200


def test_non_loopback_is_forbidden(tmp_path, monkeypatch):
    """Two layers: the app-wide token gate (401) and this endpoint's loopback guard (403).

    Issue #14 put an access gate on the whole app, so an unauthenticated LAN
    source never reaches the handler. A LAN source *with* a valid token passes
    the gate and still hits the path-taking endpoint's own loopback guard.
    """
    from raven.core import mcp_tokens

    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "a"))
    (tmp_path / "a").mkdir()
    token = mcp_tokens.add_token("lan")
    authed = {"Authorization": f"Bearer {token}"}
    non_ip = TestClient(app, client=("testclient", 50000))
    for path, body in (
        ("/api/backup/export", {"dest_path": str(tmp_path / "x.zip")}),
        ("/api/backup/import", {"src_path": str(tmp_path / "x.zip")}),
    ):
        assert remote.post(path, json=body).status_code == 401
        assert non_ip.post(path, json=body).status_code == 401
        assert remote.post(path, json=body, headers=authed).status_code == 403
        assert non_ip.post(path, json=body, headers=authed).status_code == 403


def test_ipv4_mapped_ipv6_loopback_allowed(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "a"))
    Vault.create("alpha", tmp_path / "a" / "alpha")
    c = TestClient(app, client=("::ffff:127.0.0.1", 50000))
    res = c.post("/api/backup/export", json={"dest_path": str(tmp_path / "x.zip")})
    assert res.status_code == 200, res.text


def test_origin_header_checked_on_loopback(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "a"))
    Vault.create("alpha", tmp_path / "a" / "alpha")
    tokenless = TestClient(app, client=("127.0.0.1", 50000), headers={"Authorization": ""})

    def export(client, origin: str, name: str):
        return client.post(
            "/api/backup/export",
            json={"dest_path": str(tmp_path / name)},
            headers={"Origin": origin},
        )

    # Issue #67: without a token the gate refuses every Origin — loopback, desktop webview included.
    for i, origin in enumerate(("http://evil.example", "tauri://localhost", "http://localhost:5173")):
        assert export(tokenless, origin, f"t{i}.zip").status_code == 401, origin
        assert not (tmp_path / f"t{i}.zip").exists()
    # With the (session) token, this path-taking endpoint still keeps foreign Origins off (#15).
    assert export(local, "http://evil.example", "e1.zip").status_code == 403
    assert export(local, "http://192.168.0.5:5173", "e2.zip").status_code == 403
    assert not (tmp_path / "e1.zip").exists() and not (tmp_path / "e2.zip").exists()
    assert export(local, "tauri://localhost", "e3.zip").status_code == 200
    assert export(local, "http://tauri.localhost", "e4.zip").status_code == 200
    assert export(local, "http://localhost:5173", "e5.zip").status_code == 200


def test_relative_path_and_bad_zip_are_400(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "a"))
    assert local.post("/api/backup/export", json={"dest_path": "rel.zip"}).status_code == 400
    junk = tmp_path / "junk.zip"
    junk.write_bytes(b"nope")
    res = local.post("/api/backup/import", json={"src_path": str(junk)})
    assert res.status_code == 400
    assert "열 수 없습니다" in res.json()["detail"]

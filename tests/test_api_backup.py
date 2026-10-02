"""POST /api/backup/export|import — loopback 전용 경로 API 회귀 가드."""
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
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "a"))
    for path, body in (
        ("/api/backup/export", {"dest_path": str(tmp_path / "x.zip")}),
        ("/api/backup/import", {"src_path": str(tmp_path / "x.zip")}),
    ):
        assert remote.post(path, json=body).status_code == 403
        assert TestClient(app).post(path, json=body).status_code == 403  # host "testclient"


def test_ipv4_mapped_ipv6_loopback_allowed(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "a"))
    Vault.create("alpha", tmp_path / "a" / "alpha")
    c = TestClient(app, client=("::ffff:127.0.0.1", 50000))
    res = c.post("/api/backup/export", json={"dest_path": str(tmp_path / "x.zip")})
    assert res.status_code == 200, res.text


def test_origin_header_checked_on_loopback(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "a"))
    Vault.create("alpha", tmp_path / "a" / "alpha")

    def export(origin: str, name: str):
        return local.post(
            "/api/backup/export",
            json={"dest_path": str(tmp_path / name)},
            headers={"Origin": origin},
        )

    assert export("http://evil.example", "e1.zip").status_code == 403
    assert export("http://192.168.0.5:5173", "e2.zip").status_code == 403
    assert export("tauri://localhost", "e3.zip").status_code == 200
    assert export("http://tauri.localhost", "e4.zip").status_code == 200
    assert export("http://localhost:5173", "e5.zip").status_code == 200


def test_relative_path_and_bad_zip_are_400(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "a"))
    assert local.post("/api/backup/export", json={"dest_path": "rel.zip"}).status_code == 400
    junk = tmp_path / "junk.zip"
    junk.write_bytes(b"nope")
    res = local.post("/api/backup/import", json={"src_path": str(junk)})
    assert res.status_code == 400
    assert "열 수 없습니다" in res.json()["detail"]

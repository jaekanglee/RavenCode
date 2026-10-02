"""전체 vault 백업 내보내기·가져오기 (raven/core/backup.py) 회귀 가드.

spec: docs/superpowers/specs/2026-10-02-vault-backup-export-import-design.md
"""
from __future__ import annotations

import json
import os
import stat
import zipfile
from pathlib import Path

import pytest

from raven.core import backup
from raven.core.registry import registry
from raven.core.vault import Vault


@pytest.fixture
def pcs(tmp_path, monkeypatch):
    """PC 두 대 흉내 — WIKI_VAULTS_DIR을 바꿔 가며 쓴다. 시작은 pc-a."""
    a, b = tmp_path / "pc-a", tmp_path / "pc-b"
    a.mkdir()
    b.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(a))

    def use(root: Path) -> None:
        monkeypatch.setenv("WIKI_VAULTS_DIR", str(root))

    return {"a": a, "b": b, "use": use, "tmp": tmp_path}


def make_vault(root: Path, name: str, **kw) -> Vault:
    v = Vault.create(name, root / name, **kw)
    r = v.root
    (r / "content" / "hello.md").write_text("---\ntitle: Hello\n---\n# Hello\n", encoding="utf-8")
    (r / "content" / "empty-dir").mkdir()
    (r / "content" / ".DS_Store").write_bytes(b"ds")
    (r / "raw").mkdir()
    (r / "raw" / "src.txt").write_text("raw", encoding="utf-8")
    (r / "log.md").write_text("# log\n", encoding="utf-8")
    (r / "_archive").mkdir()
    (r / "_archive" / "old.md").write_text("old", encoding="utf-8")
    (r / "mystery").mkdir()
    (r / "mystery" / "x.bin").write_bytes(b"\x00\x01")
    (r / ".graph_positions.json").write_text('{"a": [1, 2]}', encoding="utf-8")
    (r / "wiki.db").write_bytes(b"db")
    (r / ".mcp" / "locks").mkdir(parents=True)
    (r / ".mcp" / "locks" / "l.lock").write_text("x", encoding="utf-8")
    return v


def tree(root: Path, *, ignore: tuple[str, ...] = (".vault.json",)) -> dict:
    return {
        p.relative_to(root).as_posix(): (p.read_bytes() if p.is_file() else None)
        for p in sorted(root.rglob("*"))
        if p.relative_to(root).as_posix() not in ignore
    }


EXCLUDED = {"wiki.db", ".mcp", ".mcp/locks", ".mcp/locks/l.lock", "content/.DS_Store"}


def test_export_writes_manifest_and_excludes_regenerable_files(pcs):
    make_vault(pcs["a"], "alpha", description="첫 vault")
    dest = pcs["tmp"] / "out" / "b.zip"
    report = backup.export_all(dest)

    assert report.path == dest and dest.is_file()
    assert not dest.with_name("b.zip.tmp").exists()
    assert report.vaults == [{"name": "alpha", "file_count": 7}]
    with zipfile.ZipFile(dest) as zf:
        names = set(zf.namelist())
        manifest = json.loads(zf.read("manifest.json"))
    assert "vaults/alpha/content/hello.md" in names
    assert "vaults/alpha/content/empty-dir/" in names
    assert "vaults/alpha/.graph_positions.json" in names
    assert "vaults/alpha/mystery/x.bin" in names
    assert not any(n.endswith(("wiki.db", ".DS_Store", "l.lock")) for n in names)
    assert manifest["format"] == "raven-backup" and manifest["format_version"] == 1
    assert manifest["default"] == "alpha"
    entry = manifest["vaults"][0]
    assert entry["dir"] == "vaults/alpha"
    assert entry["meta"]["description"] == "첫 vault"
    assert "path" not in entry["meta"] and "workspace_path" not in entry["meta"]


def test_export_requires_zip_suffix(pcs):
    with pytest.raises(backup.BackupError):
        backup.export_all(pcs["tmp"] / "b.tar")


def test_export_names_filter_and_unknown_name(pcs):
    make_vault(pcs["a"], "alpha")
    make_vault(pcs["a"], "beta")
    report = backup.export_all(pcs["tmp"] / "only.zip", names=["beta"])
    assert [v["name"] for v in report.vaults] == ["beta"]
    with pytest.raises(backup.BackupError):
        backup.export_all(pcs["tmp"] / "x.zip", names=["nope"])


def test_export_skips_vault_whose_folder_is_gone(pcs):
    make_vault(pcs["a"], "alpha")
    gone = make_vault(pcs["a"], "gone")
    import shutil
    shutil.rmtree(gone.root)
    report = backup.export_all(pcs["tmp"] / "b.zip")
    assert [v["name"] for v in report.vaults] == ["alpha"]
    assert [s["name"] for s in report.skipped] == ["gone"]


def test_export_skips_symlinks(pcs):
    v = make_vault(pcs["a"], "alpha")
    (v.root / "content" / "link.md").symlink_to(v.root / "content" / "hello.md")
    report = backup.export_all(pcs["tmp"] / "b.zip")
    assert report.skipped_files == ["alpha/content/link.md"]
    with zipfile.ZipFile(report.path) as zf:
        assert "vaults/alpha/content/link.md" not in zf.namelist()


def test_default_filename_format():
    from datetime import datetime
    assert backup.default_filename(datetime(2026, 10, 2, 14, 30)) == "raven-backup-20261002-1430.zip"


# ─── import ─────────────────────────────────────────────


def export_from_a(pcs, **make_kw) -> tuple[Path, dict]:
    va = make_vault(pcs["a"], "alpha", description="첫 vault", **make_kw)
    make_vault(pcs["a"], "beta")
    before = {"alpha": tree(va.root), "beta": tree(pcs["a"] / "beta")}
    dest = backup.export_all(pcs["tmp"] / "b.zip").path
    return dest, before


def strip_excluded(t: dict) -> dict:
    return {k: v for k, v in t.items() if k not in EXCLUDED}


def test_roundtrip_to_another_pc_preserves_tree_and_meta(pcs):
    dest, before = export_from_a(pcs)
    pcs["use"](pcs["b"])
    report = backup.import_archive(dest, build=False)

    assert [(i.original, i.imported_as, i.renamed, i.error) for i in report.items] == [
        ("alpha", "alpha", False, None),
        ("beta", "beta", False, None),
    ]
    for name in ("alpha", "beta"):
        assert tree(pcs["b"] / name) == strip_excluded(before[name])
    meta = registry().get("alpha")
    assert meta.path == (pcs["b"] / "alpha").resolve()
    assert meta.description == "첫 vault"
    assert not list(pcs["b"].glob(".import-*"))


def test_import_preserves_mtime(pcs):
    va = make_vault(pcs["a"], "alpha")
    os.utime(va.root / "content" / "hello.md", (1_700_000_000, 1_700_000_000))
    dest = backup.export_all(pcs["tmp"] / "b.zip").path
    pcs["use"](pcs["b"])
    backup.import_archive(dest, build=False)
    got = (pcs["b"] / "alpha" / "content" / "hello.md").stat().st_mtime
    assert abs(got - 1_700_000_000) <= 2  # zip 시각 해상도 2초


def test_name_collision_gets_numeric_suffix(pcs):
    dest, _ = export_from_a(pcs)
    pcs["use"](pcs["b"])
    Vault.create("alpha", pcs["b"] / "alpha")
    Vault.create("alpha-2", pcs["b"] / "alpha-2")
    (pcs["b"] / "alpha" / "content" / "mine.md").write_text("내 것", encoding="utf-8")

    report = backup.import_archive(dest, build=False)
    item = report.items[0]
    assert (item.imported_as, item.renamed) == ("alpha-3", True)
    assert (pcs["b"] / "alpha" / "content" / "mine.md").read_text(encoding="utf-8") == "내 것"
    assert not (pcs["b"] / "alpha" / "content" / "hello.md").exists()
    assert registry().get("alpha-3").path == (pcs["b"] / "alpha-3").resolve()


def test_vault_json_path_rewritten_and_workspace_reset(pcs):
    ws = pcs["tmp"] / "workspace"
    ws.mkdir()
    dest, _ = export_from_a(pcs, workspace_path=str(ws))
    pcs["use"](pcs["b"])
    report = backup.import_archive(dest, build=False)

    data = json.loads((pcs["b"] / "alpha" / ".vault.json").read_text(encoding="utf-8"))
    assert data["path"] == str((pcs["b"] / "alpha").resolve())
    assert "workspace_path" not in data
    assert registry().get("alpha").workspace_path == ""
    flags = {i.original: i.workspace_reset for i in report.items}
    assert flags == {"alpha": True, "beta": False}


def test_default_set_only_when_target_registry_empty(pcs):
    dest, _ = export_from_a(pcs)
    pcs["use"](pcs["b"])
    report = backup.import_archive(dest, build=False)
    assert report.default_set == "alpha"
    assert registry().default().name == "alpha"


def test_default_kept_when_target_already_has_vaults(pcs):
    dest, _ = export_from_a(pcs)
    pcs["use"](pcs["b"])
    Vault.create("mine", pcs["b"] / "mine")
    report = backup.import_archive(dest, build=False)
    assert report.default_set is None
    assert registry().default().name == "mine"


def test_import_builds_index(pcs):
    dest, _ = export_from_a(pcs)
    pcs["use"](pcs["b"])
    report = backup.import_archive(dest)
    assert all(not i.build_failed for i in report.items)
    assert (pcs["b"] / "alpha" / "wiki.db").is_file()


# ─── import 거부 (아무것도 풀지 않아야 한다) ───────────────────


def write_zip(path: Path, entries: dict, manifest: dict | None | str = "default") -> Path:
    if manifest == "default":
        manifest = {
            "format": "raven-backup", "format_version": 1, "default": None,
            "vaults": [{"name": "alpha", "dir": "vaults/alpha", "meta": {}, "had_workspace": False}],
        }
    with zipfile.ZipFile(path, "w") as zf:
        if manifest is not None:
            zf.writestr("manifest.json", json.dumps(manifest))
        for name, data in entries.items():
            if isinstance(data, zipfile.ZipInfo):
                zf.writestr(data, b"target")
            else:
                zf.writestr(name, data)
    return path


def symlink_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name)
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    return info


@pytest.mark.parametrize("entries, manifest", [
    ({"vaults/alpha/../evil.md": b"x"}, "default"),
    ({"/abs.md": b"x"}, "default"),
    ({"vaults/alpha/content/l.md": symlink_info("vaults/alpha/content/l.md")}, "default"),
    ({"other/x.md": b"x"}, "default"),
    ({"vaults/alpha/content/a.md": b"x"}, None),
    ({}, {"format": "raven-backup", "format_version": 99, "vaults": []}),
    ({}, {"format": "something-else", "format_version": 1, "vaults": []}),
    ({}, {"format": "raven-backup", "format_version": 1,
          "vaults": [{"name": "../x", "dir": "vaults/../x", "meta": {}}]}),
    ({"vaults/alpha//abs.md": b"x"}, "default"),
    ({"vaults/alpha/./a.md": b"x"}, "default"),
    ({"vaults/alphaX/a.md": b"x"}, "default"),
    ({}, {"format": "raven-backup", "format_version": 1, "vaults": [
        {"name": "alpha", "dir": "vaults/alpha", "meta": {}},
        {"name": "alpha", "dir": "vaults/alpha", "meta": {}},
    ]}),
    ({}, {"format": "raven-backup", "format_version": 1,
          "vaults": [{"name": "a\x01b", "dir": "vaults/a\x01b", "meta": {}}]}),
], ids=["dotdot", "absolute", "symlink", "outside-dirs", "no-manifest",
        "newer-version", "wrong-format", "bad-name", "empty-segment", "dot-segment",
        "prefix-trick", "duplicate-name", "control-char"])
def test_rejects_bad_archives_without_touching_anything(pcs, entries, manifest):
    bad = write_zip(pcs["tmp"] / "bad.zip", entries, manifest)
    pcs["use"](pcs["b"])
    with pytest.raises(backup.BackupError):
        backup.import_archive(bad, build=False)
    assert list(pcs["b"].iterdir()) == []


def test_rejects_archive_over_size_limit(pcs):
    bad = write_zip(pcs["tmp"] / "big.zip", {"vaults/alpha/content/a.md": b"x" * 100})
    pcs["use"](pcs["b"])
    with pytest.raises(backup.BackupError):
        backup.import_archive(bad, build=False, max_bytes=10)
    assert list(pcs["b"].iterdir()) == []


def test_rejects_non_zip_file(pcs):
    junk = pcs["tmp"] / "junk.zip"
    junk.write_bytes(b"not a zip")
    with pytest.raises(backup.BackupError):
        backup.import_archive(junk, build=False)


# ─── vault별 실패 격리 / 내보내기 경계 ─────────────────────────


TWO_VAULTS = {
    "format": "raven-backup", "format_version": 1, "default": None,
    "vaults": [
        {"name": "alpha", "dir": "vaults/alpha", "meta": {}, "had_workspace": False},
        {"name": "beta", "dir": "vaults/beta", "meta": {}, "had_workspace": False},
    ],
}


def test_bad_meta_fails_only_that_vault(pcs):
    manifest = json.loads(json.dumps(TWO_VAULTS))
    manifest["vaults"][0]["meta"] = {"features": [1]}
    src = write_zip(pcs["tmp"] / "m.zip", {
        "vaults/alpha/content/a.md": b"a", "vaults/beta/content/b.md": b"b",
    }, manifest)
    pcs["use"](pcs["b"])
    report = backup.import_archive(src, build=False)
    a, b = report.items
    assert a.error and a.imported_as is None
    assert not (pcs["b"] / "alpha").exists()
    assert registry().get("alpha") is None
    assert b.error is None and (pcs["b"] / "beta" / "content" / "b.md").read_bytes() == b"b"
    assert not list(pcs["b"].glob(".import-*"))


def test_corrupted_entry_fails_only_that_vault(pcs):
    src = pcs["tmp"] / "crc.zip"
    payload = b"A" * 64
    with zipfile.ZipFile(src, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("manifest.json", json.dumps(TWO_VAULTS))
        zf.writestr("vaults/alpha/content/a.md", payload)
        zf.writestr("vaults/beta/content/b.md", b"b")
    raw = src.read_bytes()
    assert raw.count(payload) == 1
    src.write_bytes(raw.replace(payload, b"B" * 64))
    pcs["use"](pcs["b"])
    report = backup.import_archive(src, build=False)
    a, b = report.items
    assert a.error and not (pcs["b"] / "alpha").exists()
    assert b.error is None and (pcs["b"] / "beta" / "content" / "b.md").read_bytes() == b"b"
    assert not list(pcs["b"].glob(".import-*"))


def test_export_handles_files_dated_before_1980(pcs):
    v = make_vault(pcs["a"], "alpha")
    os.utime(v.root / "content" / "hello.md", (0, 0))
    report = backup.export_all(pcs["tmp"] / "b.zip")
    with zipfile.ZipFile(report.path) as zf:
        assert "vaults/alpha/content/hello.md" in zf.namelist()


def test_export_refuses_dest_inside_exported_vault(pcs):
    v = make_vault(pcs["a"], "alpha")
    dest = v.root / "b.zip"
    with pytest.raises(backup.BackupError):
        backup.export_all(dest)
    assert not dest.exists() and not dest.with_name("b.zip.tmp").exists()

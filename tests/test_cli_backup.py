"""raven vault export / import-backup CLI 스모크."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

from typer.testing import CliRunner

from raven.cli.__main__ import app
from raven.core.registry import registry
from raven.core.vault import Vault

runner = CliRunner()


def test_export_then_import_backup_on_another_root(tmp_path, monkeypatch):
    a, b = tmp_path / "a", tmp_path / "b"
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(a))
    v = Vault.create("alpha", a / "alpha")
    (v.root / "content" / "hello.md").write_text("# Hello\n", encoding="utf-8")
    out = tmp_path / "backup.zip"

    res = runner.invoke(app, ["vault", "export", "-o", str(out)])
    assert res.exit_code == 0, res.output
    assert "alpha: 파일" in res.output and out.is_file()

    monkeypatch.setenv("WIKI_VAULTS_DIR", str(b))
    Vault.create("alpha", b / "alpha")
    res = runner.invoke(app, ["vault", "import-backup", str(out)])
    assert res.exit_code == 0, res.output
    assert "alpha → alpha-2" in res.output
    assert "같은 이름이 있어 이름을 바꿈" in res.output
    assert registry().get("alpha-2") is not None


def test_import_backup_rejects_non_backup(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "v"))
    junk = tmp_path / "junk.zip"
    junk.write_bytes(b"nope")
    res = runner.invoke(app, ["vault", "import-backup", str(junk)])
    assert res.exit_code == 1


def test_export_oserror_exits_1(tmp_path, monkeypatch):
    """-o가 가리키는 부모 폴더를 만들 수 없을 때 — BackupError가 아닌 OSError도 잡아서
    깔끔히 exit 1 해야 한다 (export_all의 dest.parent.mkdir에서 난다).

    일반 파일을 디렉터리인 것처럼 부모 경로에 두면 mkdir이 NotADirectoryError(OSError)를
    내므로 root 권한과 무관하게 재현된다 (CI가 root로 돌면 `/` 밑에 디렉터리를 만들 수
    있어 예전의 `/nonexistent-raven-test-dir/...` 방식은 통과해버릴 수 있었다)."""
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "v"))
    Vault.create("alpha", tmp_path / "v" / "alpha")
    blocker = tmp_path / "blocker"
    blocker.write_text("x")
    bad = blocker / "sub" / "x.zip"
    res = runner.invoke(app, ["vault", "export", "-o", str(bad)])
    assert res.exit_code == 1
    assert "❌" in res.output


def test_import_backup_item_error_exits_1(tmp_path, monkeypatch):
    """manifest의 meta.features가 dict가 아니면 VaultMeta.from_json이 깨져
    해당 vault만 item.error로 남는다 — CLI는 그걸 보고 exit 1 해야 한다."""
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "a"))
    Vault.create("alpha", tmp_path / "a" / "alpha")
    out = tmp_path / "backup.zip"
    res = runner.invoke(app, ["vault", "export", "-o", str(out)])
    assert res.exit_code == 0, res.output

    with zipfile.ZipFile(out) as zf:
        manifest = json.loads(zf.read("manifest.json"))
        contents = {n: zf.read(n) for n in zf.namelist() if n != "manifest.json"}
    manifest["vaults"][0]["meta"]["features"] = "broken"  # dict가 아님 → .items()에서 터짐
    corrupted = tmp_path / "corrupted.zip"
    with zipfile.ZipFile(corrupted, "w") as zf:
        for n, data in contents.items():
            zf.writestr(n, data)
        zf.writestr("manifest.json", json.dumps(manifest))

    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "b"))
    res = runner.invoke(app, ["vault", "import-backup", str(corrupted)])
    assert res.exit_code == 1
    assert "❌ alpha:" in res.output

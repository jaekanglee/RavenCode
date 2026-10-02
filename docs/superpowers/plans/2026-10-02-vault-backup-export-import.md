# 전체 vault 백업 내보내기·가져오기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 등록된 모든 vault를 zip 하나로 내보내고, 다른 PC의 Raven에서 그 zip을 가져와 그대로 복원한다. CLI·API·데스크톱 관리 화면에서 모두 쓸 수 있다.

**Architecture:** 로직은 `raven/core/backup.py` 한 곳에 둔다(`export_all`, `import_archive`). CLI(`raven vault export` / `import-backup`)와 API(`POST /api/backup/export|import`, loopback 전용, 경로를 받음)는 이 함수를 감싸기만 한다. 데스크톱은 `tauri-plugin-dialog`로 경로를 고르고 API에 넘긴다.

**Tech Stack:** Python 표준 라이브러리 `zipfile`, FastAPI, Typer, React + vitest, Tauri 2 + `tauri-plugin-dialog`(새 의존성, 2026-10-02 사용자 승인: B안).

**Spec:** `docs/superpowers/specs/2026-10-02-vault-backup-export-import-design.md`

**규약:** AGENTS.md §6에 따라 **commit은 사용자 승인 후**에만 한다. 마지막 task에서 한 번에 확인받는다. Python은 `scripts/.venv/bin/python -m pytest`로 실행한다(저장소 루트 기준).

---

## 파일 구조

| 파일 | 역할 |
|---|---|
| Create `raven/core/backup.py` | 백업 형식, 내보내기, 검증, 가져오기 |
| Modify `raven/cli/__main__.py` | `vault export`, `vault import-backup` (`vault import` 별칭 바로 아래) |
| Modify `raven/api/server.py` | `POST /api/backup/export`, `POST /api/backup/import` (clone 엔드포인트 바로 아래) |
| Modify `desktop/src-tauri/Cargo.toml`, `src/lib.rs`, `capabilities/default.json` | dialog 플러그인 + 권한 + 회귀 테스트 |
| Modify `dashboard/package.json` | `@tauri-apps/plugin-dialog` |
| Create `dashboard/src/lib/backup.ts` | 대화상자 → API 호출 |
| Create `dashboard/src/components/BackupPanel.tsx` | 관리 화면 백업 섹션 |
| Modify `dashboard/src/routes/VaultManage.tsx` | 데스크톱일 때만 BackupPanel 렌더 |
| Modify `README.md` | 엔드포인트 수(68→70), API·CLI 목록 |
| Test `tests/test_backup.py`, `tests/test_api_backup.py`, `tests/test_cli_backup.py`, `dashboard/tests/BackupPanel.test.tsx` | |

---

### Task 1: core — 내보내기

**Files:**
- Create: `raven/core/backup.py`
- Test: `tests/test_backup.py`

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/test_backup.py`

```python
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
```

`file_count` 7의 내역: `content/hello.md`, `raw/src.txt`, `log.md`, `_archive/old.md`, `mystery/x.bin`, `.graph_positions.json`, `.vault.json`. `Vault.create`가 만든 `.vault.json`도 파일이므로 포함된다.

- [ ] **Step 2: 실패 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_backup.py -q`
Expected: FAIL (`ImportError: cannot import name 'backup'`)

- [ ] **Step 3: 구현** — `raven/core/backup.py`

```python
"""전체 vault 백업 내보내기·가져오기 — zip 한 파일로 다른 PC에 vault를 그대로 옮긴다.

다시 만들 수 있거나 기기에 묶인 것(wiki.db, .mcp/ 런타임 락, .DS_Store)만 빼고
vault 폴더를 통째로 담는다 (화이트리스트가 아니라 블랙리스트 — 모르는 폴더도 따라간다).
레지스트리 메타는 manifest.json에 넣되, PC마다 다른 path / workspace_path는 뺀다.
MCP 토큰(<VAULTS_ROOT>/.mcp-tokens.json)은 vault 밖 기기 설정이라 담지 않는다.

spec: docs/superpowers/specs/2026-10-02-vault-backup-export-import-design.md
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import time
import uuid
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Optional

from raven.core.registry import VAULTS_ROOT, VaultMeta, registry
from raven.core.vault import Vault

FORMAT = "raven-backup"
FORMAT_VERSION = 1
MANIFEST = "manifest.json"
# vault 루트에서만 빼는 것 — 색인 DB(가져온 뒤 재빌드)와 런타임 락 디렉터리.
ROOT_EXCLUDE_FILES = frozenset({"wiki.db", "wiki.db-journal", "wiki.db-wal", "wiki.db-shm"})
ROOT_EXCLUDE_DIRS = frozenset({".mcp"})
# 어디서든 빼는 것.
ANYWHERE_EXCLUDE_FILES = frozenset({".DS_Store"})
MAX_UNCOMPRESSED_BYTES = 5 * 1024**3  # zip bomb 방지


class BackupError(ValueError):
    """백업 파일 자체가 잘못됐거나 요청이 잘못됨 — 아무것도 바꾸지 않은 상태."""


@dataclass
class ExportReport:
    path: Path
    vaults: list[dict] = field(default_factory=list)          # {"name", "file_count"}
    skipped: list[dict] = field(default_factory=list)         # {"name", "reason"}
    skipped_files: list[str] = field(default_factory=list)    # "<vault>/<rel>" (symlink)

    def to_json(self) -> dict:
        return {
            "path": str(self.path),
            "vaults": self.vaults,
            "skipped": self.skipped,
            "skipped_files": self.skipped_files,
        }


def default_filename(now: Optional[datetime] = None) -> str:
    return (now or datetime.now()).strftime("raven-backup-%Y%m%d-%H%M.zip")


def _portable_meta(meta: VaultMeta) -> dict:
    data = meta.to_json()
    data.pop("path", None)
    data.pop("workspace_path", None)
    return data


def _write_vault_tree(zf: zipfile.ZipFile, root: Path, prefix: str, name: str, skipped_files: list[str]) -> int:
    """vault 폴더를 zip에 쓴다. 빈 폴더도 디렉터리 항목으로 남긴다. 파일 수를 반환."""
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):  # followlinks=False
        here = Path(dirpath)
        at_root = here == root
        kept = []
        for dn in sorted(dirnames):
            p = here / dn
            rel = p.relative_to(root).as_posix()
            if p.is_symlink():
                skipped_files.append(f"{name}/{rel}")
                continue
            if at_root and dn in ROOT_EXCLUDE_DIRS:
                continue
            kept.append(dn)
            zf.write(p, f"{prefix}/{rel}/")
        dirnames[:] = kept
        for fn in sorted(filenames):
            p = here / fn
            rel = p.relative_to(root).as_posix()
            if fn in ANYWHERE_EXCLUDE_FILES or (at_root and fn in ROOT_EXCLUDE_FILES):
                continue
            if p.is_symlink():
                skipped_files.append(f"{name}/{rel}")
                continue
            zf.write(p, f"{prefix}/{rel}")
            count += 1
    return count


def export_all(dest: Path, *, names: Optional[list[str]] = None) -> ExportReport:
    """등록된 vault(기본 전체, names로 좁힘)를 dest(.zip) 하나로 묶는다.

    폴더가 사라진 vault는 건너뛰고 report.skipped에 남긴다. .zip.tmp에 쓴 뒤
    os.replace하므로 중간에 실패해도 반쯤 쓴 백업이 dest에 남지 않는다.
    """
    from raven import __version__

    dest = Path(dest).expanduser()
    if dest.suffix.lower() != ".zip":
        raise BackupError(f"백업 파일은 .zip이어야 합니다: {dest.name}")
    reg = registry()
    metas = reg.list()
    if names is not None:
        unknown = set(names) - {m.name for m in metas}
        if unknown:
            raise BackupError(f"등록되지 않은 vault: {', '.join(sorted(unknown))}")
        metas = [m for m in metas if m.name in set(names)]

    report = ExportReport(path=dest)
    entries: list[dict] = []
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".tmp")
    try:
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for meta in metas:
                try:
                    vault = Vault.load(meta)
                except FileNotFoundError as e:
                    report.skipped.append({"name": meta.name, "reason": str(e)})
                    continue
                prefix = f"vaults/{meta.name}"
                count = _write_vault_tree(zf, vault.root, prefix, meta.name, report.skipped_files)
                entries.append({
                    "name": meta.name,
                    "dir": prefix,
                    "meta": _portable_meta(meta),
                    "had_workspace": bool(meta.workspace_path),
                    "file_count": count,
                })
                report.vaults.append({"name": meta.name, "file_count": count})
            default = reg.default()
            exported = {e["name"] for e in entries}
            zf.writestr(MANIFEST, json.dumps({
                "format": FORMAT,
                "format_version": FORMAT_VERSION,
                "raven_version": __version__,
                "created": datetime.now().astimezone().isoformat(timespec="seconds"),
                "default": default.name if default and default.name in exported else None,
                "vaults": entries,
            }, ensure_ascii=False, indent=2))
        os.replace(tmp, dest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return report
```

- [ ] **Step 4: 통과 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_backup.py -q`
Expected: PASS (6 tests)

---

### Task 2: core — 검증과 가져오기

**Files:**
- Modify: `raven/core/backup.py` (append)
- Test: `tests/test_backup.py` (append)

- [ ] **Step 1: 실패하는 테스트 추가** — `tests/test_backup.py` 끝에

```python
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
], ids=["dotdot", "absolute", "symlink", "outside-dirs", "no-manifest",
        "newer-version", "wrong-format", "bad-name"])
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
```

- [ ] **Step 2: 실패 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_backup.py -q`
Expected: 새 테스트들이 FAIL (`AttributeError: module 'raven.core.backup' has no attribute 'import_archive'`)

- [ ] **Step 3: 구현** — `raven/core/backup.py` 끝에 append

```python
# ─────────────────────────── import ───────────────────────────


@dataclass
class ImportItem:
    original: str
    imported_as: Optional[str] = None
    renamed: bool = False
    workspace_reset: bool = False
    build_failed: bool = False
    error: Optional[str] = None


@dataclass
class ImportReport:
    items: list[ImportItem] = field(default_factory=list)
    default_set: Optional[str] = None

    def to_json(self) -> dict:
        return {"items": [asdict(i) for i in self.items], "default_set": self.default_set}


def _safe_vault_name(name: object) -> bool:
    return (
        isinstance(name, str)
        and bool(name)
        and not name.startswith(".")
        and "/" not in name
        and "\\" not in name
    )


def _read_manifest(zf: zipfile.ZipFile) -> dict:
    try:
        raw = zf.read(MANIFEST)
    except KeyError:
        raise BackupError("manifest.json이 없습니다 — Raven 백업 파일이 아닙니다")
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as e:
        raise BackupError(f"manifest.json을 읽을 수 없습니다: {e}")
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise BackupError("Raven 백업 파일이 아닙니다")
    version = manifest.get("format_version")
    if not isinstance(version, int) or version > FORMAT_VERSION:
        raise BackupError(f"지원하지 않는 백업 형식 버전입니다: {version} (이 Raven은 {FORMAT_VERSION}까지)")
    vaults = manifest.get("vaults")
    if not isinstance(vaults, list) or not vaults:
        raise BackupError("백업에 vault가 없습니다")
    for entry in vaults:
        name = entry.get("name") if isinstance(entry, dict) else None
        if (
            not _safe_vault_name(name)
            or entry.get("dir") != f"vaults/{name}"
            or not isinstance(entry.get("meta"), dict)
        ):
            raise BackupError(f"manifest의 vault 항목이 잘못됐습니다: {entry!r}")
    return manifest


def _validate_entries(zf: zipfile.ZipFile, manifest: dict, max_bytes: int) -> None:
    """풀기 전에 전체 항목 검사 — 하나라도 걸리면 아무것도 풀지 않는다 (zip-slip/symlink/bomb)."""
    prefixes = tuple(e["dir"] + "/" for e in manifest["vaults"])
    total = 0
    for info in zf.infolist():
        name = info.filename
        if name == MANIFEST:
            continue
        parts = PurePosixPath(name).parts
        if name.startswith("/") or "\\" in name or ".." in parts or (parts and ":" in parts[0]):
            raise BackupError(f"안전하지 않은 경로가 있습니다: {name}")
        if stat.S_ISLNK(info.external_attr >> 16):
            raise BackupError(f"symlink 항목은 가져오지 않습니다: {name}")
        if not name.startswith(prefixes):
            raise BackupError(f"manifest에 없는 항목입니다: {name}")
        total += info.file_size
        if total > max_bytes:
            raise BackupError(f"압축을 풀면 {max_bytes:,} 바이트를 넘습니다")


def _free_name(name: str, root: Path) -> str:
    taken = {m.name for m in registry().list()}
    candidate, n = name, 2
    while candidate in taken or (root / candidate).exists():
        candidate = f"{name}-{n}"
        n += 1
    return candidate


def _extract_vault(zf: zipfile.ZipFile, prefix: str, staging: Path) -> None:
    staging.mkdir()
    pre = prefix + "/"
    for info in zf.infolist():
        if not info.filename.startswith(pre):
            continue
        rel = info.filename[len(pre):]
        if not rel:
            continue
        out = staging / rel
        if info.is_dir():
            out.mkdir(parents=True, exist_ok=True)
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, open(out, "wb") as dst:
            shutil.copyfileobj(src, dst)
        ts = time.mktime(info.date_time + (0, 0, -1))
        os.utime(out, (ts, ts))


def _rewrite_vault_json(root: Path, meta: VaultMeta) -> None:
    """.vault.json의 path를 새 위치로, workspace_path는 제거. 모르는 키는 보존."""
    vjson = root / ".vault.json"
    data: dict = {}
    if vjson.exists():
        try:
            data = json.loads(vjson.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
    data.pop("workspace_path", None)
    data.update(meta.to_json())
    vjson.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def import_archive(
    src: Path,
    *,
    build: bool = True,
    max_bytes: int = MAX_UNCOMPRESSED_BYTES,
) -> ImportReport:
    """백업 zip의 vault를 모두 VAULTS_ROOT 아래로 가져와 등록한다.

    같은 이름이 있으면 name-2, name-3… 기존 vault는 건드리지 않는다.
    vault마다 VAULTS_ROOT/.import-<uuid>/에 푼 뒤 rename → 실패해도 반쯤 풀린 vault 없음.
    한 vault 실패는 그 vault만 error로 남기고 계속한다. 색인 빌드 실패는 build_failed.
    """
    from raven.core.db import build_db

    try:
        zf = zipfile.ZipFile(Path(src).expanduser())
    except (OSError, zipfile.BadZipFile) as e:
        raise BackupError(f"백업 파일을 열 수 없습니다: {e}")
    with zf:
        manifest = _read_manifest(zf)
        _validate_entries(zf, manifest, max_bytes)

        root = VAULTS_ROOT()
        root.mkdir(parents=True, exist_ok=True)
        target_was_empty = not registry().list()
        report = ImportReport()
        imported: dict[str, str] = {}

        for entry in manifest["vaults"]:
            item = ImportItem(original=entry["name"])
            report.items.append(item)
            new_name = _free_name(entry["name"], root)
            staging = root / f".import-{uuid.uuid4().hex}"
            target = root / new_name
            try:
                _extract_vault(zf, entry["dir"], staging)
                os.rename(staging, target)
            except OSError as e:
                shutil.rmtree(staging, ignore_errors=True)
                item.error = str(e)
                continue

            meta = VaultMeta.from_json(new_name, {**entry["meta"], "path": str(target)})
            _rewrite_vault_json(target, meta)
            registry().add(meta)
            item.imported_as = new_name
            item.renamed = new_name != entry["name"]
            item.workspace_reset = bool(entry.get("had_workspace"))
            imported[entry["name"]] = new_name

            if build:
                try:
                    build_db(Vault.load(meta), run_lint=False)
                except Exception:
                    item.build_failed = True

        wanted_default = imported.get(manifest.get("default") or "")
        if target_was_empty and wanted_default:
            registry().set_default(wanted_default)
            report.default_set = wanted_default
    return report
```

- [ ] **Step 4: 통과 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_backup.py -q`
Expected: PASS (6 + 17 = 23 tests)

`test_rejects_*`가 `pcs["b"]`에 무언가 남아 실패하면 `root.mkdir`이 검증보다 앞에 있는지 확인한다. 검증이 먼저 와야 한다.

---

### Task 3: CLI — `vault export`, `vault import-backup`

**Files:**
- Modify: `raven/cli/__main__.py` (`vault_import_alias` 함수 바로 아래, `@vault_app.command("repair")` 위)
- Test: `tests/test_cli_backup.py`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
"""raven vault export / import-backup CLI 스모크."""
from __future__ import annotations

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
```

- [ ] **Step 2: 실패 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_cli_backup.py -q`
Expected: FAIL (`No such command 'export'`)

- [ ] **Step 3: 구현**

```python
@vault_app.command("export")
def vault_export(
    output: Optional[str] = typer.Option(
        None, "-o", "--output", help="저장할 .zip 경로 (기본: ./raven-backup-YYYYMMDD-HHMM.zip)"
    ),
    vaults: Optional[list[str]] = typer.Option(
        None, "--vault", help="이 vault만 담는다 (여러 번 지정 가능, 기본: 전체)"
    ),
) -> None:
    """등록된 모든 vault를 zip 한 파일로 백업한다 (다른 PC에서 `vault import-backup`으로 복원).

    wiki.db·.mcp/ 락·.DS_Store만 빼고 vault 폴더를 그대로 담는다.
    """
    from raven.core import backup as backup_module

    dest = Path(output).expanduser() if output else Path.cwd() / backup_module.default_filename()
    try:
        report = backup_module.export_all(dest.resolve(), names=vaults or None)
    except backup_module.BackupError as e:
        typer.echo(f"❌ {e}", err=True)
        raise typer.Exit(1)
    typer.echo(f"✅ 백업: {report.path}")
    for v in report.vaults:
        typer.echo(f"   {v['name']}: 파일 {v['file_count']}개")
    for s in report.skipped:
        typer.echo(f"   ⚠️  건너뜀 {s['name']}: {s['reason']}")
    for f in report.skipped_files:
        typer.echo(f"   ⚠️  symlink 제외: {f}")


@vault_app.command("import-backup")
def vault_import_backup(
    file: str = typer.Argument(..., help="`raven vault export`로 만든 .zip"),
) -> None:
    """백업 zip의 vault를 모두 가져와 등록한다.

    같은 이름이 있으면 name-2처럼 새 이름으로 가져오고, 기존 vault는 건드리지 않는다.
    workspace 경로는 PC마다 달라 비워 두므로 필요하면 `raven vault workspace`로 다시 잇는다.
    """
    from raven.core import backup as backup_module

    try:
        report = backup_module.import_archive(Path(file).expanduser().resolve())
    except backup_module.BackupError as e:
        typer.echo(f"❌ {e}", err=True)
        raise typer.Exit(1)
    failed = False
    for it in report.items:
        if it.error:
            failed = True
            typer.echo(f"   ❌ {it.original}: {it.error}")
            continue
        notes = []
        if it.renamed:
            notes.append("같은 이름이 있어 이름을 바꿈")
        if it.workspace_reset:
            notes.append(f"workspace 다시 연결 필요: raven vault workspace {it.imported_as} <경로>")
        if it.build_failed:
            notes.append(f"색인 빌드 실패: raven build --vault {it.imported_as}")
        suffix = f"  ({'; '.join(notes)})" if notes else ""
        typer.echo(f"   {it.original} → {it.imported_as}{suffix}")
    if report.default_set:
        typer.echo(f"   기본 vault: {report.default_set}")
    if failed:
        raise typer.Exit(1)
```

- [ ] **Step 4: 통과 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_cli_backup.py tests/test_cli.py -q`
Expected: PASS. `test_v0_7_178_doc_count_guards.py::test_readme_cli_group_count_matches_source`는 그룹 수를 세므로 영향이 없다(하위 명령만 늘어남).

`Optional[list[str]]`를 Typer가 거부하면(`from __future__ import annotations` 환경) `Optional[List[str]]`(`from typing import List`)로 바꾼다.

---

### Task 4: API — `POST /api/backup/export`, `POST /api/backup/import`

**Files:**
- Modify: `raven/api/server.py` (`clone_vault` 함수 바로 아래, `# ── archive endpoints ──` 주석 위)
- Modify: `README.md` (엔드포인트 수, 목록)
- Test: `tests/test_api_backup.py`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
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


def test_non_loopback_is_forbidden(tmp_path):
    for path, body in (
        ("/api/backup/export", {"dest_path": str(tmp_path / "x.zip")}),
        ("/api/backup/import", {"src_path": str(tmp_path / "x.zip")}),
    ):
        assert remote.post(path, json=body).status_code == 403
        assert TestClient(app).post(path, json=body).status_code == 403  # host "testclient"


def test_relative_path_and_bad_zip_are_400(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "a"))
    assert local.post("/api/backup/export", json={"dest_path": "rel.zip"}).status_code == 400
    junk = tmp_path / "junk.zip"
    junk.write_bytes(b"nope")
    res = local.post("/api/backup/import", json={"src_path": str(junk)})
    assert res.status_code == 400
    assert "열 수 없습니다" in res.json()["detail"]
```

- [ ] **Step 2: 실패 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_api_backup.py -q`
Expected: FAIL (404/405)

- [ ] **Step 3: 구현**

`server.py` 상단 import를 고친다. 20행을 다음으로 바꾸고,

```python
from fastapi import FastAPI, HTTPException, Query, Header, Response, Request
```

14행 `import json` 아래에 `import ipaddress`를 추가한다. 31행 `from raven.core.vault import Vault` 아래에 다음을 추가한다.

```python
from raven.core import backup as backup_module
```

`clone_vault` 아래에 추가한다.

```python
# ────────────────────────── backup endpoints ──────────────────────────


class BackupExportRequest(BaseModel):
    dest_path: str = Field(..., description="저장할 .zip 절대경로 (이 PC 기준)")
    vaults: Optional[list[str]] = Field(None, description="이 vault만 (기본: 전체)")


class BackupImportRequest(BaseModel):
    src_path: str = Field(..., description="가져올 백업 .zip 절대경로 (이 PC 기준)")


def _require_loopback(request: Request) -> None:
    """경로를 받는 API는 같은 PC(loopback)에서만. API가 0.0.0.0에 바인딩돼 있어
    내부망/tailnet 기기가 서버 PC의 임의 경로에 쓰거나 읽게 두면 안 된다.
    X-Forwarded-For는 보지 않는다 (request.client = 실제 소켓 상대)."""
    host = request.client.host if request.client else ""
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        addr = None
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    if addr is None or not addr.is_loopback:
        raise HTTPException(status_code=403, detail="백업 내보내기·가져오기는 이 PC에서만 할 수 있습니다")


def _require_absolute(raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise HTTPException(status_code=400, detail=f"절대경로가 필요합니다: {raw}")
    return path


@app.post("/api/backup/export")
def backup_export(payload: BackupExportRequest, request: Request):
    """등록된 vault 전체(또는 vaults)를 dest_path(.zip)에 백업한다. loopback 전용."""
    _require_loopback(request)
    dest = _require_absolute(payload.dest_path)
    try:
        report = backup_module.export_all(dest, names=payload.vaults)
    except backup_module.BackupError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, **report.to_json()}


@app.post("/api/backup/import")
def backup_import(payload: BackupImportRequest, request: Request):
    """src_path 백업의 vault를 모두 가져와 등록한다 (이름 충돌 시 name-2…). loopback 전용."""
    _require_loopback(request)
    src = _require_absolute(payload.src_path)
    try:
        report = backup_module.import_archive(src)
    except backup_module.BackupError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, **report.to_json()}
```

- [ ] **Step 4: README 갱신**
  - 25행 `FastAPI 68 endpoints`를 `FastAPI 70 endpoints`로, 251행 `## HTTP API (68 endpoints)`를 `## HTTP API (70 endpoints)`로 바꾼다.
  - 251행 블록의 `# vault 관리` 목록 끝(`POST   /api/vaults/{name}/select` 아래)에 다음을 추가한다.

```
POST   /api/backup/export                        # body: {dest_path, vaults?} — 전체 vault zip 백업 (loopback 전용)
POST   /api/backup/import                        # body: {src_path} — 백업 가져오기, 이름 충돌 시 name-2 (loopback 전용)
```

  - 211행 `raven vault remove …` 아래에 다음을 추가한다.

```
raven vault export [-o FILE] [--vault N]    # 모든 vault를 zip 한 파일로 백업
raven vault import-backup <FILE>            # 백업 가져오기 (다른 PC 복원, 이름 충돌 시 name-2)
```

- [ ] **Step 5: 통과 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_api_backup.py tests/test_v0_7_178_doc_count_guards.py tests/test_api.py -q`
Expected: PASS

---

### Task 5: Tauri — dialog 플러그인과 권한

**Files:**
- Modify: `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/capabilities/default.json`
- Modify: `dashboard/package.json` (npm 설치)

- [ ] **Step 1: 실패하는 Rust 테스트 추가** — `lib.rs`의 `mod tests` 안 마지막에

```rust
    #[test]
    fn default_capability_allows_backup_dialogs() {
        // 백업 내보내기/가져오기 대화상자. 권한이 빠지면 invoke가 조용히 거부된다
        // (f2a70b0 app_version 권한 누락과 같은 유형).
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let perms: Vec<&str> = caps["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        for p in ["dialog:allow-open", "dialog:allow-save"] {
            assert!(perms.contains(&p), "{p} 권한 누락");
        }
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cd desktop/src-tauri && cargo test default_capability_allows_backup_dialogs`
Expected: FAIL (`dialog:allow-open 권한 누락`)

- [ ] **Step 3: 구현**
  - `Cargo.toml` `[dependencies]`의 `tauri-plugin-process = "2"` 아래에 `tauri-plugin-dialog = "2"`를 추가한다.
  - `lib.rs` `run()`의 `.plugin(tauri_plugin_process::init())` 아래에 `.plugin(tauri_plugin_dialog::init())`를 추가한다.
  - `capabilities/default.json`의 `permissions` 배열 끝(`"process:allow-restart"` 뒤)에 `"dialog:allow-open"`과 `"dialog:allow-save"`를 추가한다.
  - `cd dashboard && npm install @tauri-apps/plugin-dialog@^2`

- [ ] **Step 4: 통과 확인**

Run: `cd desktop/src-tauri && cargo test`
Expected: 모든 테스트 PASS. `gen/schemas`는 git에서 추적하지 않으므로 commit 대상이 아니다.

---

### Task 6: 대시보드 — `backup.ts`, `BackupPanel`, VaultManage 연결

**Files:**
- Create: `dashboard/src/lib/backup.ts`, `dashboard/src/components/BackupPanel.tsx`
- Modify: `dashboard/src/routes/VaultManage.tsx`
- Test: `dashboard/tests/BackupPanel.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackupPanel } from "../src/components/BackupPanel";
import { backupFilename, type DialogApi } from "../src/lib/backup";

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function fakeDialog(over: Partial<DialogApi> = {}): DialogApi {
  return { save: vi.fn().mockResolvedValue(null), open: vi.fn().mockResolvedValue(null), ...over };
}

afterEach(() => vi.unstubAllGlobals());

describe("backupFilename", () => {
  it("raven-backup-YYYYMMDD-HHMM.zip", () => {
    expect(backupFilename(new Date(2026, 9, 2, 14, 5))).toBe("raven-backup-20261002-1405.zip");
  });
});

describe("BackupPanel", () => {
  it("내보내기: 고른 경로로 API를 부르고 결과 경로를 보여준다", async () => {
    const fetchSpy = stubFetch(200, { ok: true, path: "/Users/me/b.zip", vaults: [{ name: "a", file_count: 3 }], skipped: [], skipped_files: [] });
    const dialog = fakeDialog({ save: vi.fn().mockResolvedValue("/Users/me/b.zip") });
    render(<BackupPanel dialog={dialog} onImported={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "전체 백업 내보내기" }));
    await screen.findByText(/vault 1개를 백업했습니다/);
    expect(screen.getByText(/\/Users\/me\/b\.zip/)).toBeTruthy();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("/api/backup/export");
    expect(JSON.parse(init.body)).toEqual({ dest_path: "/Users/me/b.zip" });
  });

  it("내보내기: 확장자가 없으면 .zip을 붙인다", async () => {
    const fetchSpy = stubFetch(200, { ok: true, path: "/x/b.zip", vaults: [], skipped: [], skipped_files: [] });
    render(<BackupPanel dialog={fakeDialog({ save: vi.fn().mockResolvedValue("/x/b") })} onImported={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "전체 백업 내보내기" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).dest_path).toBe("/x/b.zip");
  });

  it("대화상자 취소면 아무 요청도 하지 않는다", async () => {
    const fetchSpy = stubFetch(200, {});
    const dialog = fakeDialog();
    render(<BackupPanel dialog={dialog} onImported={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "백업 가져오기" }));
    await waitFor(() => expect(dialog.open).toHaveBeenCalled());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("가져오기: 결과 표와 비고를 보여주고 onImported를 부른다", async () => {
    stubFetch(200, {
      ok: true,
      default_set: null,
      items: [
        { original: "rider-app", imported_as: "rider-app-2", renamed: true, workspace_reset: true, build_failed: false, error: null },
        { original: "hub", imported_as: null, renamed: false, workspace_reset: false, build_failed: false, error: "disk full" },
      ],
    });
    const onImported = vi.fn();
    render(<BackupPanel dialog={fakeDialog({ open: vi.fn().mockResolvedValue("/x/b.zip") })} onImported={onImported} />);
    fireEvent.click(screen.getByRole("button", { name: "백업 가져오기" }));
    await screen.findByText("rider-app-2");
    expect(screen.getByText(/같은 이름이 있어 이름을 바꿈/)).toBeTruthy();
    expect(screen.getByText(/workspace 다시 연결 필요/)).toBeTruthy();
    expect(screen.getByText(/disk full/)).toBeTruthy();
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("API 오류 detail을 보여준다", async () => {
    stubFetch(403, { detail: "백업 내보내기·가져오기는 이 PC에서만 할 수 있습니다" });
    render(<BackupPanel dialog={fakeDialog({ save: vi.fn().mockResolvedValue("/x/b.zip") })} onImported={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "전체 백업 내보내기" }));
    await screen.findByText(/이 PC에서만/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard && npx vitest run tests/BackupPanel.test.tsx`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: `dashboard/src/lib/backup.ts` 구현**

```ts
// backup — 전체 vault 백업 내보내기·가져오기 (데스크톱 전용).
//
// 데스크톱 대화상자(@tauri-apps/plugin-dialog)로 경로를 고르고, 그 경로를
// Python Core에 넘긴다 (POST /api/backup/export|import, loopback 전용).
// 브라우저 대시보드에는 대화상자가 없어 이 기능을 노출하지 않는다 — CLI를 쓴다.
import { apiFetch } from "./api";

export interface ExportReport {
  path: string;
  vaults: { name: string; file_count: number }[];
  skipped: { name: string; reason: string }[];
  skipped_files: string[];
}

export interface ImportItem {
  original: string;
  imported_as: string | null;
  renamed: boolean;
  workspace_reset: boolean;
  build_failed: boolean;
  error: string | null;
}

export interface ImportReport {
  items: ImportItem[];
  default_set: string | null;
}

/** @tauri-apps/plugin-dialog 중 쓰는 부분 — 테스트에서 주입한다. */
export interface DialogApi {
  save(options: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  open(options: {
    multiple?: boolean;
    directory?: boolean;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string | string[] | null>;
}

const ZIP_FILTER = [{ name: "Raven 백업", extensions: ["zip"] }];

export function loadDialog(): Promise<DialogApi> {
  return import("@tauri-apps/plugin-dialog") as Promise<DialogApi>;
}

export function backupFilename(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `raven-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.detail === "string" ? data.detail : `HTTP ${res.status}`);
  return data as T;
}

/** 저장 위치를 고르게 하고 백업한다. 취소하면 null. */
export async function exportBackup(dialog: DialogApi): Promise<ExportReport | null> {
  const picked = await dialog.save({ defaultPath: backupFilename(), filters: ZIP_FILTER });
  if (!picked) return null;
  const dest = picked.toLowerCase().endsWith(".zip") ? picked : `${picked}.zip`;
  return postJson<ExportReport>("/api/backup/export", { dest_path: dest });
}

/** 백업 파일을 고르게 하고 가져온다. 취소하면 null. */
export async function importBackup(dialog: DialogApi): Promise<ImportReport | null> {
  const picked = await dialog.open({ multiple: false, directory: false, filters: ZIP_FILTER });
  const src = Array.isArray(picked) ? picked[0] : picked;
  if (!src) return null;
  return postJson<ImportReport>("/api/backup/import", { src_path: src });
}

/** 가져오기 결과 한 줄의 비고 (CLI `vault import-backup` 출력과 같은 문구). */
export function importNotes(item: ImportItem): string[] {
  if (item.error) return [item.error];
  const notes: string[] = [];
  if (item.renamed) notes.push("같은 이름이 있어 이름을 바꿈");
  if (item.workspace_reset) notes.push("workspace 다시 연결 필요");
  if (item.build_failed) notes.push("색인 빌드 실패 — 다시 빌드하세요");
  return notes;
}
```

- [ ] **Step 4: `dashboard/src/components/BackupPanel.tsx` 구현**

```tsx
// BackupPanel — 관리 화면 "백업" 섹션 (데스크톱 전용).
//
// 전체 vault를 zip 하나로 내보내고, 다른 PC에서 만든 백업을 가져온다.
// vault가 하나도 없는 새 PC에서도 가져오기를 해야 하므로, VaultManage는 이 섹션을
// vault 목록 유무와 상관없이 렌더한다.
import { useState } from "react";
import { Button } from "./ui/Button";
import {
  exportBackup,
  importBackup,
  importNotes,
  loadDialog,
  type DialogApi,
  type ImportReport,
} from "../lib/backup";

export interface BackupPanelProps {
  onImported: () => void;
  /** 테스트 주입용. 없으면 @tauri-apps/plugin-dialog를 동적 import. */
  dialog?: DialogApi;
}

export function BackupPanel({ onImported, dialog }: BackupPanelProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  async function run(action: (d: DialogApi) => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action(dialog ?? (await loadDialog()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const onExport = () =>
    run(async (d) => {
      const r = await exportBackup(d);
      if (!r) return;
      setReport(null);
      const skipped = r.skipped.length ? ` (건너뜀: ${r.skipped.map((s) => s.name).join(", ")})` : "";
      setMessage(`vault ${r.vaults.length}개를 백업했습니다${skipped}: ${r.path}`);
    });

  const onImport = () =>
    run(async (d) => {
      const r = await importBackup(d);
      if (!r) return;
      setMessage(null);
      setReport(r);
      onImported();
    });

  return (
    <div style={{ marginTop: 32, borderTop: "2px solid var(--color-hairline)", paddingTop: 24 }}>
      <h2 style={{ fontSize: 17, margin: "0 0 4px" }}>백업</h2>
      <p style={{ fontSize: 13, margin: "0 0 12px", color: "var(--color-muted)" }}>
        모든 vault를 zip 하나로 내보내고, 다른 PC의 Raven에서 가져옵니다. 검색 색인은 가져온 뒤 다시 만듭니다.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onExport()}>
          전체 백업 내보내기
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onImport()}>
          백업 가져오기
        </Button>
      </div>
      {message && (
        <p style={{ fontSize: 13, margin: "12px 0 0", color: "var(--color-muted)", wordBreak: "break-all" }}>{message}</p>
      )}
      {error && <p style={{ fontSize: 13, margin: "12px 0 0", color: "var(--color-danger)" }}>❌ {error}</p>}
      {report && (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12, fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--color-hairline)" }}>
              <th style={{ textAlign: "left", padding: "4px 6px" }}>백업의 이름</th>
              <th style={{ textAlign: "left", padding: "4px 6px" }}>가져온 이름</th>
              <th style={{ textAlign: "left", padding: "4px 6px" }}>비고</th>
            </tr>
          </thead>
          <tbody>
            {report.items.map((it) => (
              <tr key={it.original} style={{ borderBottom: "1px solid var(--color-hairline)" }}>
                <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>{it.original}</td>
                <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>{it.imported_as ?? "—"}</td>
                <td style={{ padding: "4px 6px", color: it.error ? "var(--color-danger)" : "var(--color-muted)" }}>
                  {importNotes(it).join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 5: VaultManage 연결**

import 블록(`import { UpdatePanel } …` 아래)에 추가한다.

```tsx
import { BackupPanel } from "../components/BackupPanel";
```

`{/* ── 내 PC 및 서버 & API / MCP 환경 정보 ── */}` 바로 위(도구 섹션의 `)}` 다음)에 추가한다.

```tsx
      {/* ── 백업 (데스크톱 전용, vault가 없어도 가져오기는 가능해야 함) ── */}
      {isTauri && <BackupPanel onImported={() => void loadVaults()} />}
```

- [ ] **Step 6: 통과 확인**

Run: `cd dashboard && npx vitest run tests/BackupPanel.test.tsx && npx tsc -b`
Expected: PASS, 타입 오류 0

---

### Task 7: 전체 검증, 문서, commit 승인

**Files:**
- Modify: `_meta/changelog-v0.7.182.md` (append, `_meta/` 쓰기는 사용자 승인 대상)
- Modify: `docs/superpowers/specs/2026-10-02-vault-backup-export-import-design.md` (구현과 다른 점 반영)

- [ ] **Step 1: 전체 테스트**

Run: `scripts/.venv/bin/python -m pytest tests/ -q && (cd dashboard && npx vitest run && npx tsc -b) && (cd desktop/src-tauri && cargo test)`
Expected: 모두 PASS

- [ ] **Step 2: 실제 동작 확인 (CLI, 임시 루트)**

```bash
A=$(mktemp -d); B=$(mktemp -d)
WIKI_VAULTS_DIR=$A raven vault create t1 "$A/t1"
WIKI_VAULTS_DIR=$A raven vault create t2 "$A/t2"
echo "# 백업 확인" > "$A/t1/content/check.md"
WIKI_VAULTS_DIR=$A raven vault export -o "$A/rb.zip"
WIKI_VAULTS_DIR=$B raven vault import-backup "$A/rb.zip"
WIKI_VAULTS_DIR=$B raven vault list
diff -r "$A/t1/content" "$B/t1/content"   # 차이는 빌드가 만든 index.md·_index/뿐이어야 한다
```

**사용자 vault(`~/Raven`)에는 절대 쓰지 않는다**(AGENTS.md §10). 실제 `~/Raven`을 백업해 보는 export는 읽기만 하므로 사용자에게 물어본 뒤에만 한다.

- [ ] **Step 3: 데스크톱 수동 확인** — `cd dashboard && npm run desktop:dev`
  - 관리 화면의 "전체 백업 내보내기"에서 저장 대화상자가 뜨고, 저장하면 메시지에 경로가 나온다.
  - "백업 가져오기"는 `WIKI_VAULTS_DIR`을 임시 폴더로 띄운 앱에서 확인한다. 결과 표가 나오고 vault 목록이 갱신되어야 한다.

- [ ] **Step 4: spec 정정** — 구현과 다른 점 두 가지를 반영한다.
  1. 데스크톱 결과 알림: 토스트 대신 섹션 안 메시지로 바꿨다. 저장 경로를 계속 볼 수 있어야 하고, 이웃한 도구 섹션과 같은 방식이다.
  2. 제외 규칙: `wiki.db*`와 `.mcp/`는 vault 루트에서만, `.DS_Store`는 어디서든 뺀다. manifest의 vault 항목에 `had_workspace` 필드를 추가했다.

- [ ] **Step 5: changelog** — `_meta/changelog-v0.7.182.md` 끝에 append

```markdown
## 전체 vault 백업 내보내기·가져오기

다른 PC로 vault를 옮길 도구가 없었다(`vault import`는 같은 PC 안 clone 별칭이고 raw/·log.md·.graph_positions.json을 빠뜨린다). zip 한 파일로 모든 vault를 옮기는 경로를 추가했다.

- core `raven/core/backup.py` — `export_all` / `import_archive`. wiki.db·.mcp/·.DS_Store만 빼고 vault 폴더 전체. manifest.json에 레지스트리 메타(path/workspace_path 제외).
- 가져오기: 같은 이름이면 `name-2`…, 기존 vault는 건드리지 않음. `.vault.json` path 재작성, workspace_path는 비우고 보고. 임시 폴더에 풀고 rename. zip-slip·symlink·크기 상한은 풀기 전에 전부 거부.
- CLI `raven vault export [-o] [--vault]`, `raven vault import-backup <zip>`.
- API `POST /api/backup/export`, `POST /api/backup/import` — 경로를 받으므로 **loopback 전용**(그 외 403). 엔드포인트 68 → 70.
- 데스크톱 관리 화면 "백업" 섹션 — `tauri-plugin-dialog`(신규 의존성, 사용자 승인) 저장/열기 대화상자. 브라우저 대시보드에는 노출하지 않음.
- 후속 제안: `_meta/dr-runbook.md` 복구 절차를 이 기능 기준으로 갱신 (경로가 2026-06 구조 기준).
```

- [ ] **Step 6: 사용자에게 commit 승인 요청** — 승인이 나면 다음을 실행한다.

```bash
git add raven/core/backup.py raven/cli/__main__.py raven/api/server.py README.md \
  tests/test_backup.py tests/test_cli_backup.py tests/test_api_backup.py \
  desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock desktop/src-tauri/src/lib.rs \
  desktop/src-tauri/capabilities/default.json \
  dashboard/package.json dashboard/package-lock.json \
  dashboard/src/lib/backup.ts dashboard/src/components/BackupPanel.tsx \
  dashboard/src/routes/VaultManage.tsx dashboard/tests/BackupPanel.test.tsx \
  docs/superpowers/specs/2026-10-02-vault-backup-export-import-design.md _meta/changelog-v0.7.182.md
git commit -m "feat(backup): 전체 vault 백업 내보내기·가져오기 — CLI/API/데스크톱"
```

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
from pathlib import Path
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
    # dest가 내보내는 vault 안이면 자기 자신(.tmp)을 계속 읽어 디스크를 채운다.
    resolved = dest.resolve()
    for meta in metas:
        if resolved.is_relative_to(Path(meta.path).resolve()):
            raise BackupError(f"백업 파일을 vault 폴더 안에 저장할 수 없습니다: {meta.name}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".tmp")
    try:
        # strict_timestamps=False — 1980년 이전 mtime 파일도 1980-01-01로 담는다.
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, strict_timestamps=False) as zf:
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
        and not any(ord(c) < 32 for c in name)
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
    seen: set[str] = set()
    for entry in vaults:
        name = entry.get("name") if isinstance(entry, dict) else None
        if (
            not _safe_vault_name(name)
            or entry.get("dir") != f"vaults/{name}"
            or not isinstance(entry.get("meta"), dict)
        ):
            raise BackupError(f"manifest의 vault 항목이 잘못됐습니다: {entry!r}")
        if name in seen:
            raise BackupError(f"manifest에 같은 vault 이름이 두 번 있습니다: {name}")
        seen.add(name)
    return manifest


def _validate_entries(zf: zipfile.ZipFile, manifest: dict, max_bytes: int) -> None:
    """풀기 전에 전체 항목 검사 — 하나라도 걸리면 아무것도 풀지 않는다 (zip-slip/symlink/bomb)."""
    prefixes = tuple(e["dir"] + "/" for e in manifest["vaults"])
    total = 0
    for info in zf.infolist():
        name = info.filename
        if name == MANIFEST:
            continue
        # PurePosixPath는 "//"와 "."을 접어 버리므로 직접 나눈다. 디렉터리 항목의 끝 "/"만 허용.
        parts = name.split("/")
        if parts and parts[-1] == "":
            parts = parts[:-1]
        if (
            name.startswith("/")
            or "\\" in name
            or any(p in ("", ".", "..") for p in parts)
            or (parts and ":" in parts[0])
        ):
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
        if not out.resolve().is_relative_to(staging.resolve()):
            raise BackupError(f"안전하지 않은 경로가 있습니다: {info.filename}")
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
            except Exception as e:  # OSError뿐 아니라 CRC 오류(BadZipFile), zlib.error 등
                shutil.rmtree(staging, ignore_errors=True)
                item.error = str(e)
                continue

            try:
                meta = VaultMeta.from_json(new_name, {**entry["meta"], "path": str(target)})
                _rewrite_vault_json(target, meta)
                registry().add(meta)
            except Exception as e:  # 잘못된 meta 등 — 방금 만든 폴더만 지운다
                shutil.rmtree(target, ignore_errors=True)
                item.error = str(e)
                continue
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

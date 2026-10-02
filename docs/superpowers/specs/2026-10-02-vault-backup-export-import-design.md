# 전체 vault 백업 내보내기·가져오기 — 설계

- **작성일**: 2026-10-02
- **범위**: 등록된 모든 vault를 zip 파일 하나로 묶어 내보내고, 다른 PC의 Raven에서 그 파일을 가져와 그대로 복원한다. CLI·HTTP API·데스크톱 관리 화면에서 같은 core 함수를 호출한다.

## 배경

PC를 옮기거나 두 대를 함께 쓸 때 vault를 옮길 방법이 없다. 지금 있는 기능은 다음과 같다.

- `raven vault import`는 `vault clone`의 별칭이다(`raven/cli/__main__.py`). **같은 PC 안에서** 등록된 vault를 복사할 뿐이다. 게다가 `content/`와 (옵션으로) `_meta/`만 복사하고 `raw/`, `log*.md`, `drafts/`, `_archive/`, `journal/`, `.graph_positions.json`은 빠진다(`raven/core/vault.py` `Vault.clone`).
- `raven/core/export.py`는 대시보드용 정적 JSON 번들이라 백업과 관계없다.
- `_meta/dr-runbook.md`는 git remote와 Time Machine에 기대고 있고, 문서의 경로도 예전 구조 기준이다.
- 실제로 PC 사이 이전을 수동으로 했다(`docs/superpowers/plans/집-pc-운영-지침-이전-체크리스트.md`).

옮길 때 문제가 되는 기기 의존 데이터:

| 항목 | 위치 | 처리 |
|---|---|---|
| `path` (절대경로) | `.vault.json`, 레지스트리 | 가져올 때 새 위치로 다시 쓴다 |
| `workspace_path` (절대경로) | `.vault.json`, 레지스트리 | 가져올 때 비우고, 다시 설정해야 한다고 보고에 적는다 |
| MCP 토큰 | `<VAULTS_ROOT>/.mcp-tokens.json` | vault 밖에 있는 기기별 설정이므로 넣지 않는다 |
| 런타임 락 | `<vault>/.mcp/locks/` | 넣지 않는다 |
| 인덱스 | `<vault>/wiki.db` | 넣지 않는다. 가져온 뒤 다시 빌드한다 |

## 결정 사항

1. **범위**: vault 폴더 전체를 넣는다. 빼는 것은 다시 만들 수 있거나 기기에 묶인 것(`wiki.db`, `wiki.db-journal`, `wiki.db-wal`, `wiki.db-shm`, `.mcp/`, `.DS_Store`)뿐이다. 모르는 폴더도 그대로 담는다. 화이트리스트가 아니라 블랙리스트 방식이다.
2. **이름 충돌**: 가져올 PC에 같은 이름이 있으면 `<name>-2`, `<name>-3` 순으로 처음 비는 이름을 쓴다. 기존 vault는 절대 건드리지 않는다.
3. **파일 전달(B안)**: 데스크톱 앱이 `tauri-plugin-dialog`로 저장·열기 경로를 고르고, Python Core API에 그 **경로**를 넘긴다. Core가 직접 파일을 읽고 쓴다.
   - 경로를 받는 API는 **loopback 출처만** 허용한다. API는 0.0.0.0에 바인딩되어 있으므로 내부망이나 tailnet에서 온 요청은 403으로 막는다.
   - 브라우저 대시보드에는 버튼을 보이지 않는다. 데스크톱 앱이 아니면 렌더링하지 않는다. 헤드리스 서버나 브라우저 사용자는 CLI를 쓴다.
4. **새 의존성 (사용자 승인 2026-10-02, B안 선택)**: `tauri-plugin-dialog = "2"`(Cargo), `@tauri-apps/plugin-dialog`(npm). Python 쪽은 표준 라이브러리 `zipfile`만 쓴다.
5. **포함하지 않는 것**: `~/Raven/.git` 이력, MCP 토큰, vault 하나만 고르는 UI. CLI의 `--vault` 반복 옵션은 core 인자로 거의 공짜로 생기므로 둔다. MCP 도구로도 노출하지 않는다 — 경로 기반 파일 읽기/쓰기를 LAN·에이전트에 열지 않기 위해서다.

## 백업 파일 형식

파일명 기본값은 `raven-backup-YYYYMMDD-HHMM.zip`이다.

```
manifest.json
vaults/<name>/...        # vault 폴더 원본 트리 (제외 목록 빼고)
```

`manifest.json`:

```json
{
  "format": "raven-backup",
  "format_version": 1,
  "raven_version": "0.7.18x",
  "created": "2026-10-02T14:30:00+09:00",
  "default": "hub-control-room",
  "vaults": [
    {
      "name": "hub-control-room",
      "dir": "vaults/hub-control-room",
      "meta": { "mode": "...", "owner": "...", "description": "...", "created": "...",
                "features": {}, "agents": {}, "allow_tier1_leak": false },
      "file_count": 412
    }
  ]
}
```

- `meta`는 레지스트리 항목에서 `path`와 `workspace_path`를 뺀 것이다.
- 가져올 때 `format != "raven-backup"`이거나 `format_version`이 지원하는 값보다 크면 거부한다.

## Core — `raven/core/backup.py` (신규)

```python
# vault 루트에서만: 색인 DB와 런타임 락. 어디서든: .DS_Store
ROOT_EXCLUDE_FILES = {"wiki.db", "wiki.db-journal", "wiki.db-wal", "wiki.db-shm"}
ROOT_EXCLUDE_DIRS = {".mcp"}
ANYWHERE_EXCLUDE_FILES = {".DS_Store"}

def export_all(dest: Path, *, names: list[str] | None = None) -> ExportReport
def import_archive(src: Path) -> ImportReport
```

**`export_all`**

1. 레지스트리에서 vault 목록을 읽는다. `names`를 주면 그 vault만 묶는다.
2. `Vault.load`가 실패하는 vault(경로 깨짐 등)는 건너뛰고 `skipped`에 사유를 남긴다.
3. `dest.with_suffix(".zip.tmp")`에 `ZIP_DEFLATED`로 쓴 뒤 `os.replace`한다. 중간에 실패해도 반쯤 쓴 파일이 남지 않는다.
4. symlink는 따라가지 않고 건너뛴 뒤 `skipped_files`에 적는다.
5. `ExportReport(path, vaults=[name, file_count], skipped)`를 반환한다.

**`import_archive`**

1. zip을 열고 `manifest.json`을 검증한다.
2. **모든 항목을 먼저 검사한다.** 하나라도 걸리면 아무것도 풀지 않고 `BackupError`를 낸다.
   - 절대경로, `..` 성분, 드라이브 문자가 있으면 거부한다.
   - symlink 항목(`external_attr`의 S_IFLNK)이 있으면 거부한다.
   - `manifest.vaults[*].dir` 밖에 있는 항목이 있으면 거부한다(`manifest.json`은 예외).
   - 압축 해제 후 총 크기가 상한(기본 5 GiB)을 넘으면 거부한다. zip bomb 방지용이다.
3. vault마다 다음을 한다.
   1. 이름을 정한다. `name`, `name-2`, `name-3` 순으로, 레지스트리와 `VAULTS_ROOT` 디렉터리 양쪽에서 비어 있는 첫 이름을 쓴다.
   2. `VAULTS_ROOT/.import-<uuid>/`에 푼 다음 `VAULTS_ROOT/<새 이름>`으로 `os.rename`한다.
   3. `.vault.json`의 `path`를 새 위치로 고치고 `workspace_path` 키는 지운다(`.vault.json`에는 name 필드가 없다). 원래 workspace가 있었는지는 manifest의 `had_workspace`로 알려준다.
   4. 레지스트리에 `manifest`의 `meta`를 그대로 넣고, path는 새 위치로, workspace_path는 비워서 등록한다.
   5. `build_db`로 인덱스를 다시 만든다. 빌드가 실패해도 파일과 등록은 유지하고, 보고에 `build_failed`로 남긴다. 다음 빌드 때 다시 시도할 수 있다.
4. 한 vault가 실패하면 그 vault의 임시 폴더만 지우고 다음 vault로 넘어간다. 이미 가져온 vault는 그대로 둔다.
5. 가져오기 전 레지스트리가 비어 있을 때만 manifest의 default(이름이 바뀌었다면 바뀐 이름)를 default로 정한다.
6. `ImportReport(items=[{original, imported_as, renamed, workspace_reset, build_failed, error}])`를 반환한다.

레지스트리 저장은 기존 `raven/core/registry.py` API를 쓴다. 등록 경로를 새로 만들지 않는다. (참고로 기존 CLI/API `register`는 `.vault.json`의 features/agents를 무시한다. 이 기능은 manifest의 `meta`를 직접 넘기므로 영향받지 않는다. register 자체는 고치지 않는다.)

## 진입점

**CLI** (`vault_app`, `raven/cli/__main__.py`)

```
raven vault export [-o FILE] [--vault NAME ...]     # 기본: ./raven-backup-YYYYMMDD-HHMM.zip
raven vault import-backup FILE
```

`vault import`는 이미 clone의 별칭이라 이름을 `import-backup`으로 구분한다. 결과는 표로 찍는다(원래 이름 → 가져온 이름, 비고).

**HTTP API** (`raven/api/server.py`)

```
POST /api/backup/export   {"dest_path": "...", "vaults": null}  → ExportReport
POST /api/backup/import   {"src_path": "..."}                     → ImportReport
```

- 둘 다 `request.client.host`가 loopback(127.0.0.0/8, ::1)이 아니면 403을 반환한다. tailnet은 넣지 않는다. `request.client`는 uvicorn 기본값대로 127.0.0.1 프록시가 붙인 X-Forwarded-For만 반영하고, Vite 개발 프록시는 `xfwd: true`로 실제 LAN IP를 넘긴다.
- `Origin` 헤더가 있으면 `tauri:` scheme 또는 localhost/127.0.0.1/::1/tauri.localhost만 허용한다. CORS 허용 목록은 사설망까지 열려 있어 CSRF·DNS rebinding·프록시 경유 LAN 브라우저를 막지 못하기 때문이다.
- `dest_path`와 `src_path`는 절대경로여야 한다. export는 `.zip` 확장자를 강제한다.
- `BackupError`는 400으로, 그 밖의 예외는 500으로 처리한다.

**데스크톱 관리 화면** (`dashboard/src/routes/VaultManage.tsx` 또는 관리 화면의 해당 섹션)

- "전체 백업 내보내기" 버튼: `save()` 대화상자를 연다(기본 파일명 `raven-backup-….zip`, 필터 zip). 고른 경로로 `POST /api/backup/export`를 호출하고, 섹션 안 메시지로 vault 수와 파일 경로를 보여준다(경로를 계속 볼 수 있어야 해서 토스트 대신 이웃 도구 섹션과 같은 방식).
- "백업 가져오기" 버튼: `open()` 대화상자를 연다(zip 필터, 파일 하나). 고른 경로로 `POST /api/backup/import`를 호출한다. 완료되면 결과 표(가져옴 / 이름 바뀜 / workspace 재설정 필요 / 빌드 실패)를 보여주고 vault 목록을 다시 불러온다.
- 데스크톱 앱이 아니거나 대시보드의 활성 호스트가 원격이면 섹션을 렌더링하지 않는다(경로는 이 PC에서 고르기 때문). 판정은 기존 `pageExport.ts`의 Tauri 판별 방식을 재사용한다.
- 버튼은 `components/ui/Button`을 쓰고, 결과 표는 이웃 도구 섹션처럼 평범한 `<table>`이다. 색과 폰트는 CSS 변수로 지정한다(AGENTS.md §13).

**Tauri** (`desktop/src-tauri`)

- `Cargo.toml`에 `tauri-plugin-dialog = "2"`를 넣고 `lib.rs`에서 `.plugin(tauri_plugin_dialog::init())`을 호출한다.
- `capabilities/default.json`에 `dialog:allow-save`와 `dialog:allow-open`을 추가한다. 권한이 빠지면 대화상자가 조용히 실패한다. 직전 app_version 버그와 같은 유형이다.

## 오류 처리

| 상황 | 동작 |
|---|---|
| 대화상자에서 취소 | 아무 일도 하지 않는다(토스트 없음) |
| loopback이 아닌 요청 | 403 |
| manifest 없음·형식 다름·버전이 더 높음 | 400, 아무것도 풀지 않음 |
| zip-slip(절대경로, `..`, `.`, 빈 구간 `//`) / symlink / 크기 초과 | 400, 아무것도 풀지 않음 |
| 백업 파일 경로가 내보낼 vault 폴더 안 | 400 (자기 자신을 읽으며 끝없이 커지는 것 방지), 파일을 만들지 않음 |
| 1980년 이전 mtime 파일 | 1980년으로 맞춰 담는다 (`strict_timestamps=False`) |
| vault 하나의 메타가 잘못됨(등록 실패) | 방금 만든 그 vault 폴더만 지우고 `error`, 나머지는 계속 |
| vault 하나의 풀기·rename 실패 | 그 vault의 임시 폴더만 지우고 보고에 `error`, 나머지는 계속 |
| DB 빌드 실패 | 파일과 등록은 유지, 보고에 `build_failed` |
| export 중 디스크 부족 등 | `.zip.tmp`를 지우고 500 |

## 테스트

`tests/test_backup.py` (core):

- 왕복: vault 2개 export → 빈 `VAULTS_ROOT`에 import. 파일 트리와 바이트가 같고(제외 목록 빼고) 레지스트리 meta가 보존돼야 한다.
- `.graph_positions.json`, `raw/`, `log.md`, `_archive/`, 모르는 폴더가 포함되고, `wiki.db`와 `.mcp/`는 빠져야 한다.
- 이름 충돌: `a`가 있으면 `a-2`로, `a-2`까지 있으면 `a-3`으로 가져와야 한다.
- `.vault.json`의 path가 새 위치로 바뀌고 workspace_path 키가 없고, `workspace_reset=True`여야 한다.
- 거부: `../evil`, 절대경로, symlink 항목, manifest 없음, `format_version` 99, 크기 상한 초과(상한을 낮춰서). 모두 VAULTS_ROOT에 아무 변화가 없어야 한다.
- default: 레지스트리가 비어 있으면 manifest default를 설정하고, 이미 있으면 유지해야 한다.
- 가져온 뒤 DB 빌드가 성공해 검색이 동작해야 한다.

`tests/test_api_backup.py`: loopback이면 200, 그 밖의 client host면 403. 상대경로 400, 잘못된 zip 400.

`tests/test_cli_backup.py`: `vault export` / `vault import-backup` 스모크 테스트.

Rust: dialog 권한이 capability에 들어 있는지 검사하는 테스트(기존 lib.rs 테스트 방식을 따른다).

## 문서

- changelog를 새 버전 섹션으로 남긴다.
- README CLI 목록에 두 명령을 추가한다.
- `_meta/dr-runbook.md`의 복구 절차를 이 기능 기준으로 고치자고 **제안만** 한다(`_meta/`는 고치기 전에 승인이 필요하다).

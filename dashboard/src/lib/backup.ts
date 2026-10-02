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

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
    setMessage(null);
    setReport(null);
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
      const skipped = r.skipped.length ? ` (건너뜀: ${r.skipped.map((s) => s.name).join(", ")})` : "";
      setMessage(`vault ${r.vaults.length}개를 백업했습니다${skipped}: ${r.path}`);
    });

  const onImport = () =>
    run(async (d) => {
      const r = await importBackup(d);
      if (!r) return;
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
                <td style={{ padding: "4px 6px", fontFamily: "var(--font-mono)" }}>{it.original}</td>
                <td style={{ padding: "4px 6px", fontFamily: "var(--font-mono)" }}>{it.imported_as ?? "—"}</td>
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

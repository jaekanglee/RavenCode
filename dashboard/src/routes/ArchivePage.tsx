import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  fetchArchive,
  restoreArchive,
  cleanArchive,
  type ArchiveEntry,
} from "../lib/api";
import { PageHeader } from "../components/ui/PageHeader";
import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";

/**
 * ArchivePage — 삭제된 페이지 보관함 (P0-1).
 *
 * DeleteButton이 _archive/로 보낸 페이지를 열람·복원·정리한다.
 * API 3종(list/restore/clean)은 v0.7.67+ 이미 구현됨 — 이 페이지는 UI 노출.
 */

function formatAge(days: number | null): string {
  if (days === null) return "—";
  if (days < 1) return "오늘";
  if (days < 2) return "어제";
  return `${Math.floor(days)}일 전`;
}

function formatTs(ts: string | null): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

export function ArchivePage() {
  const { vault } = useOutletContext<{ vault: string }>();
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // restore state
  const [restoreTarget, setRestoreTarget] = useState<ArchiveEntry | null>(null);
  const [restoring, setRestoring] = useState(false);

  // clean state
  const [cleanDays, setCleanDays] = useState(30);
  const [cleanPreview, setCleanPreview] = useState<number | null>(null);
  const [cleanBusy, setCleanBusy] = useState(false);
  const [cleanConfirm, setCleanConfirm] = useState(false);

  const load = useCallback(async () => {
    if (!vault) return;
    setLoading(true);
    setError(null);
    try {
      const d = await fetchArchive(vault);
      setEntries(d.entries);
      setCount(d.count);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [vault]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  // ── restore ──
  async function doRestore() {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const r = await restoreArchive(vault, restoreTarget.rel_path);
      setToast(`✅ 복원: ${r.original_slug}`);
      setRestoreTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRestoreTarget(null);
    } finally {
      setRestoring(false);
    }
  }

  // ── clean ──
  async function previewClean() {
    setCleanBusy(true);
    setError(null);
    try {
      const r = await cleanArchive(vault, cleanDays, false);
      setCleanPreview(r.would_delete_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCleanBusy(false);
    }
  }

  async function doClean() {
    setCleanBusy(true);
    setError(null);
    try {
      const r = await cleanArchive(vault, cleanDays, true);
      setToast(`🗑 ${r.deleted_count}개 영구 삭제`);
      setCleanPreview(null);
      setCleanConfirm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCleanConfirm(false);
    } finally {
      setCleanBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <PageHeader
        title="보관함"
        contextLabel={`in ${vault}`}
        titleSize={22}
        bottomSpacing={20}
        subtitle="삭제된 페이지가 _archive/에 보관됩니다. 복원하거나 영구 정리할 수 있습니다."
      />

      {error && (
        <p role="alert" style={{ color: "var(--color-danger-text)", fontSize: 13, marginBottom: 12 }}>
          {error}
        </p>
      )}
      {toast && (
        <p
          role="status"
          style={{
            fontSize: 13,
            marginBottom: 12,
            padding: "8px 12px",
            background: "var(--color-surface-soft)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          {toast}
        </p>
      )}

      {/* ── clean controls ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--color-muted)" }}>
          <input
            className="input-base"
            type="number"
            min={0}
            value={cleanDays}
            onChange={(e) => {
              setCleanDays(Math.max(0, Number(e.target.value)));
              setCleanPreview(null);
            }}
            style={{ width: 72, height: 32, padding: "4px 8px", fontSize: 13 }}
            aria-label="정리 기준 일수"
          />
          일 이상 경과
        </label>
        <Button variant="secondary" size="sm" onClick={() => void previewClean()} disabled={cleanBusy}>
          미리보기
        </Button>
        {cleanPreview !== null && (
          <>
            <span style={{ fontSize: 13, color: "var(--color-muted)" }}>
              {cleanPreview}개 대상
            </span>
            <Button
              variant="danger"
              size="sm"
              disabled={cleanBusy || cleanPreview === 0}
              onClick={() => setCleanConfirm(true)}
            >
              영구 삭제
            </Button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: "var(--color-muted)" }}>
          {count}개 보관 중
        </span>
      </div>

      {/* ── entries table ── */}
      {loading ? (
        <p className="text-muted">불러오는 중…</p>
      ) : entries.length === 0 ? (
        <p className="text-muted">보관된 페이지가 없습니다.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--color-hairline)" }}>
              <th style={{ textAlign: "left", padding: "10px 8px" }}>원본 slug</th>
              <th style={{ textAlign: "left", padding: "10px 8px", whiteSpace: "nowrap" }}>보관 시각</th>
              <th style={{ textAlign: "left", padding: "10px 8px", whiteSpace: "nowrap" }}>경과</th>
              <th style={{ textAlign: "right", padding: "10px 8px" }}>작업</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.rel_path} style={{ borderBottom: "1px solid var(--color-hairline)" }}>
                <td
                  style={{
                    padding: "10px 8px",
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    fontSize: 12,
                  }}
                >
                  {e.original_slug}
                </td>
                <td style={{ padding: "10px 8px", color: "var(--color-muted)", whiteSpace: "nowrap" }}>
                  {formatTs(e.timestamp)}
                </td>
                <td style={{ padding: "10px 8px", color: "var(--color-muted)", whiteSpace: "nowrap" }}>
                  {formatAge(e.age_days)}
                </td>
                <td style={{ padding: "10px 8px", textAlign: "right", whiteSpace: "nowrap" }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setRestoreTarget(e)}
                  >
                    복원
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ── restore confirm ── */}
      <ConfirmDialog
        open={!!restoreTarget}
        title="페이지 복원"
        description={
          restoreTarget
            ? `"${restoreTarget.original_slug}" 을(를) 원래 위치로 복원합니다. 같은 slug의 페이지가 이미 있으면 복원할 수 없습니다.`
            : undefined
        }
        confirmLabel="복원"
        busy={restoring}
        onConfirm={() => void doRestore()}
        onClose={() => setRestoreTarget(null)}
      />

      {/* ── clean confirm ── */}
      <ConfirmDialog
        open={cleanConfirm}
        title="영구 삭제"
        tone="danger"
        description={`${cleanDays}일 이상 경과한 보관 파일 ${cleanPreview ?? 0}개를 영구 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="영구 삭제"
        busy={cleanBusy}
        onConfirm={() => void doClean()}
        onClose={() => setCleanConfirm(false)}
      />
    </div>
  );
}

import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { fetchLog, fetchLogStatus, type LogEntry, type LogStatus } from "../lib/api";
import { Button } from "../components/ui/Button";
import { ButtonIcon } from "../components/ui/ButtonIcon";

/**
 * LogPage — log.md timeline viewer (data table).
 *
 * Rausch는 status badge 액센트만. action 색상은 ink 계층 + 라벨 텍스트로 구분.
 */
export function LogPage() {
  const { vault } = useOutletContext<{ vault: string }>();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<LogStatus | null>(null);
  const [actionFilter, setActionFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [log, st, rawLog] = await Promise.all([
        fetchLog(vault, { tail: 100, ...(actionFilter ? { action: actionFilter } : {}) }),
        fetchLogStatus(vault),
        fetchLog(vault, { raw: true }),
      ]);
      setEntries(log.entries);
      setTotal(log.total);
      setStatus(st);
      setRawText(rawLog.raw || "");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [vault, actionFilter]);

  // Action chip — action 종류별로 구분 가능한 배경/텍스트 색상.
  // CSS 변수(--color-ink 등)는 테마에 따라 대비가 깨질 수 있어 고정 팔레트 사용.
  const actionStyle = (a: string): React.CSSProperties => {
    const palette: Record<string, { bg: string; color: string }> = {
      create:  { bg: "#16a34a", color: "#fff" },   // green
      ingest:  { bg: "#2563eb", color: "#fff" },   // blue
      update:  { bg: "#7c3aed", color: "#fff" },   // violet
      build:   { bg: "#0891b2", color: "#fff" },   // cyan
      lint:    { bg: "#d97706", color: "#fff" },   // amber
      chore:   { bg: "#6b7280", color: "#fff" },   // gray
      migrate: { bg: "#0f766e", color: "#fff" },   // teal
      archive: { bg: "#ea580c", color: "#fff" },   // orange
      delete:  { bg: "#dc2626", color: "#fff" },   // red
      gardening: { bg: "#65a30d", color: "#fff" }, // lime — 가드닝 회차 기록 (wiki_gardening_record)
    };
    const p = palette[a] ?? { bg: "#374151", color: "#fff" };
    return { background: p.bg, color: p.color };
  };

  return (
    <div style={{ maxWidth: 1120 }}>
      <div style={{ marginBottom: 8, display: "flex", alignItems: "baseline", gap: 8 }}>
        <h1 style={{ margin: 0 }}>Vault Log</h1>
        <span style={{ color: "var(--color-muted)", fontSize: 14 }}>in {vault}</span>
      </div>
      <p className="text-muted" style={{ fontSize: 14, marginTop: 8, marginBottom: 32 }}>
        vault 작업 이력을 시간순으로 표시합니다.
      </p>

      {/* Status panel */}
      {status && (
        <div
          className="card-flat"
          style={{
            marginBottom: 24,
            padding: 24,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 16,
            fontSize: 13,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.32px",
                textTransform: "uppercase",
                color: "var(--color-muted)",
                marginBottom: 4,
              }}
            >
              path
            </div>
            <div
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                fontSize: 12,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--color-ink)",
              }}
              title={status.log_path}
            >
              {status.log_path.replace(/^.*\//, "~/")}
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.32px",
                textTransform: "uppercase",
                color: "var(--color-muted)",
                marginBottom: 4,
              }}
            >
              entries
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "var(--color-ink)" }}>
              {status.total_entries}{" "}
              <span style={{ fontSize: 13, color: "var(--color-muted)", fontWeight: 400 }}>
                / {status.rotate_threshold}
              </span>
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.32px",
                textTransform: "uppercase",
                color: "var(--color-muted)",
                marginBottom: 4,
              }}
            >
              last
            </div>
            <div style={{ fontSize: 12 }}>
              {status.last_entry
                ? `[${status.last_entry.date}] ${status.last_entry.action}`
                : "—"}
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.32px",
                textTransform: "uppercase",
                color: "var(--color-muted)",
                marginBottom: 4,
              }}
            >
              rotation
            </div>
            <div
              style={{
                fontWeight: 600,
                color: status.needs_rotate
                  ? "var(--color-primary)"
                  : "var(--color-ink)",
              }}
            >
              {status.needs_rotate ? "⚠ rotate 권장" : "✓ OK"}
            </div>
          </div>
        </div>
      )}

      {/* Controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: "var(--color-muted)",
            whiteSpace: "nowrap",
          }}
        >
          액션
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="input-base"
            style={{
              width: "auto",
              height: 36,
              padding: "6px 14px",
              fontSize: 13,
              fontFamily: "inherit",
              borderRadius: "var(--radius-full)",
            }}
          >
            <option value="">전체</option>
            {["ingest", "update", "create", "archive", "delete", "lint", "build", "migrate", "chore", "gardening"].map(
              (a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              )
            )}
          </select>
        </label>
        <Button onClick={load} variant="secondary" size="sm">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ButtonIcon.Refresh />새로고침
          </span>
        </Button>
        <Button onClick={() => setRawMode(!rawMode)} variant="secondary" size="sm">
          {rawMode ? "📋 리스트" : "🗒 raw"}
        </Button>
        <span style={{ fontSize: 12, color: "var(--color-muted)", marginLeft: "auto" }}>
          showing {entries.length} / {total}
        </span>
      </div>

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : rawMode ? (
        <pre
          style={{
            background: "var(--color-surface-soft)",
            border: "1px solid var(--color-hairline)",
            borderRadius: "var(--radius-md)",
            padding: 16,
            fontSize: 12,
            overflowX: "auto",
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            whiteSpace: "pre-wrap",
            color: "var(--color-body)",
          }}
        >
          {rawText || "로그 데이터가 비어 있거나 불러오지 못했습니다."}
        </pre>
      ) : entries.length === 0 ? (
        <p className="text-muted">entry 없음 — 첫 작업 시 자동 생성</p>
      ) : (
        <div
          style={{
            border: "1px solid var(--color-hairline)",
            borderRadius: "var(--radius-md)",
            overflow: "hidden",
          }}
        >
          {entries
            .slice()
            .reverse()
            .map((e, i, arr) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "12px 16px",
                  fontSize: 13,
                  borderBottom: i === arr.length - 1 ? "none" : "1px solid var(--color-hairline)",
                }}
              >
                <span
                  style={{
                    color: "var(--color-muted)",
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    fontSize: 12,
                    whiteSpace: "nowrap",
                  }}
                >
                  {e.date}
                </span>
                <span className="chip-strong" style={actionStyle(e.action)}>
                  {e.action}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--color-ink)",
                    }}
                  >
                    {e.subject}
                  </div>
                  {e.details.length > 0 && (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--color-muted)",
                        marginTop: 2,
                      }}
                    >
                      {e.details.join(" · ")}
                    </div>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
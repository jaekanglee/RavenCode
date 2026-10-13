import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  fetchLint,
  fetchLintSummary,
  fetchBuild,
  type LintIssue,
  type LintSeverity,
  type LintSummary,
  type LintResult,
  type BuildResult,
} from "../lib/api";
import { EmptyState } from "../components/ui/EmptyState";
import { EmptyIcon } from "../lib/emptyIcons";
import { Button } from "../components/ui/Button";
import { ButtonIcon } from "../components/ui/ButtonIcon";
import { PageHeader } from "../components/ui/PageHeader";
import { Toast } from "../components/ui/Toast";

/**
 * LintPage — vault lint 14개 viewer.
 *
 * 위키 dashboard 톤: 데이터 테이블, Rausch는 status badge accent만.
 * yellow/red는 ink 기반 다층 표현으로 대체 (체크/이니셜 라벨).
 */
function sortedCheckIds(checks: Record<string, string>): string[] {
  return Object.keys(checks).sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1))
  );
}

const SEVERITY_LABELS: Record<LintSeverity, string> = {
  critical: "치명",
  warning: "주의",
  info: "정보",
};

export function LintPage() {
  const { vault } = useOutletContext<{ vault: string }>();
  const [summary, setSummary] = useState<LintSummary | null>(null);
  const [result, setResult] = useState<LintResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkFilter, setCheckFilter] = useState<string>("");
  const [severityFilter, setSeverityFilter] = useState<LintSeverity | "">("");
  const [writeLog, setWriteLog] = useState(false);
  const [lastWriteResult, setLastWriteResult] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 2400);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [sum, full] = await Promise.all([
        fetchLintSummary(vault),
        fetchLint(vault, {
          ...(checkFilter ? { check: checkFilter } : {}),
          ...(severityFilter ? { severity: severityFilter } : {}),
          ...(writeLog ? { write_log: true } : {}),
        }),
      ]);
      setSummary(sum);
      setResult(full);
      if (writeLog && full) {
        // v0.7.117 (Fix C): setWriteLog(false) 자동 reset 제거.
        // 사용자가 의도적으로 켠 토글이 즉시 풀리면 재호출 시 write_log=false가
        // 전달되어 "log 기록"이 off-by-one 으로 한 번 누락됨. 사용자가 직접
        // 체크 해제할 때까지 유지 (의도 명시성).
        setLastWriteResult(`[${new Date().toLocaleTimeString()}] log 기록됨`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRebuild = async () => {
    setBuilding(true);
    setBuildResult(null);
    try {
      const res = await fetchBuild(vault);
      if (!res) {
        showToast("리빌드 실패: 서버 응답 없음", "error");
        return;
      }
      setBuildResult(res);
      if (res.lint) {
        setResult(res.lint);
        setSummary({
          ok: res.lint.ok,
          vault,
          counts: res.lint.counts,
          by_check: res.lint.by_check,
          checks: res.lint.checks,
        });
      }
      const pageCount = res.build.pages ?? "?";
      showToast(
        `리빌드 완료 — ${pageCount} pages, lint ${res.lint?.counts.total ?? "?"}건`,
        res.build.ok ? "success" : "error"
      );
      setTimeout(() => setBuildResult(null), 3000);
    } catch (e) {
      console.error(e);
      showToast("리빌드 중 오류가 발생했습니다.", "error");
    } finally {
      setBuilding(false);
    }
  };

  useEffect(() => {
    load();
  }, [vault, checkFilter, severityFilter]);

  const checkNames = summary?.checks ?? {};
  const checkIds = sortedCheckIds(checkNames);

  return (
    <div style={{ maxWidth: 1120 }}>
      <PageHeader
        title="린트"
        contextLabel={`${vault} 보관소`}
        subtitle={`${checkIds.length || ""}개 lint check 결과 요약입니다.`}
      />

      {/* Counts header */}
      {summary && (
        <div className="card-flat" style={{ marginBottom: 24, padding: 24 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 20,
            }}
          >
            <span style={{ fontSize: 24 }}>{summary.ok ? "✓" : "!"}</span>
            <span style={{ fontSize: 20, fontWeight: 700 }}>{summary.vault}</span>
            <span style={{ marginLeft: "auto", color: "var(--color-muted)", fontSize: 13 }}>
              총 {summary.counts.total}개 이슈
            </span>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 12,
            }}
          >
            <SeverityCard
              label="critical"
              count={summary.counts.critical}
              isActive={severityFilter === "critical"}
              onClick={() => setSeverityFilter(severityFilter === "critical" ? "" : "critical")}
            />
            <SeverityCard
              label="warning"
              count={summary.counts.warning}
              isActive={severityFilter === "warning"}
              onClick={() => setSeverityFilter(severityFilter === "warning" ? "" : "warning")}
            />
            <SeverityCard
              label="info"
              count={summary.counts.info}
              isActive={severityFilter === "info"}
              onClick={() => setSeverityFilter(severityFilter === "info" ? "" : "info")}
            />
          </div>
        </div>
      )}

      {/* By-check bar chart */}
      {summary && (
        <div className="card-flat" style={{ marginBottom: 24, padding: 24 }}>
          <h3 style={{ marginBottom: 16, fontSize: 18 }}>체크별 이슈 분포</h3>
          {checkIds.map((cid) => {
            const n = summary.by_check[cid] || 0;
            const max = Math.max(...Object.values(summary.by_check), 1);
            const width = `${(n / max) * 100}%`;
            // ink + rausch two-tier, no yellow
            const isAccent = cid === "#1" || cid === "#2" || cid === "#11";
            const isActive = checkFilter === cid;
            return (
              <div
                key={cid}
                onClick={() => setCheckFilter(isActive ? "" : cid)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 6,
                  fontSize: 13,
                  cursor: "pointer",
                  padding: "4px 8px",
                  borderRadius: "var(--radius-sm)",
                  backgroundColor: isActive ? "var(--color-surface-soft)" : "transparent",
                  transition: "background-color 0.15s ease",
                }}
                className="hover-bg-soft"
                title={`${checkNames[cid] ?? cid} 필터링 토글 (${n}개)`}
              >
                <span
                  style={{
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    width: 32,
                    textAlign: "right",
                    color: "var(--color-muted)",
                  }}
                >
                  {cid}
                </span>
                <span
                  style={{
                    width: 192,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--color-body)",
                  }}
                >
                  {checkNames[cid] ?? cid}
                </span>
                <div
                  style={{
                    flex: 1,
                    background: "var(--color-surface-soft)",
                    borderRadius: 4,
                    height: 8,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width,
                      height: "100%",
                      background: isAccent
                        ? "var(--color-primary)"
                        : "var(--color-ink)",
                      transition: "width 0.2s ease",
                    }}
                    title={`${n} issues`}
                  />
                </div>
                <span
                  style={{
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    width: 40,
                    textAlign: "right",
                    color: "var(--color-ink)",
                  }}
                >
                  {n}
                </span>
              </div>
            );
          })}
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
        <label style={{ fontSize: 13, color: "var(--color-muted)" }}>
          체크&nbsp;
          <select
            value={checkFilter}
            onChange={(e) => setCheckFilter(e.target.value)}
            style={{
              border: "1px solid var(--color-hairline-strong)",
              borderRadius: "var(--radius-full)",
              padding: "6px 14px",
              fontSize: 13,
              background: "var(--color-canvas)",
              color: "var(--color-ink)",
              fontFamily: "inherit",
              outline: "none",
            }}
          >
            <option value="">전체</option>
            {checkIds.map((cid) => (
              <option key={cid} value={cid}>
                {cid} {checkNames[cid] ?? cid}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13, color: "var(--color-muted)" }}>
          심각도&nbsp;
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value as LintSeverity | "")}
            style={{
              border: "1px solid var(--color-hairline-strong)",
              borderRadius: "var(--radius-full)",
              padding: "6px 14px",
              fontSize: 13,
              background: "var(--color-canvas)",
              color: "var(--color-ink)",
              fontFamily: "inherit",
              outline: "none",
            }}
          >
            <option value="">전체</option>
            <option value="critical">{SEVERITY_LABELS.critical}</option>
            <option value="warning">{SEVERITY_LABELS.warning}</option>
            <option value="info">{SEVERITY_LABELS.info}</option>
          </select>
        </label>
        <Button onClick={load} variant="secondary" size="sm" disabled={building}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ButtonIcon.Refresh />새로고침
          </span>
        </Button>
        <Button
          onClick={handleRebuild}
          variant="secondary"
          size="sm"
          disabled={building}
          id="rebuild-btn"
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              opacity: building ? 0.5 : 1,
              cursor: building ? "not-allowed" : "pointer",
            }}
          >
            {building ? "⌛" : "🔨"} wiki.db 리빌드
          </span>
        </Button>
        {buildResult && (
          <span
            style={{
              fontSize: 12,
              color: buildResult.build.ok
                ? "var(--color-primary)"
                : "var(--color-error-text)",
            }}
          >
            {buildResult.build.pages ?? "?"} pages · {buildResult.build.ok ? "✓ ok" : "✗ error"}
          </span>
        )}
        <label
          style={{
            fontSize: 13,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            color: "var(--color-muted)",
          }}
        >
          <input
            type="checkbox"
            checked={writeLog}
            onChange={(e) => setWriteLog(e.target.checked)}
            style={{ accentColor: "var(--color-primary)" }}
          />
          log 기록
        </label>
        {lastWriteResult && (
          <span style={{ fontSize: 12, color: "var(--color-primary)" }}>
            {lastWriteResult}
          </span>
        )}
      </div>

      {/* Issue list — data table with ink + rausch accent badges only */}
      {loading ? (
        <p className="text-muted">불러오는 중…</p>
      ) : !result ? (
        <p style={{ color: "var(--color-error-text)" }}>API 응답 실패</p>
      ) : result.issues.length === 0 ? (
        <EmptyState
          icon={<EmptyIcon.Check />}
          title="이슈 없음"
          description="현재 Vault에 등록된 마크다운 문서들 중 어떠한 무결성 린트 오류도 검출되지 않았습니다."
        />
      ) : (
        <div style={{ border: "1px solid var(--color-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
          {result.issues.slice(0, 200).map((iss, i) => (
            <IssueRow
              key={i}
              issue={iss}
              isLast={i === Math.min(199, result.issues.length - 1)}
              vault={vault}
            />
          ))}
          {result.issues.length > 200 && (
            <p
              style={{
                fontSize: 12,
                color: "var(--color-muted)",
                padding: 16,
                background: "var(--color-surface-soft)",
              }}
            >
              … +{result.issues.length - 200}개 더 있음 (필터로 좁히세요)
            </p>
          )}
        </div>
      )}

      <Toast open={Boolean(toast)} message={toast?.message ?? ""} type={toast?.type ?? "success"} />
    </div>
  );
}

function SeverityCard({
  label,
  count,
  isActive,
  onClick,
}: {
  label: LintSeverity;
  count: number;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        border: isActive ? "2px solid var(--color-primary)" : "1px solid var(--color-hairline)",
        borderRadius: "var(--radius-md)",
        padding: isActive ? "15px" : "16px",
        background: "var(--color-surface-soft)",
        cursor: "pointer",
        transition: "border-color 0.15s ease",
      }}
      title={`${label} 등급 필터 토글`}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.32px",
          textTransform: "uppercase",
          color: isActive ? "var(--color-primary)" : "var(--color-muted)",
        }}
      >
        {SEVERITY_LABELS[label]}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4, color: "var(--color-ink)" }}>
        {count}
      </div>
    </div>
  );
}

function IssueRow({
  issue,
  isLast,
  vault,
}: {
  issue: LintIssue;
  isLast: boolean;
  vault: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "12px 16px",
        fontSize: 13,
        borderBottom: isLast ? "none" : "1px solid var(--color-hairline)",
      }}
    >
      <span
        className="chip-strong"
        style={{
          background: issue.severity === "critical" ? "var(--color-primary)" : "var(--color-ink)",
        }}
      >
        {SEVERITY_LABELS[issue.severity]}
      </span>
      <span
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 11,
          fontWeight: 700,
          width: 32,
          color: "var(--color-muted)",
        }}
      >
        {issue.id}
      </span>
      <a
        href={`/page/${vault}/${issue.slug}`}
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 12,
          color: "var(--color-ink)",
          textDecoration: "underline",
          textUnderlineOffset: 2,
          maxWidth: 320,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={issue.slug}
      >
        {issue.slug}
      </a>
      <span style={{ flex: 1, fontSize: 13, color: "var(--color-body)" }}>{issue.message}</span>
    </div>
  );
}

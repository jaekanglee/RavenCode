// StatusDot — 상태를 나타내는 8px 점 (spec 2026-10-19-desktop-core-health-design).
// 색은 CSS 변수만 쓴다 (AGENTS.md §13.2).
export type StatusTone = "ok" | "warn" | "error" | "off";

const TONE_COLOR: Record<StatusTone, string> = {
  ok: "var(--color-success-text)",
  warn: "var(--color-warning-text)",
  error: "var(--color-danger-text)",
  off: "var(--color-muted)",
};

export function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: TONE_COLOR[tone] }}
    />
  );
}

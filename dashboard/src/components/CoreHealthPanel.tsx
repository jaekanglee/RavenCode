// CoreHealthPanel — 관리 화면의 백엔드 상태 (spec 2026-10-19-desktop-core-health-design).
//
// 셸의 core_status를 그대로 그린다: 프로세스, API·MCP 각각의 헬스체크 결과, 마지막 확인
// 시각, 최근 오류, 로그 폴더 열기. 판정은 셸의 헬스 모니터가 하고 이 컴포넌트는 표시만 한다.
import { Button } from "./ui/Button";
import { StatusDot, type StatusTone } from "./ui/StatusDot";

export interface CoreHealth {
  api: "ok" | "down" | "unknown";
  mcp: "ok" | "down" | "missing" | "off" | "unknown";
  phase: "healthy" | "recovering" | "gave_up";
  restarts: number;
  max_restarts: number;
  checked_at_ms: number | null;
  last_error: string | null;
  last_error_at_ms: number | null;
}

export interface CoreStatus {
  running: boolean;
  endpoint?: string | null;
  mcp_endpoint?: string | null;
  health?: CoreHealth;
  log_path?: string | null;
}

export interface CoreHealthPanelProps {
  status: CoreStatus | null;
  /** 지금 시각 (테스트 주입용). */
  now?: number;
  /** 있으면 "로그 폴더 열기" 버튼을 보여 준다. */
  onRevealLog?: () => void;
}

type ServiceState = { tone: StatusTone; label: string };

export function serviceState(state: CoreHealth["mcp"], health: CoreHealth): ServiceState {
  switch (state) {
    case "ok":
      return { tone: "ok", label: "정상" };
    case "off":
      return { tone: "off", label: "꺼짐 (설정)" };
    case "unknown":
      return { tone: "off", label: "확인 중" };
    case "missing":
    case "down":
      if (health.phase === "gave_up") return { tone: "error", label: "복구 실패" };
      if (health.phase === "recovering") {
        return { tone: "warn", label: `복구 중 (재시작 ${health.restarts}/${health.max_restarts})` };
      }
      return { tone: "error", label: state === "missing" ? "미기동" : "응답 없음" };
  }
}

export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 5) return "방금";
  if (seconds < 60) return `${seconds}초 전`;
  return `${Math.floor(seconds / 60)}분 전`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function ServiceRow({ name, state, detail }: { name: string; state: ServiceState; detail?: string | null }) {
  return (
    <div style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <StatusDot tone={state.tone} />
      <span style={{ fontWeight: 600, minWidth: 30 }}>{name}</span>
      <span>{state.label}</span>
      {detail && <span style={{ color: "var(--color-muted)", wordBreak: "break-all" }}>{detail}</span>}
    </div>
  );
}

export function CoreHealthPanel({ status, now = Date.now(), onRevealLog }: CoreHealthPanelProps) {
  const health = status?.health;
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-muted)", textTransform: "uppercase", marginBottom: 6 }}>
        백엔드 프로세스 상태
      </div>
      <div style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
        <StatusDot tone={status === null ? "off" : status.running ? "ok" : "error"} />
        <strong>{status === null ? "확인 중…" : status.running ? "실행 중" : "중지됨"}</strong>
      </div>
      {health && (
        <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
          <ServiceRow name="API" state={serviceState(health.api, health)} detail={status?.endpoint} />
          <ServiceRow name="MCP" state={serviceState(health.mcp, health)} detail={status?.mcp_endpoint} />
          <div style={{ fontSize: 11, color: "var(--color-muted)" }}>
            {health.checked_at_ms !== null ? `마지막 확인 ${formatAgo(now - health.checked_at_ms)}` : "아직 확인 전"}
            {health.last_error && health.last_error_at_ms !== null && (
              <>
                {" · 최근 오류 "}
                {clock(health.last_error_at_ms)} {health.last_error}
              </>
            )}
          </div>
        </div>
      )}
      {onRevealLog && status?.log_path && (
        <div style={{ marginTop: 8 }}>
          <Button variant="secondary" size="sm" onClick={onRevealLog}>
            로그 폴더 열기
          </Button>
        </div>
      )}
    </div>
  );
}

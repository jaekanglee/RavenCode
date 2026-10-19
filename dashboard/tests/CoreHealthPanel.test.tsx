/* 관리 화면 백엔드 상태 (spec 2026-10-19-desktop-core-health-design).
 *
 *  1. API·MCP를 따로, 셸 헬스체크 결과 그대로 그린다 — 프로세스가 살아 있다는 것만으로 "정상"이라 하지 않는다.
 *  2. 복구 중이면 재시작 횟수, 포기했으면 "복구 실패", 시작되지 않은 MCP는 "미기동", 설정으로 끈 MCP는 "꺼짐 (설정)".
 *  3. 마지막 확인 시각과 최근 오류. 로그 폴더 버튼은 셸이 로그 경로를 줄 때만.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CoreHealthPanel, type CoreHealth, type CoreStatus } from "../src/components/CoreHealthPanel";

const NOW = 1_760_000_000_000;

function status(health: Partial<CoreHealth>, extra: Partial<CoreStatus> = {}): CoreStatus {
  return {
    running: true,
    endpoint: "http://127.0.0.1:8765",
    mcp_endpoint: "http://127.0.0.1:8766/mcp",
    log_path: "/Users/me/Library/Logs/com.raven.local/core.log",
    health: {
      api: "ok",
      mcp: "ok",
      phase: "healthy",
      restarts: 0,
      max_restarts: 3,
      checked_at_ms: NOW - 7_000,
      last_error: null,
      last_error_at_ms: null,
      ...health,
    },
    ...extra,
  };
}

const row = (name: string) => screen.getByText(name).parentElement!.textContent;

describe("CoreHealthPanel", () => {
  it("shows API and MCP separately from the health check", () => {
    render(
      <CoreHealthPanel
        status={status({ mcp: "down", phase: "recovering", restarts: 2, last_error: "MCP 응답 없음: 연결 거부", last_error_at_ms: NOW - 20_000 })}
        now={NOW}
      />,
    );
    expect(screen.getByText("실행 중")).toBeTruthy();
    expect(row("API")).toContain("정상");
    expect(row("MCP")).toContain("복구 중 (재시작 2/3)");
    expect(screen.getByText(/마지막 확인 7초 전/)).toBeTruthy();
    expect(screen.getByText(/MCP 응답 없음: 연결 거부/)).toBeTruthy();
  });

  it("names a given-up recovery, an MCP that never started and an MCP turned off", () => {
    const gaveUp = render(<CoreHealthPanel status={status({ mcp: "missing", phase: "gave_up", restarts: 3 })} now={NOW} />);
    expect(row("MCP")).toContain("복구 실패");
    gaveUp.unmount();
    const missing = render(<CoreHealthPanel status={status({ mcp: "missing", phase: "healthy" })} now={NOW} />);
    expect(row("MCP")).toContain("미기동");
    missing.unmount();
    render(<CoreHealthPanel status={status({ mcp: "off" }, { mcp_endpoint: null })} now={NOW} />);
    expect(row("MCP")).toContain("꺼짐 (설정)");
  });

  it("offers the log folder only with a log path and a handler", () => {
    const onRevealLog = vi.fn();
    const withLog = render(<CoreHealthPanel status={status({})} now={NOW} onRevealLog={onRevealLog} />);
    fireEvent.click(screen.getByRole("button", { name: "로그 폴더 열기" }));
    expect(onRevealLog).toHaveBeenCalledTimes(1);
    withLog.unmount();
    render(<CoreHealthPanel status={status({}, { log_path: null })} now={NOW} onRevealLog={onRevealLog} />);
    expect(screen.queryByRole("button", { name: "로그 폴더 열기" })).toBeNull();
  });

  it("waits for the first status", () => {
    render(<CoreHealthPanel status={null} />);
    expect(screen.getByText("확인 중…")).toBeTruthy();
  });
});

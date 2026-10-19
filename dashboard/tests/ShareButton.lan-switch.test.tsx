/* 공유 팝오버에서 내부망 공개를 켜고 끈다 (2026-10-19).
 *
 * 배경: Core가 이 PC 전용(127.0.0.1)일 때도 팝오버가 내부망·Tailscale 링크를 복사할 수 있게
 * 보여 줬고, 경고는 "0.0.0.0으로 바인딩해야" 뿐이었다. 스위치는 관리 화면 안쪽에만 있었다.
 *
 *  1. 데스크톱 + 이 PC 전용 → 링크 대신 [내부망에 공개하기]. 누르면 셸이 공개하고 링크가 바로 나타난다.
 *  2. 공개 중 → 링크와 함께 누가 열 수 있는지(입장 승인 / 같은 tailnet) 알려 주고 [공개 끄기].
 *  3. 환경변수로 고정 → 버튼 없이 이유만.
 *  4. 셸 IPC는 팝오버를 열 때 한 번 — 페이지마다 붙는 버튼이 렌더마다 IPC를 부르면 안 된다.
 *  (브라우저 모드는 ShareButton.test.tsx가 지킨다 — 그대로다.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareButton } from "../src/components/ShareButton";
import * as api from "../src/lib/api";

const realConfirm = window.confirm;

function info(bind_host: string): api.SystemInfo {
  return {
    ok: true,
    tailscale_ip: "100.64.1.2",
    lan_ip: "192.168.1.42",
    local_api: "http://127.0.0.1:8765",
    local_mcp: "http://127.0.0.1:8765/mcp",
    lan_api: "http://192.168.1.42:8765",
    tailscale_api: "http://100.64.1.2:8765",
    tailscale_mcp: "http://100.64.1.2:8765/mcp",
    bind_host,
    allow_all_cors: false,
    port: 8765,
  };
}

/** 셸 흉내: 스위치 상태를 기억하고, 바꾸면 Core가 그 바인딩으로 다시 뜬 것처럼 system info를 바꾼다. */
function desktop({ enabled = false, envOverride = false } = {}) {
  let on = enabled;
  const sys = vi.spyOn(api, "fetchSystemInfo").mockImplementation(async () => info(on ? "0.0.0.0" : "127.0.0.1"));
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "lan_access_status") return { enabled: on, env_override: envOverride };
    if (cmd === "set_lan_access") {
      on = Boolean(args?.enabled);
      return null;
    }
    if (cmd === "core_endpoint") return "";
    return null;
  });
  (window as any).__TAURI_INTERNALS__ = { invoke };
  return { invoke, sys };
}

const LAN_URL = "http://192.168.1.42:8765/page/hub-control-room/concepts/foo";

function openPopover() {
  render(<ShareButton vault="hub-control-room" slug="concepts/foo" />);
  fireEvent.click(screen.getByRole("button", { name: "공유" }));
}

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  window.confirm = () => true;
});

afterEach(() => {
  window.confirm = realConfirm;
  delete (window as any).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("ShareButton — 내부망 공개 스위치 (데스크톱)", () => {
  it("이 PC 전용이면 링크 대신 공개 버튼을 보여 준다", async () => {
    desktop();
    openPopover();
    expect(await screen.findByRole("button", { name: "내부망에 공개하기" })).toBeTruthy();
    expect(screen.getByText(/지금은 이 PC에서만 열립니다/)).toBeTruthy();
    expect(screen.queryByText(LAN_URL)).toBeNull();
    expect(screen.queryByLabelText("내부망 링크 복사")).toBeNull();
  });

  it("공개하기를 누르면 셸이 공개하고 링크가 바로 나타난다", async () => {
    const { invoke } = desktop();
    openPopover();
    fireEvent.click(await screen.findByRole("button", { name: "내부망에 공개하기" }));
    expect(await screen.findByText(LAN_URL)).toBeTruthy();
    expect(invoke.mock.calls.find(([cmd]) => cmd === "set_lan_access")?.[1]).toEqual({ enabled: true });
    expect(screen.getByText(/입장 요청/)).toBeTruthy();
    expect(screen.getByText(/같은 tailnet/)).toBeTruthy();
  });

  it("공개 중이면 [공개 끄기]로 되돌린다", async () => {
    const { invoke } = desktop({ enabled: true });
    openPopover();
    expect(await screen.findByText(LAN_URL)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "공개 끄기" }));
    expect(await screen.findByRole("button", { name: "내부망에 공개하기" })).toBeTruthy();
    expect(invoke.mock.calls.find(([cmd]) => cmd === "set_lan_access")?.[1]).toEqual({ enabled: false });
    expect(screen.queryByText(LAN_URL)).toBeNull();
  });

  it("확인을 취소하면 아무것도 바꾸지 않는다", async () => {
    const { invoke } = desktop();
    window.confirm = () => false;
    openPopover();
    fireEvent.click(await screen.findByRole("button", { name: "내부망에 공개하기" }));
    expect(invoke.mock.calls.some(([cmd]) => cmd === "set_lan_access")).toBe(false);
  });

  it("환경변수로 고정돼 있으면 버튼 없이 이유를 보여 준다", async () => {
    desktop({ envOverride: true });
    openPopover();
    expect(await screen.findByText(/환경변수/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "내부망에 공개하기" })).toBeNull();
    expect(screen.queryByText(LAN_URL)).toBeNull();
  });

  it("셸에는 팝오버를 열 때 한 번만 묻는다", async () => {
    const { invoke } = desktop();
    render(<ShareButton vault="hub-control-room" slug="concepts/foo" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "공유" }));
    await screen.findByRole("button", { name: "내부망에 공개하기" });
    await new Promise((r) => setTimeout(r, 100));
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "lan_access_status")).toHaveLength(1);
  });
});

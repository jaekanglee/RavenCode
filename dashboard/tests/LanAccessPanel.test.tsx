/* 내부망 공개 스위치 (spec 2026-10-16-desktop-lan-toggle-design).
 *
 *  1. 셸의 lan_access_status로 상태를 그린다. 환경변수로 고정되면 스위치를 끈다.
 *  2. 스위치를 바꾸면 확인 후 set_lan_access({enabled}) — 엔드포인트가 바뀌면 onEndpointMoved.
 *  3. 0.0.0.0에 바인딩돼 있으면 Core의 lan_api를 공유 주소로 보여 준다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const realFetch = window.fetch;
const realConfirm = window.confirm;

function sysInfo(bind_host: string, lan_api: string | null) {
  window.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, bind_host, lan_api }), { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.resetModules();
  window.confirm = () => true;
});

afterEach(() => {
  window.fetch = realFetch;
  window.confirm = realConfirm;
});

describe("LanAccessPanel", () => {
  it("turns the switch on and restarts through the shell", async () => {
    sysInfo("127.0.0.1", null);
    const calls: [string, unknown][] = [];
    let enabled = false;
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === "lan_access_status") return { enabled, env_override: false };
      if (cmd === "set_lan_access") {
        enabled = Boolean(args?.enabled);
        sysInfo("0.0.0.0", "http://10.10.80.38:8765");
        return null;
      }
      if (cmd === "core_endpoint") return "";
      return null;
    });
    const { LanAccessPanel } = await import("../src/components/LanAccessPanel");
    const moved = vi.fn();
    render(<LanAccessPanel invoke={invoke} onEndpointMoved={moved} />);
    const sw = (await screen.findByRole("switch", { name: "내부망 공개" })) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    expect((await screen.findByTestId("lan-api")).textContent).toBe("http://10.10.80.38:8765");
    expect(calls.find(([c]) => c === "set_lan_access")?.[1]).toEqual({ enabled: true });
    expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(true);
    expect(moved).not.toHaveBeenCalled();
  });

  it("reloads when the restarted Core moved", async () => {
    sysInfo("127.0.0.1", null);
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "lan_access_status") return { enabled: false, env_override: false };
      if (cmd === "core_endpoint") return "http://127.0.0.1:50123";
      return null;
    });
    const { setApiBase } = await import("../src/lib/api-base");
    setApiBase("http://127.0.0.1:8765");
    const { LanAccessPanel } = await import("../src/components/LanAccessPanel");
    const moved = vi.fn();
    render(<LanAccessPanel invoke={invoke} onEndpointMoved={moved} />);
    fireEvent.click(await screen.findByRole("switch"));
    await waitFor(() => expect(moved).toHaveBeenCalled());
  });

  it("is fixed by the environment", async () => {
    sysInfo("100.64.1.2", null);
    const invoke = vi.fn(async (cmd: string) => (cmd === "lan_access_status" ? { enabled: true, env_override: true } : null));
    const { LanAccessPanel } = await import("../src/components/LanAccessPanel");
    render(<LanAccessPanel invoke={invoke} />);
    const sw = (await screen.findByRole("switch")) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(screen.getByText("환경변수로 고정됨")).toBeTruthy();
    expect(screen.queryByTestId("lan-api")).toBeNull();
  });

  it("does nothing when the confirm is cancelled", async () => {
    sysInfo("127.0.0.1", null);
    window.confirm = () => false;
    const invoke = vi.fn(async (cmd: string) => (cmd === "lan_access_status" ? { enabled: false, env_override: false } : null));
    const { LanAccessPanel } = await import("../src/components/LanAccessPanel");
    render(<LanAccessPanel invoke={invoke} />);
    fireEvent.click(await screen.findByRole("switch"));
    expect(invoke.mock.calls.some(([c]) => c === "set_lan_access")).toBe(false);
  });

  it("shows an error when the shell refuses", async () => {
    sysInfo("127.0.0.1", null);
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "lan_access_status") return { enabled: false, env_override: false };
      if (cmd === "set_lan_access") throw new Error("설정을 저장할 수 없습니다");
      return null;
    });
    const { LanAccessPanel } = await import("../src/components/LanAccessPanel");
    render(<LanAccessPanel invoke={invoke} />);
    fireEvent.click(await screen.findByRole("switch"));
    expect(await screen.findByText(/바꾸지 못했습니다: 설정을 저장할 수 없습니다/)).toBeTruthy();
  });
});

/* 상단 "🌐 내부망 공개 중" 표시 (2026-10-19).
 *
 * 배경: 공개는 문서 단위가 아니라 Raven 전체 단위다. 켜 둔 채 다른 문서를 보다 보면 열려 있다는 걸
 * 잊는데, 다시 확인하고 끄려면 공유 창이나 관리 화면을 찾아 들어가야 했다.
 *
 *  1. 데스크톱 + 실제로 열려 있을 때(bind가 loopback이 아님)만 보인다. 브라우저·이 PC 전용이면 없다.
 *  2. 누르면 무엇이 열려 있는지(주소)와 누가 들어올 수 있는지(승인된 손님·vault 권한)를 보여 주고 끌 수 있다.
 *  3. 환경변수로 고정된 공개는 끌 수 없다고 말한다.
 *  4. 다른 화면(관리 스위치·공유 창)에서 바꿔도 바로 따라 바뀐다.
 *  5. 셸에는 처음에 한 번만 묻는다 (렌더마다 IPC 금지 — 2026-10-19 36GB 루프).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as api from "../src/lib/api";
import * as guest from "../src/lib/guest";
import { LanAccessIndicator } from "../src/components/LanAccessIndicator";
import { LanAccessPanel } from "../src/components/LanAccessPanel";

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

const GRANTS: guest.GuestGrant[] = [
  { id: "g1", name: "홍길동", device_id: "d_1", ip: "10.0.0.7", vaults: { "rider-app": ["read"] }, created: "", expires: null, last_seen: null },
  { id: "g2", name: "김철수", device_id: "d_2", ip: "10.0.0.8", vaults: { "hub-control-room": ["read", "create"] }, created: "", expires: null, last_seen: null },
];

/** 셸 흉내: 스위치를 바꾸면 Core가 그 바인딩으로 다시 뜬 것처럼 system info도 바뀐다. */
function desktop({ enabled = false, envBind }: { enabled?: boolean; envBind?: string } = {}) {
  let on = enabled;
  vi.spyOn(api, "fetchSystemInfo").mockImplementation(async () => info(envBind ?? (on ? "0.0.0.0" : "127.0.0.1")));
  vi.spyOn(guest, "listGuestGrants").mockResolvedValue(GRANTS);
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "lan_access_status") return { enabled: on, env_override: envBind !== undefined };
    if (cmd === "set_lan_access") {
      on = Boolean(args?.enabled);
      return null;
    }
    if (cmd === "core_endpoint") return "";
    return null;
  });
  (window as any).__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

function show(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

const PILL = { name: /내부망 공개 중/ };

beforeEach(() => {
  window.confirm = () => true;
});

afterEach(() => {
  window.confirm = realConfirm;
  delete (window as any).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("LanAccessIndicator", () => {
  it("이 PC 전용이면 아무것도 보이지 않는다", async () => {
    const invoke = desktop();
    show(<LanAccessIndicator />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button", PILL)).toBeNull();
  });

  it("브라우저(데스크톱 앱 아님)에서는 열려 있어도 보이지 않는다", async () => {
    vi.spyOn(api, "fetchSystemInfo").mockResolvedValue(info("0.0.0.0"));
    show(<LanAccessIndicator />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button", PILL)).toBeNull();
  });

  it("열려 있으면 무엇이 열렸고 누가 들어올 수 있는지 보여 주고, 끄면 사라진다", async () => {
    const invoke = desktop({ enabled: true });
    show(<LanAccessIndicator />);
    fireEvent.click(await screen.findByRole("button", PILL));
    expect(await screen.findByText("http://192.168.1.42:8765")).toBeTruthy();
    expect(await screen.findByText(/승인된 손님 2명/)).toBeTruthy();
    expect(screen.getByText(/홍길동/).textContent).toContain("rider-app(읽기)");
    expect(screen.getByText(/김철수/).textContent).toContain("hub-control-room(읽기·작성)");
    fireEvent.click(screen.getByRole("button", { name: "공개 끄기" }));
    await waitFor(() => expect(screen.queryByRole("button", PILL)).toBeNull());
    expect(invoke.mock.calls.find(([cmd]) => cmd === "set_lan_access")?.[1]).toEqual({ enabled: false });
  });

  it("환경변수로 고정된 공개는 끌 수 없다고 말한다", async () => {
    desktop({ envBind: "0.0.0.0" });
    show(<LanAccessIndicator />);
    fireEvent.click(await screen.findByRole("button", PILL));
    expect(await screen.findByText(/환경변수/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "공개 끄기" })).toBeNull();
  });

  it("관리 화면 스위치로 켜면 바로 나타난다", async () => {
    desktop();
    show(
      <>
        <LanAccessIndicator />
        <LanAccessPanel />
      </>,
    );
    const sw = (await screen.findByRole("switch", { name: "내부망 공개" })) as HTMLInputElement;
    expect(screen.queryByRole("button", PILL)).toBeNull();
    fireEvent.click(sw);
    expect(await screen.findByRole("button", PILL)).toBeTruthy();
  });

  it("셸에는 처음에 한 번만 묻는다", async () => {
    const invoke = desktop({ enabled: true });
    show(<LanAccessIndicator />);
    await screen.findByRole("button", PILL);
    await new Promise((r) => setTimeout(r, 100));
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "lan_access_status")).toHaveLength(1);
  });
});

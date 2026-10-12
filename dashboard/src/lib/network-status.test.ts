import { describe, expect, it } from "vitest";
import type { SystemInfo } from "./api";
import { describeTailnetAccess, type NetworkStatus } from "./network-status";

const base: SystemInfo = {
  ok: true,
  tailscale_ip: "100.64.1.2",
  lan_ip: null,
  local_api: "http://127.0.0.1:8765",
  local_mcp: "http://127.0.0.1:8765/mcp",
  lan_api: null,
  tailscale_api: "http://100.64.1.2:8765",
  tailscale_mcp: "http://100.64.1.2:8765/mcp",
  bind_host: "0.0.0.0",
  allow_all_cors: false,
  port: 8765,
};

function net(over: Partial<NetworkStatus> = {}): NetworkStatus {
  return {
    tailscale: { state: "ip", ip: "100.64.1.2", detail: "", checked_at: 1 },
    api: {
      bind_host: "0.0.0.0",
      port: 8765,
      endpoint_host: "127.0.0.1",
      tailnet: { address: "100.64.1.2:8765", state: "protected", detail: "" },
      restart_requested: false,
    },
    mcp: {
      bind_host: "0.0.0.0",
      port: 8766,
      advertised: "100.64.1.2",
      tailnet: { address: "100.64.1.2:8766", state: "protected", detail: "" },
    },
    problems: [],
    ...over,
  };
}

describe("describeTailnetAccess (Issue #58)", () => {
  it("keeps the old fields when the server reports no network state", () => {
    const a = describeTailnetAccess({ ...base, network: null });
    expect(a.known).toBe(false);
    expect(a.api.url).toBe("http://100.64.1.2:8765");
  });

  it("shows tailnet URLs only for addresses the Core holds, MCP on its own port", () => {
    const a = describeTailnetAccess({ ...base, network: net() });
    expect(a.api.url).toBe("http://100.64.1.2:8765");
    expect(a.mcp.url).toBe("http://100.64.1.2:8766/mcp");
    expect(a.localMcp).toBe("http://127.0.0.1:8766/mcp");
  });

  it("does not offer a tailnet API URL when the API listens on loopback only", () => {
    const n = net();
    n.api.bind_host = "127.0.0.1";
    n.api.tailnet = { address: "100.64.1.2:8765", state: "not_listening", detail: "bound to 127.0.0.1" };
    const a = describeTailnetAccess({ ...base, bind_host: "127.0.0.1", network: n });
    expect(a.api.url).toBeNull();
    expect(a.api.reason).toContain("127.0.0.1에만 bind");
  });

  it("never offers an address another process holds, and says so", () => {
    const n = net({ problems: ["MCP 100.64.1.2:8766 blocked: bind: Address already in use"] });
    n.mcp!.advertised = "127.0.0.1";
    n.mcp!.tailnet = { address: "100.64.1.2:8766", state: "blocked", detail: "bind" };
    const a = describeTailnetAccess({ ...base, network: n });
    expect(a.mcp.url).toBeNull();
    expect(a.mcp.reason).toContain("다른 프로세스");
    expect(a.problems).toHaveLength(1);
  });

  it("does not trust a fresh IP whose MCP is still advertised elsewhere", () => {
    const n = net();
    n.tailscale = { state: "ip", ip: "100.64.9.9", detail: "", checked_at: 2 };
    n.mcp!.tailnet = { address: "100.64.9.9:8766", state: "pending", detail: "" };
    const a = describeTailnetAccess({ ...base, tailscale_ip: "100.64.9.9", network: n });
    expect(a.tailscaleIp).toBe("100.64.9.9");
    expect(a.mcp.url).toBeNull();
  });

  it("reports no tailnet when the lookup finds none", () => {
    const n = net({ tailscale: { state: "none", ip: null, detail: "", checked_at: 3 } });
    n.api.tailnet = null;
    n.mcp!.tailnet = null;
    n.mcp!.advertised = "127.0.0.1";
    const a = describeTailnetAccess({ ...base, network: n });
    expect(a.tailscaleIp).toBeNull();
    expect(a.api.reason).toBe("Tailscale 연결 없음");
    expect(a.mcp.url).toBeNull();
  });
});

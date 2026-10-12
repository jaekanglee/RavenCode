/**
 * Issue #58: what the Desktop Core's *actual* sockets mean for tailnet access.
 *
 * `GET /api/system/info` → `network` is the Core's live state (null on other
 * launchers). A detected Tailscale IP alone does not mean anything listens
 * there: the API may be bound to loopback, the address may be held by another
 * process, or the guard may not be in place yet. Only an address the Core
 * reports as `protected` is shown as an endpoint to copy.
 */
import type { SystemInfo } from "./api";

export type TailnetState = "protected" | "blocked" | "pending" | "error" | "not_listening";

export interface TailnetListener {
  address: string;
  state: TailnetState;
  detail: string;
}

export interface NetworkStatus {
  tailscale: { state: "ip" | "none" | "error"; ip: string | null; detail: string; checked_at: number | null } | null;
  api: { bind_host: string; port: number; endpoint_host: string; tailnet: TailnetListener | null; restart_requested: boolean };
  mcp: { bind_host: string | null; port: number; advertised: string | null; tailnet: TailnetListener | null } | null;
  problems: string[];
}

export interface Endpoint {
  url: string | null;
  /** Why there is no tailnet URL (null when there is one). */
  reason: string | null;
}

export interface TailnetAccess {
  /** False when the server does not report its network state (standalone API). */
  known: boolean;
  tailscaleIp: string | null;
  api: Endpoint;
  mcp: Endpoint;
  /** Local MCP URL (the desktop MCP has its own port; not the API's). */
  localMcp: string;
  problems: string[];
}

const LOOPBACK = "127.0.0.1";

function unavailable(listener: TailnetListener | null, bindHost: string | null | undefined): string {
  if (listener === null) return "Tailscale 연결 없음";
  switch (listener.state) {
    case "not_listening":
      return `${bindHost ?? "다른 주소"}에만 bind되어 tailnet에서 접속할 수 없습니다`;
    case "blocked":
      return "다른 프로세스가 이 주소를 잡고 있어 보호하지 못했습니다 — 그 프로세스를 확인하세요";
    case "pending":
      return "주소 보호를 준비하는 중입니다";
    default:
      return `아직 보호되지 않았습니다${listener.detail ? ` (${listener.detail})` : ""}`;
  }
}

export function describeTailnetAccess(info: (SystemInfo & { network?: NetworkStatus | null }) | null): TailnetAccess {
  const network = info?.network ?? null;
  if (!info || !network) {
    return {
      known: false,
      tailscaleIp: info?.tailscale_ip ?? null,
      api: { url: info?.tailscale_api ?? null, reason: null },
      mcp: { url: info?.tailscale_mcp ?? null, reason: null },
      localMcp: info?.local_mcp ?? `http://${LOOPBACK}:8765/mcp`,
      problems: [],
    };
  }
  const tailscaleIp = network.tailscale?.state === "ip" ? network.tailscale.ip : null;
  const apiTailnet = network.api.tailnet;
  const api: Endpoint =
    apiTailnet?.state === "protected"
      ? { url: `http://${apiTailnet.address}`, reason: null }
      : { url: null, reason: unavailable(apiTailnet, network.api.bind_host) };
  let mcp: Endpoint;
  if (!network.mcp) {
    mcp = { url: null, reason: "MCP가 꺼져 있습니다" };
  } else if (
    network.mcp.advertised &&
    network.mcp.advertised !== LOOPBACK &&
    network.mcp.tailnet?.state === "protected" &&
    network.mcp.tailnet.address === `${network.mcp.advertised}:${network.mcp.port}`
  ) {
    mcp = { url: `http://${network.mcp.advertised}:${network.mcp.port}/mcp`, reason: null };
  } else {
    mcp = { url: null, reason: unavailable(network.mcp.tailnet, network.mcp.bind_host) };
  }
  return {
    known: true,
    tailscaleIp,
    api,
    mcp,
    localMcp: network.mcp ? `http://${LOOPBACK}:${network.mcp.port}/mcp` : `http://${LOOPBACK}:${network.api.port}/mcp`,
    problems: network.problems ?? [],
  };
}

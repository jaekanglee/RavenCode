/* Issue #67 review — the dashboard error reporter must not report its own requests.
 *
 * /api/debug-log answers 404 by default (#19) and 401 without a token (#67). The
 * reporter sends through the authenticating fetch and reports other requests' 4xx/5xx;
 * if it reported its own failure it would loop for as long as the page is open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("client debug log", () => {
  const realFetch = window.fetch;
  let calls: string[];
  let status: (url: string) => number;

  beforeEach(() => {
    vi.resetModules();
    calls = [];
    status = () => 404;
    window.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      calls.push(url);
      return new Response("{}", { status: status(url) });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    window.fetch = realFetch;
  });

  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("reports another request's 404 exactly once, even when the log endpoint itself 404s", async () => {
    const { installClientDebugLog } = await import("../src/lib/client-debug-log");
    installClientDebugLog(window as Window & typeof globalThis);
    await window.fetch("/api/vaults/x/raw");
    await settle();
    expect(calls).toEqual(["/api/vaults/x/raw", "/api/debug-log"]);
  });

  it("never reports a failure of /api/debug-log itself (401 or thrown)", async () => {
    const { installClientDebugLog } = await import("../src/lib/client-debug-log");
    installClientDebugLog(window as Window & typeof globalThis);
    status = () => 401;
    await window.fetch("/api/debug-log", { method: "POST", body: "{}" });
    await settle();
    expect(calls).toEqual(["/api/debug-log"]);
  });

  it("sends through the fetch that was installed before it (the authenticating wrapper)", async () => {
    const authed = window.fetch;
    const { installClientDebugLog } = await import("../src/lib/client-debug-log");
    installClientDebugLog(window as Window & typeof globalThis);
    await window.fetch("/api/missing");
    await settle();
    expect((authed as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0])).toEqual([
      "/api/missing",
      "/api/debug-log",
    ]);
  });
});

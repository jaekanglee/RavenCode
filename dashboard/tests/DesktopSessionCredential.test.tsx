/* Issue #67 — the desktop shell's per-launch Core API credential in the webview.
 *
 *  The Core API needs `Authorization: Bearer` from loopback too. The desktop shell
 *  hands its webview one credential over Tauri IPC (`core_session_token`); the
 *  dashboard must
 *   - send it only to the desktop Core's own endpoint (never another host, never a
 *     look-alike origin, never a relative/vite request),
 *   - keep it in memory only (no sessionStorage/localStorage, never in a URL),
 *   - drop it and fall back to the token dialog when the Core refuses it,
 *   - not override an explicit Authorization header.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function res(status: number, headers: Record<string, string> = {}, body = "{}") {
  return new Response(body, { status, headers });
}

type Call = { input: RequestInfo | URL; init?: RequestInit };

const CORE = "http://127.0.0.1:8765";
const OTHER = "http://100.88.1.2:8765";
const SECRET = "rvs_" + "a".repeat(64);

describe("desktop session credential", () => {
  let calls: Call[];
  let next: () => Response;
  const realFetch = window.fetch;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.resetModules();
    calls = [];
    next = () => res(200);
    window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return next();
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    window.fetch = realFetch;
  });

  function auth(i: number): string | null {
    const { input, init } = calls[i];
    if (input instanceof Request) return input.headers.get("authorization");
    return new Headers(init?.headers).get("authorization");
  }

  function urlOf(i: number): string {
    const { input } = calls[i];
    return input instanceof Request ? input.url : String(input);
  }

  async function desktop() {
    const hostAuth = await import("../src/lib/host-auth");
    const apiBase = await import("../src/lib/api-base");
    apiBase.setApiBase(CORE);
    hostAuth.setSessionCredential(CORE, SECRET);
    return { hostAuth, apiBase };
  }

  it("authenticates /api calls to the desktop Core with the session credential", async () => {
    await desktop();
    await window.fetch("/api/vaults");
    expect(urlOf(0)).toBe(`${CORE}/api/vaults`);
    expect(auth(0)).toBe(`Bearer ${SECRET}`);
  });

  it("matches the Core's base canonically (trailing slash, case)", async () => {
    const { hostAuth } = await desktop();
    expect(hostAuth.authHeaderFor("http://127.0.0.1:8765/")).toBe(`Bearer ${SECRET}`);
    expect(hostAuth.authHeaderFor("HTTP://127.0.0.1:8765")).toBe(`Bearer ${SECRET}`);
  });

  it("never sends it to another host, a look-alike origin or the dashboard's own origin", async () => {
    const { hostAuth } = await desktop();
    for (const base of [OTHER, "http://127.0.0.1:8766", "http://localhost:8765", "https://127.0.0.1:8765", ""]) {
      expect(hostAuth.authHeaderFor(base)).toBeNull();
    }
    await window.fetch(`${OTHER}/api/vaults`);
    await window.fetch(new Request("http://evil.example/api/vaults"));
    expect(auth(0)).toBeNull();
    expect(auth(1)).toBeNull();
  });

  it("is kept in memory only — no storage, no URL", async () => {
    await desktop();
    await window.fetch("/api/vaults?x=1");
    const stored = [
      ...Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k) ?? ""),
      ...Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? ""),
    ].join("\n");
    expect(stored).not.toContain(SECRET);
    expect(urlOf(0)).not.toContain(SECRET);
  });

  it("does not override an explicit Authorization header", async () => {
    await desktop();
    await window.fetch("/api/vaults", { headers: { Authorization: "Bearer rvn_own" } });
    expect(auth(0)).toBe("Bearer rvn_own");
  });

  it("a refused credential is dropped and the token dialog is asked for", async () => {
    const { hostAuth } = await desktop();
    const asked: string[] = [];
    window.addEventListener(hostAuth.AUTH_REQUIRED_EVENT, (e) => asked.push((e as CustomEvent).detail.base));
    next = () => res(401, { "WWW-Authenticate": 'Bearer realm="raven"' });
    await window.fetch("/api/vaults");
    expect(hostAuth.authHeaderFor(CORE)).toBeNull();
    expect(asked).toContain(CORE);
    // a token the user then enters is used from now on
    next = () => res(200);
    hostAuth.setHostToken(CORE, "rvn_entered");
    await window.fetch("/api/vaults");
    expect(auth(1)).toBe("Bearer rvn_entered");
  });

  it("a stored host token is not dropped when the session credential is refused", async () => {
    const { hostAuth } = await desktop();
    hostAuth.setHostToken(OTHER, "rvn_other");
    next = () => res(401, { "WWW-Authenticate": 'Bearer realm="raven"' });
    await window.fetch("/api/vaults");
    expect(hostAuth.getHostToken(OTHER)).toBe("rvn_other");
  });

  it("without a desktop credential (vite, browser) nothing is attached until the user enters a token", async () => {
    await import("../src/lib/host-auth");
    await import("../src/lib/api-base");
    await window.fetch("/api/vaults");
    expect(auth(0)).toBeNull();
  });
});

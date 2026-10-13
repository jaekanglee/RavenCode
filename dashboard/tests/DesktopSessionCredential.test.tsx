/* Issue #67 — the desktop shell's per-Core API credential in the webview.
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

describe("desktop session credential after a Core restart (rotation)", () => {
  const realFetch = window.fetch;
  let seen: (string | null)[];
  let accept: string;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.resetModules();
    seen = [];
    accept = "rvs_" + "b".repeat(64);
    window.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      seen.push(auth);
      return auth === `Bearer ${accept}`
        ? new Response("{}", { status: 200 })
        : new Response("{}", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="raven"' } });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    window.fetch = realFetch;
  });

  async function desktop(refresh: () => Promise<{ endpoint: string; token: string } | null>) {
    const hostAuth = await import("../src/lib/host-auth");
    const apiBase = await import("../src/lib/api-base");
    apiBase.setApiBase(CORE);
    hostAuth.setSessionCredential(CORE, SECRET); // the old Core's credential
    hostAuth.setSessionRefresher(refresh);
    return hostAuth;
  }

  it("fetches the new credential from the shell and retries once — no dialog", async () => {
    const hostAuth = await desktop(async () => ({ endpoint: CORE, token: accept }));
    const asked: string[] = [];
    window.addEventListener(hostAuth.AUTH_REQUIRED_EVENT, (e) => asked.push((e as CustomEvent).detail.base));
    const res = await window.fetch("/api/vaults");
    expect(res.status).toBe(200);
    expect(seen).toEqual([`Bearer ${SECRET}`, `Bearer ${accept}`]);
    expect(hostAuth.authHeaderFor(CORE)).toBe(`Bearer ${accept}`);
    expect(asked).toEqual([]);
  });

  it("the old credential is never sent again after rotation", async () => {
    await desktop(async () => ({ endpoint: CORE, token: accept }));
    await window.fetch("/api/vaults");
    await window.fetch("/api/vaults");
    expect(seen.slice(2)).toEqual([`Bearer ${accept}`]);
  });

  it("same credential from the shell (not a restart) → no retry, token dialog", async () => {
    const hostAuth = await desktop(async () => ({ endpoint: CORE, token: SECRET }));
    const asked: string[] = [];
    window.addEventListener(hostAuth.AUTH_REQUIRED_EVENT, (e) => asked.push((e as CustomEvent).detail.base));
    const res = await window.fetch("/api/vaults");
    expect(res.status).toBe(401);
    expect(seen.length).toBe(1);
    expect(asked).toContain(CORE);
  });

  it("shell has no credential (CSPRNG failure / IPC error) → token dialog, one request", async () => {
    const hostAuth = await desktop(async () => {
      throw new Error("this Core has no session credential");
    });
    const asked: string[] = [];
    window.addEventListener(hostAuth.AUTH_REQUIRED_EVENT, (e) => asked.push((e as CustomEvent).detail.base));
    expect((await window.fetch("/api/vaults")).status).toBe(401);
    expect(seen.length).toBe(1);
    expect(asked).toContain(CORE);
  });

  it("concurrent 401s after a restart: one IPC call, the new credential survives, no dialog", async () => {
    let calls = 0;
    const hostAuth = await desktop(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { endpoint: CORE, token: accept };
    });
    const asked: string[] = [];
    window.addEventListener(hostAuth.AUTH_REQUIRED_EVENT, (e) => asked.push((e as CustomEvent).detail.base));
    const [a, b, c] = await Promise.all([window.fetch("/api/a"), window.fetch("/api/b"), window.fetch("/api/c")]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(calls).toBe(1);
    expect(hostAuth.authHeaderFor(CORE)).toBe(`Bearer ${accept}`);
    expect(asked).toEqual([]);
  });

  it("a late 401 for the old credential after rotation retries with the new one, IPC not asked", async () => {
    let calls = 0;
    const hostAuth = await desktop(async () => {
      calls += 1;
      return { endpoint: CORE, token: accept };
    });
    hostAuth.setSessionCredential(CORE, accept); // another request already rotated it
    expect(await hostAuth.refreshSessionCredential(CORE, `Bearer ${SECRET}`)).toBe(true); // retry with current
    expect(calls).toBe(0); // no IPC call for a stale 401
    expect(hostAuth.releaseRefusedSession(CORE, `Bearer ${SECRET}`)).toBe("stale");
    expect(hostAuth.authHeaderFor(CORE)).toBe(`Bearer ${accept}`); // the new one is not wiped
    expect(hostAuth.releaseRefusedSession(CORE, `Bearer ${accept}`)).toBe("cleared");
    expect(hostAuth.authHeaderFor(CORE)).toBeNull();
  });

  it("after a port move the new credential is not sent to whoever holds the old port", async () => {
    const hostAuth = await desktop(async () => ({ endpoint: "http://127.0.0.1:54321", token: accept }));
    const res = await window.fetch("/api/vaults");
    expect(res.status).toBe(401);
    expect(seen).toEqual([`Bearer ${SECRET}`]); // no retry to the old base
    expect(hostAuth.authHeaderFor(CORE)).toBeNull(); // the refused one is dropped → dialog
  });

  it("a stream body is not replayed", async () => {
    await desktop(async () => ({ endpoint: CORE, token: accept }));
    const body = new ReadableStream();
    const res = await window.fetch("/api/vaults/x/pages", { method: "POST", body, duplex: "half" } as RequestInit);
    expect(res.status).toBe(401);
    expect(seen.length).toBe(1);
  });
});

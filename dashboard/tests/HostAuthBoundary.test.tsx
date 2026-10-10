/* PR #25 review — browser-side auth boundary of the per-host token wrapper.
 *
 *  A. Request objects get the same treatment as string URLs (URL, explicit
 *     Authorization, credentials, signal, body and method preserved).
 *  B. Tokens are isolated per exact origin: A's token only to A, B's only to B,
 *     nothing to C or to look-alike hosts/ports/schemes; host keys are canonical
 *     (case, default port) so the right host still gets its token.
 *  C. A request carrying an auto-attached token never follows a redirect.
 *  D. Storage failure is not reported as success; a refused stored token is dropped;
 *     only the active host prompts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

function res(status: number, headers: Record<string, string> = {}, body = "{}") {
  return new Response(body, { status, headers });
}

type Call = { input: RequestInfo | URL; init?: RequestInit };

const A = "http://100.88.1.2:8765";
const B = "http://100.88.1.3:8765";

describe("fetch wrapper boundary", () => {
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

  function activate(endpoint: string) {
    localStorage.setItem("raven:hosts", JSON.stringify([
      { id: "local", name: "local", endpoint: "", isLocal: true },
      { id: "a", name: "a", endpoint: A, isLocal: false },
      { id: "b", name: "b", endpoint: B, isLocal: false },
    ]));
    localStorage.setItem("raven:active_host", endpoint === A ? "a" : endpoint === B ? "b" : "local");
  }

  async function setup() {
    const hostAuth = await import("../src/lib/host-auth");
    await import("../src/lib/api-base");
    return hostAuth;
  }

  // ── A. Request objects ──

  it("authenticates a Request object for its exact origin and keeps its fields", async () => {
    const { setHostToken } = await setup();
    setHostToken(A, "rvn_tok_a");
    // (signal: jsdom's AbortSignal is not the Request implementation's — checked in the browser E2E)
    await window.fetch(new Request(`${A}/api/vaults/x/pages`, {
      method: "POST", body: '{"t":1}', credentials: "include",
      headers: { "Content-Type": "application/json" },
    }));
    const req = calls[0].input as Request;
    expect(req).toBeInstanceOf(Request);
    expect(req.url).toBe(`${A}/api/vaults/x/pages`);
    expect(req.method).toBe("POST");
    expect(req.credentials).toBe("include");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.text()).toBe('{"t":1}');
    expect(auth(0)).toBe("Bearer rvn_tok_a");
    expect(req.redirect).toBe("error");
  });

  it("keeps a Request object's own Authorization header and redirect mode", async () => {
    const { setHostToken } = await setup();
    setHostToken(A, "rvn_tok_a");
    await window.fetch(new Request(`${A}/api/vaults`, { headers: { Authorization: "Bearer rvn_own" } }));
    expect(auth(0)).toBe("Bearer rvn_own");
    expect((calls[0].input as Request).redirect).toBe("follow");
  });

  it("never attaches a token to a Request for a host without one", async () => {
    const { setHostToken } = await setup();
    setHostToken(A, "rvn_tok_a");
    await window.fetch(new Request(`${B}/api/vaults`));
    await window.fetch(new Request("http://evil.example/api/vaults"));
    expect(auth(0)).toBeNull();
    expect(auth(1)).toBeNull();
  });

  it("a relative Request goes to the dashboard origin with that origin's token only", async () => {
    activate(A);
    const { setHostToken } = await setup();
    setHostToken("", "rvn_local");
    setHostToken(A, "rvn_tok_a");
    // a browser resolves new Request("/api/vaults") against the page; Node's Request cannot
    await window.fetch(new Request(`${window.location.origin}/api/vaults`));
    expect(urlOf(0)).toBe(`${window.location.origin}/api/vaults`);
    expect(auth(0)).toBe("Bearer rvn_local");
  });

  // ── B. Isolation ──

  it("isolates A, B and C tokens across hosts and look-alikes", async () => {
    const { setHostToken } = await setup();
    setHostToken(A, "rvn_tok_a");
    setHostToken(B, "rvn_tok_b");
    const targets: [string, string | null][] = [
      [`${A}/api/vaults`, "Bearer rvn_tok_a"],
      [`${B}/api/vaults`, "Bearer rvn_tok_b"],
      ["http://100.88.1.4:8765/api/vaults", null],          // C: no token
      ["http://100.88.1.20:8765/api/vaults", null],         // prefix look-alike
      ["http://100.88.1.2:87650/api/vaults", null],         // other port
      ["https://100.88.1.2:8765/api/vaults", null],         // other scheme
      ["http://100.88.1.2.evil.example:8765/api/vaults", null], // suffix look-alike
      ["http://sub.100.88.1.2:8765/api/vaults", null],
      [`http://100.88.1.2:8765@evil.example/api/vaults`, null], // userinfo trick
      ["//100.88.1.2:8765/api/vaults", null],               // protocol-relative
    ];
    for (const [url] of targets) await window.fetch(url);
    targets.forEach(([url, want], i) => expect([url, auth(i)]).toEqual([url, want]));
  });

  it("uses the new host's token on the very first request after a switch", async () => {
    // Issue #32: a switch applies on the reload that always follows it (HostPicker, or
    // tab-host-sync for another tab's switch); until then the tab stays on its host.
    const baseFetch = window.fetch;
    activate(A);
    const { setHostToken } = await setup();
    setHostToken(A, "rvn_tok_a");
    setHostToken(B, "rvn_tok_b");
    await window.fetch("/api/vaults");
    activate(B);
    await window.fetch("/api/vaults"); // not reloaded yet → still A, with A's token
    vi.resetModules(); // reload: a fresh document picks up B
    window.fetch = baseFetch;
    await setup();
    await window.fetch("/api/vaults");
    expect([urlOf(0), auth(0)]).toEqual([`${A}/api/vaults`, "Bearer rvn_tok_a"]);
    expect([urlOf(1), auth(1)]).toEqual([`${A}/api/vaults`, "Bearer rvn_tok_a"]);
    expect([urlOf(2), auth(2)]).toEqual([`${B}/api/vaults`, "Bearer rvn_tok_b"]);
  });

  it("matches a host whatever the case or default port it was entered with", async () => {
    const { setHostToken } = await setup();
    setHostToken("http://NAS.Local:8765", "rvn_tok_nas");
    setHostToken("http://web.example:80", "rvn_tok_web");
    await window.fetch("http://nas.local:8765/api/vaults");
    await window.fetch("http://web.example/api/vaults");
    expect(auth(0)).toBe("Bearer rvn_tok_nas");
    expect(auth(1)).toBe("Bearer rvn_tok_web");
  });

  // ── C. Redirects ──

  it("requests with an auto-attached token refuse to follow redirects", async () => {
    const { setHostToken } = await setup();
    setHostToken(A, "rvn_tok_a");
    setHostToken("", "rvn_local");
    await window.fetch(`${A}/api/vaults`);
    await window.fetch("/api/vaults");
    expect(calls[0].init?.redirect).toBe("error");
    expect(calls[1].init?.redirect).toBe("error");
  });

  it("leaves redirect handling alone without an auto-attached token", async () => {
    const { setHostToken } = await setup();
    setHostToken(A, "rvn_tok_a");
    await window.fetch(`${B}/api/vaults`);                                    // no token
    await window.fetch(`${A}/api/vaults`, { headers: { Authorization: "Bearer x" } }); // explicit
    await window.fetch(`${A}/api/vaults`, { redirect: "manual" });          // caller's choice
    expect(calls[0].init?.redirect).toBeUndefined();
    expect(calls[1].init?.redirect).toBeUndefined();
    expect(calls[2].init?.redirect).toBe("manual");
    expect(auth(2)).toBe("Bearer rvn_tok_a");
  });

  // ── D. 401 handling ──

  it("drops a refused stored token and asks again; an explicit header's 401 keeps it", async () => {
    activate(A);
    const { setHostToken, getHostToken } = await setup();
    setHostToken(A, "rvn_revoked");
    const seen: string[] = [];
    window.addEventListener("raven:auth-required", ((e: CustomEvent) => seen.push(e.detail.base)) as unknown as EventListener);
    next = () => res(401, { "www-authenticate": 'Bearer realm="raven"' });
    await window.fetch(`${A}/api/vaults`, { headers: { Authorization: "Bearer other" } });
    expect(getHostToken(A)).toBe("rvn_revoked");
    await window.fetch("/api/vaults");
    expect(getHostToken(A)).toBeNull();
    expect(seen).toContain(A);
  });

  it("only the active host prompts when several hosts 401 at once", async () => {
    activate(B);
    await setup();
    const seen: string[] = [];
    window.addEventListener("raven:auth-required", ((e: CustomEvent) => seen.push(e.detail.base)) as unknown as EventListener);
    next = () => res(401, { "www-authenticate": 'Bearer realm="raven"' });
    await Promise.all([
      window.fetch(`${A}/api/vaults`),
      window.fetch("/api/vaults"),
      window.fetch(new Request(`${A}/api/vaults`)),
    ]);
    expect(seen).toEqual([B]);
  });

  it("reads the challenge scheme case-insensitively; a bare 401 prompts nothing", async () => {
    await setup();
    const seen: string[] = [];
    window.addEventListener("raven:auth-required", ((e: CustomEvent) => seen.push(e.detail.base)) as unknown as EventListener);
    next = () => res(401);
    await window.fetch("/api/vaults");
    expect(seen).toEqual([]);
    next = () => res(401, { "www-authenticate": 'bearer realm="raven"' });
    await window.fetch("/api/vaults");
    expect(seen).toEqual([""]);
  });
});

function refuseStorage() {
  const real = window.sessionStorage;
  const refusing = {
    getItem: () => null, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    setItem: () => { throw new DOMException("quota", "QuotaExceededError"); },
  };
  Object.defineProperty(window, "sessionStorage", { value: refusing, configurable: true });
  return () => Object.defineProperty(window, "sessionStorage", { value: real, configurable: true });
}

describe("token storage failure", () => {
  const realFetch = window.fetch;
  beforeEach(() => {
    sessionStorage.clear();
    vi.resetModules();
  });
  afterEach(() => {
    window.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("setHostToken reports failure when the browser refuses storage", async () => {
    const { setHostToken, getHostToken } = await import("../src/lib/host-auth");
    const restore = refuseStorage();
    expect(setHostToken(A, "rvn_x")).toBe(false);
    expect(getHostToken(A)).toBeNull();
    restore();
    expect(setHostToken(A, "rvn_x")).toBe(true);
  });

  it("the dialog does not report success when the token cannot be stored", async () => {
    window.fetch = vi.fn(async () => res(200, {}, '{"vaults":[]}')) as unknown as typeof fetch;
    const onVerified = vi.fn();
    const { AuthTokenDialog } = await import("../src/components/AuthTokenDialog");
    render(<AuthTokenDialog onVerified={onVerified} />);
    act(() => {
      window.dispatchEvent(new CustomEvent("raven:auth-required", { detail: { base: A } }));
    });
    const restore = refuseStorage();
    fireEvent.change(await screen.findByLabelText("토큰"), { target: { value: "rvn_good_token" } });
    fireEvent.click(screen.getByRole("button", { name: /확인/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("저장");
    expect(alert.textContent).not.toContain("rvn_good_token");
    await waitFor(() => expect(onVerified).not.toHaveBeenCalled());
    restore();
  });
});

/* Issue #24 — remote Core API needs a Bearer token (tailnet included).
 *
 * Contract:
 *  1. Per-host tokens live in sessionStorage only (cleared with the window) —
 *     never localStorage, never a URL. Key = target base URL ("" = same origin).
 *  2. The fetch wrapper adds `Authorization: Bearer` only to `/api/*` requests,
 *     only with the token of the host the request actually goes to, and never
 *     overrides an explicit Authorization header.
 *  3. sendBeacon cannot carry headers: with a token it falls back to
 *     fetch(keepalive) so the request is authenticated instead of 401-ing.
 *  4. A gate 401 (`WWW-Authenticate: Bearer realm="raven"`) raises
 *     `raven:auth-required` with the base; the Docker proxy's own 401
 *     (`Session realm="raven-dashboard"`) sends the browser to its login page.
 *  5. AuthTokenDialog verifies a token against `<base>/api/vaults` before storing it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

function res(status: number, headers: Record<string, string> = {}, body = "{}") {
  return new Response(body, { status, headers });
}

describe("host-auth token store", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.resetModules();
  });

  it("keeps tokens in sessionStorage only", async () => {
    const { setHostToken, getHostToken, clearHostToken } = await import("../src/lib/host-auth");
    setHostToken("http://100.1.2.3:8765", "rvn_secret_value_1");
    expect(getHostToken("http://100.1.2.3:8765")).toBe("rvn_secret_value_1");
    expect(JSON.stringify({ ...localStorage })).not.toContain("rvn_secret_value_1");
    expect(JSON.stringify({ ...sessionStorage })).toContain("rvn_secret_value_1");
    clearHostToken("http://100.1.2.3:8765");
    expect(getHostToken("http://100.1.2.3:8765")).toBeNull();
  });

  it("ignores blank tokens and normalises trailing slashes", async () => {
    const { setHostToken, getHostToken } = await import("../src/lib/host-auth");
    setHostToken("http://h:8765/", "   ");
    expect(getHostToken("http://h:8765")).toBeNull();
    setHostToken("http://h:8765/", " rvn_abc ");
    expect(getHostToken("http://h:8765")).toBe("rvn_abc");
  });
});

describe("api-base wrapper", () => {
  let calls: { url: string; init?: RequestInit }[];
  let next: Response;
  const realFetch = window.fetch;
  const realBeacon = navigator.sendBeacon;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.resetModules();
    calls = [];
    next = res(200);
    window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return next;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    window.fetch = realFetch;
    Object.defineProperty(navigator, "sendBeacon", { value: realBeacon, configurable: true, writable: true });
  });

  function authOf(i = 0): string | null {
    return new Headers(calls[i].init?.headers).get("authorization");
  }

  it("adds the same-origin token to /api requests only", async () => {
    const { setHostToken } = await import("../src/lib/host-auth");
    await import("../src/lib/api-base");
    setHostToken("", "rvn_local_tok");
    await window.fetch("/api/vaults");
    await window.fetch("/assets/app.js");
    expect(authOf(0)).toBe("Bearer rvn_local_tok");
    expect(authOf(1)).toBeNull();
    expect(calls[0].url).toBe("/api/vaults");
    expect(calls[0].url).not.toContain("rvn_");
  });

  it("uses the active remote host's token and never another host's", async () => {
    localStorage.setItem("raven:hosts", JSON.stringify([
      { id: "local", name: "local", endpoint: "", isLocal: true },
      { id: "h1", name: "nas", endpoint: "http://100.88.1.2:8765", isLocal: false },
    ]));
    localStorage.setItem("raven:active_host", "h1");
    const { setHostToken } = await import("../src/lib/host-auth");
    await import("../src/lib/api-base");
    setHostToken("", "rvn_local_tok");
    await window.fetch("/api/vaults");
    expect(calls[0].url).toBe("http://100.88.1.2:8765/api/vaults");
    expect(authOf(0)).toBeNull(); // local token must not leak to the remote host
    setHostToken("http://100.88.1.2:8765", "rvn_remote_tok");
    await window.fetch("/api/vaults", { method: "DELETE" });
    expect(authOf(1)).toBe("Bearer rvn_remote_tok");
    expect(calls[1].init?.method).toBe("DELETE");
  });

  it("authenticates absolute /api URLs only for the exact host the token belongs to", async () => {
    // lib/api.ts apiFetch() builds absolute URLs for the active remote host (E2E regression).
    const { setHostToken } = await import("../src/lib/host-auth");
    await import("../src/lib/api-base");
    setHostToken("http://100.88.1.2:8765", "rvn_remote_tok");
    await window.fetch("http://100.88.1.2:8765/api/vaults");
    await window.fetch("http://100.88.1.2:9999/api/vaults");      // other port
    await window.fetch("http://evil.example/api/vaults");          // other host
    await window.fetch("http://100.88.1.2:8765/assets/app.js");    // not /api
    expect(authOf(0)).toBe("Bearer rvn_remote_tok");
    expect(authOf(1)).toBeNull();
    expect(authOf(2)).toBeNull();
    expect(authOf(3)).toBeNull();
    expect(calls[0].url).toBe("http://100.88.1.2:8765/api/vaults");
  });

  it("keeps an explicit Authorization header", async () => {
    const { setHostToken } = await import("../src/lib/host-auth");
    await import("../src/lib/api-base");
    setHostToken("", "rvn_local_tok");
    await window.fetch("/api/vaults", { headers: { Authorization: "Bearer rvn_explicit" } });
    expect(authOf(0)).toBe("Bearer rvn_explicit");
  });

  it("raises raven:auth-required on a gate 401", async () => {
    await import("../src/lib/api-base");
    const seen: string[] = [];
    window.addEventListener("raven:auth-required", ((e: CustomEvent) => seen.push(e.detail.base)) as unknown as EventListener);
    next = res(401, { "www-authenticate": 'Bearer realm="raven"' });
    const r = await window.fetch("/api/vaults");
    expect(r.status).toBe(401);
    expect(seen).toEqual([""]);
  });

  it("a 401 from probing a non-active host does not pop the token dialog", async () => {
    await import("../src/lib/api-base");
    const seen: string[] = [];
    window.addEventListener("raven:auth-required", ((e: CustomEvent) => seen.push(e.detail.base)) as unknown as EventListener);
    next = res(401, { "www-authenticate": 'Bearer realm="raven"' });
    await window.fetch("http://100.77.7.7:8765/api/vaults"); // HostPicker "연결 테스트"
    expect(seen).toEqual([]);
  });

  it("sends the browser to the Docker proxy login on its session 401", async () => {
    await import("../src/lib/api-base");
    const assign = vi.fn();
    const loc = window.location;
    Object.defineProperty(window, "location", {
      value: { ...loc, pathname: "/vault/x", search: "", assign },
      configurable: true,
    });
    next = res(401, { "www-authenticate": 'Session realm="raven-dashboard"' });
    await window.fetch("/api/vaults");
    expect(assign).toHaveBeenCalledWith("/__raven/login?next=%2Fvault%2Fx");
    Object.defineProperty(window, "location", { value: loc, configurable: true });
  });

  it("sendBeacon with a token goes through fetch keepalive with the header", async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true, writable: true });
    const { setHostToken } = await import("../src/lib/host-auth");
    await import("../src/lib/api-base");
    expect(navigator.sendBeacon("/api/debug-log", "x")).toBe(true);
    expect(beacon).toHaveBeenCalledTimes(1); // no token → native beacon
    setHostToken("", "rvn_local_tok");
    expect(navigator.sendBeacon("/api/debug-log", "y")).toBe(true);
    expect(beacon).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].init?.keepalive).toBe(true);
    expect(calls[0].init?.method).toBe("POST");
    expect(authOf(0)).toBe("Bearer rvn_local_tok");
  });
});

describe("testHostConnection with a token", () => {
  const realFetch = window.fetch;
  afterEach(() => {
    window.fetch = realFetch;
  });

  it("sends the token as a header, not in the URL", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () => res(200, {}, '{"vaults":[1,2]}'));
    window.fetch = fetchMock as unknown as typeof fetch;
    const { testHostConnection } = await import("../src/lib/api");
    const r = await testHostConnection("100.88.1.2", "rvn_tok_123");
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://100.88.1.2:8765/api/vaults");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer rvn_tok_123");
  });

  it("reports a 401 as an authentication problem", async () => {
    vi.resetModules();
    window.fetch = vi.fn(async () => res(401, { "www-authenticate": 'Bearer realm="raven"' })) as unknown as typeof fetch;
    const { testHostConnection } = await import("../src/lib/api");
    const r = await testHostConnection("100.88.1.2");
    expect(r.ok).toBe(false);
    expect(r.authRequired).toBe(true);
  });
});

describe("AuthTokenDialog", () => {
  const realFetch = window.fetch;
  beforeEach(() => {
    sessionStorage.clear();
    vi.resetModules();
  });
  afterEach(() => {
    window.fetch = realFetch;
  });

  it("opens on raven:auth-required, verifies, then stores the token", async () => {
    const fetchMock = vi.fn(async () => res(200, {}, '{"vaults":[]}'));
    window.fetch = fetchMock as unknown as typeof fetch;
    const onVerified = vi.fn();
    const { AuthTokenDialog } = await import("../src/components/AuthTokenDialog");
    const { getHostToken } = await import("../src/lib/host-auth");
    render(<AuthTokenDialog onVerified={onVerified} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent("raven:auth-required", { detail: { base: "http://100.88.1.2:8765" } }));
    });
    const input = await screen.findByLabelText("토큰");
    expect((input as HTMLInputElement).type).toBe("password");
    fireEvent.change(input, { target: { value: "rvn_good_token" } });
    fireEvent.click(screen.getByRole("button", { name: /확인/ }));
    await waitFor(() => expect(onVerified).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://100.88.1.2:8765/api/vaults");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer rvn_good_token");
    expect(getHostToken("http://100.88.1.2:8765")).toBe("rvn_good_token");
  });

  it("still opens when the 401 arrived before the dialog mounted (E2E regression)", async () => {
    // The first /api call can resolve before React mounts the dialog's listener.
    window.fetch = vi.fn(async () => res(401, { "www-authenticate": 'Bearer realm="raven"' })) as unknown as typeof fetch;
    await import("../src/lib/api-base");
    await window.fetch("/api/vaults"); // 401 → auth required, nobody listening yet
    const { AuthTokenDialog } = await import("../src/components/AuthTokenDialog");
    render(<AuthTokenDialog onVerified={() => {}} />);
    expect(await screen.findByLabelText("토큰")).toBeTruthy();
  });

  it("does not store a rejected token", async () => {
    window.fetch = vi.fn(async () => res(401, { "www-authenticate": 'Bearer realm="raven"' })) as unknown as typeof fetch;
    const { AuthTokenDialog } = await import("../src/components/AuthTokenDialog");
    const { getHostToken } = await import("../src/lib/host-auth");
    render(<AuthTokenDialog onVerified={() => {}} />);
    act(() => {
      window.dispatchEvent(new CustomEvent("raven:auth-required", { detail: { base: "" } }));
    });
    fireEvent.change(await screen.findByLabelText("토큰"), { target: { value: "rvn_bad_token" } });
    fireEvent.click(screen.getByRole("button", { name: /확인/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(getHostToken("")).toBeNull();
    expect(screen.getByRole("alert").textContent).not.toContain("rvn_bad_token");
  });
});

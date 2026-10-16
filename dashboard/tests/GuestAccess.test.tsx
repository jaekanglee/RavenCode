/* 손님 입장 (spec 2026-10-16-guest-access-design) — 대시보드 계약.
 *
 *  1. 손님 토큰(`rvg_`)은 localStorage에 둔다 (창을 닫아도 다시 들어오도록). 기기 ID는 한 번 만들어 유지.
 *  2. 손님 토큰을 실은 /api 요청은 X-Raven-Device를 함께 보낸다.
 *  3. 손님 토큰이 401(reason)로 거부되면 토큰을 지우고 입장 요청 화면을 다시 띄우며 이유를 보여 준다.
 *  4. 입장 요청 → 확인 코드 → 폴링 → 승인되면 토큰 저장 후 onEntered.
 *  5. 같은 호스트(base "")의 인증 요구는 입장 요청 화면부터, 원격 호스트는 토큰 입력부터.
 *  6. 운영자 승인 폼: 작성·수정을 고르면 읽기가 켜지고, 고른 vault·권한·기간이 그대로 전송된다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const realFetch = window.fetch;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  window.fetch = realFetch;
});

describe("guest token store", () => {
  it("keeps guest tokens in localStorage and a stable device id", async () => {
    const h = await import("../src/lib/host-auth");
    expect(h.setGuestToken("", "rvg_abc")).toBe(true);
    expect(localStorage.getItem("raven:guest-token:")).toBe("rvg_abc");
    expect(h.authHeaderFor("")).toBe("Bearer rvg_abc");
    const id = h.deviceId();
    expect(id).toMatch(/^d_[A-Za-z0-9_-]{22,64}$/);
    expect(h.deviceId()).toBe(id);
    expect(h.authHeadersFor("")).toEqual({ Authorization: "Bearer rvg_abc", "X-Raven-Device": id });
    h.clearGuestToken("");
    expect(h.authHeaderFor("")).toBeNull();
  });

  it("prefers an entered host token over a guest token, without a device header", async () => {
    const h = await import("../src/lib/host-auth");
    h.setGuestToken("", "rvg_abc");
    h.setHostToken("", "rvn_owner");
    expect(h.authHeadersFor("")).toEqual({ Authorization: "Bearer rvn_owner" });
  });
});

describe("api-base with a guest token", () => {
  it("sends X-Raven-Device with the guest token", async () => {
    const calls: RequestInit[] = [];
    window.fetch = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return json(200, {});
    }) as unknown as typeof fetch;
    const h = await import("../src/lib/host-auth");
    await import("../src/lib/api-base");
    h.setGuestToken("", "rvg_abc");
    await window.fetch("/api/vaults");
    const headers = new Headers(calls[0].headers);
    expect(headers.get("authorization")).toBe("Bearer rvg_abc");
    expect(headers.get("x-raven-device")).toBe(h.deviceId());
  });

  it("drops a refused guest token and asks to enter again with the reason", async () => {
    window.fetch = vi.fn(async () =>
      json(401, { ok: false, error: "unauthorized", reason: "ip_changed" }, { "www-authenticate": 'Bearer realm="raven"' }),
    ) as unknown as typeof fetch;
    const h = await import("../src/lib/host-auth");
    await import("../src/lib/api-base");
    h.setGuestToken("", "rvg_abc");
    const seen: string[] = [];
    window.addEventListener("raven:auth-required", ((e: CustomEvent) => seen.push(e.detail.base)) as unknown as EventListener);
    await window.fetch("/api/vaults/alpha/pages");
    await waitFor(() => expect(seen).toEqual([""]));
    expect(h.getGuestToken("")).toBeNull();
    expect(h.takeGuestRefusal()).toBe("ip_changed");
  });
});

describe("GuestEntryForm", () => {
  it("requests entry, shows the code, then stores the token once approved", async () => {
    const statuses = [json(200, { status: "pending" }), json(200, { status: "approved", token: "rvg_new" })];
    const calls: { url: string; init?: RequestInit }[] = [];
    window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "POST") return json(200, { request_id: "r1", claim_secret: "s1", code: "K7-3F", expires_in: 600 });
      return statuses.length > 1 ? statuses.shift()! : statuses[0];
    }) as unknown as typeof fetch;
    const { GuestEntryForm, POLL_MS } = await import("../src/components/GuestEntryForm");
    const h = await import("../src/lib/host-auth");
    const onEntered = vi.fn();
    render(<GuestEntryForm base="" onEntered={onEntered} onUseToken={() => {}} />);
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "김동료" } });
    fireEvent.click(screen.getByRole("button", { name: "입장 요청" }));
    expect((await screen.findByTestId("guest-code")).textContent).toBe("K7-3F");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ name: "김동료", device_id: h.deviceId() });
    await waitFor(() => expect(onEntered).toHaveBeenCalled(), { timeout: POLL_MS * 3 });
    expect(h.getGuestToken("")).toBe("rvg_new");
    const poll = calls.find((c) => c.url.includes("/api/guest/requests/r1"))!;
    expect(new Headers(poll.init?.headers).get("x-raven-claim")).toBe("s1");
    expect(poll.url).not.toContain("s1");
  });

  it("shows a denial", async () => {
    window.fetch = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? json(200, { request_id: "r1", claim_secret: "s1", code: "K7-3F", expires_in: 600 })
        : json(200, { status: "denied" }),
    ) as unknown as typeof fetch;
    const { GuestEntryForm, POLL_MS } = await import("../src/components/GuestEntryForm");
    render(<GuestEntryForm base="" onUseToken={() => {}} />);
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "김동료" } });
    fireEvent.click(screen.getByRole("button", { name: "입장 요청" }));
    expect(await screen.findByText("입장 요청이 거절됐어요.", {}, { timeout: POLL_MS * 3 })).toBeTruthy();
  });

  it("explains a rate limit", async () => {
    window.fetch = vi.fn(async () => json(429, { detail: "x" })) as unknown as typeof fetch;
    const { GuestEntryForm } = await import("../src/components/GuestEntryForm");
    render(<GuestEntryForm base="" onUseToken={() => {}} />);
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "김동료" } });
    fireEvent.click(screen.getByRole("button", { name: "입장 요청" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/잠시 후/);
  });
});

describe("AuthTokenDialog modes", () => {
  it("same-origin host: entry request first, with the refusal reason", async () => {
    const { AuthTokenDialog } = await import("../src/components/AuthTokenDialog");
    const h = await import("../src/lib/host-auth");
    h.setGuestRefusal("expired");
    render(<AuthTokenDialog onVerified={() => {}} />);
    act(() => {
      window.dispatchEvent(new CustomEvent("raven:auth-required", { detail: { base: "" } }));
    });
    expect(await screen.findByText("입장 요청", { selector: "h2" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/기간이 끝났어요/);
    fireEvent.click(screen.getByRole("button", { name: "토큰 직접 입력" }));
    expect(await screen.findByLabelText("토큰")).toBeTruthy();
  });

  it("remote host: token form first", async () => {
    const { AuthTokenDialog } = await import("../src/components/AuthTokenDialog");
    render(<AuthTokenDialog onVerified={() => {}} />);
    act(() => {
      window.dispatchEvent(new CustomEvent("raven:auth-required", { detail: { base: "http://100.88.1.2:8765" } }));
    });
    expect(await screen.findByLabelText("토큰")).toBeTruthy();
  });
});

describe("guest permissions", () => {
  it("normalizes perms and answers canGuest", async () => {
    const { normalizeGuestPerms, canGuest } = await import("../src/lib/guest");
    expect(normalizeGuestPerms(["update"])).toEqual(["read", "update"]);
    expect(normalizeGuestPerms(["create", "read"])).toEqual(["read", "create"]);
    expect(normalizeGuestPerms([])).toEqual([]);
    const me = { name: "a", vaults: { alpha: ["read" as const] }, expires: null };
    expect(canGuest(me, "alpha", "read")).toBe(true);
    expect(canGuest(me, "alpha", "update")).toBe(false);
    expect(canGuest(me, "beta", "read")).toBe(false);
    expect(canGuest(null, "beta", "update")).toBe(true);
  });

  it("describes the guest for the banner", async () => {
    const { describeGuest } = await import("../src/components/GuestBanner");
    expect(describeGuest({ name: "a", vaults: { alpha: ["read", "update"] }, expires: "2026-11-15T09:00:00+00:00" }))
      .toBe("손님으로 접속 중 · alpha(읽기·수정) · 2026-11-15까지");
  });
});

describe("GuestAccessPanel", () => {
  it("approves with the chosen vault perms and ttl", async () => {
    const posts: { url: string; body: unknown }[] = [];
    window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json(200, { ok: true, grant_id: "g_1" });
      }
      if (url.endsWith("/api/guest/requests"))
        return json(200, { requests: [{ request_id: "r1", name: "김동료", ip: "10.10.81.12", code: "K7-3F", created: "", expires_in: 540 }] });
      return json(200, { grants: [] });
    }) as unknown as typeof fetch;
    const { GuestAccessPanel } = await import("../src/components/GuestAccessPanel");
    render(<GuestAccessPanel vaults={["alpha", "beta"]} />);
    expect(await screen.findByText("K7-3F")).toBeTruthy();
    const approve = screen.getByRole("button", { name: "승인" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("alpha 수정"));
    expect((screen.getByLabelText("alpha 읽기") as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("기간"), { target: { value: "7" } });
    fireEvent.click(approve);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toContain("/api/guest/requests/r1/approve");
    expect(posts[0].body).toEqual({ vaults: { alpha: ["read", "update"] }, ttl_days: 7 });
  });

  it("unchecking read clears create/update", async () => {
    window.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/api/guest/requests")
        ? json(200, { requests: [{ request_id: "r1", name: "a", ip: "1", code: "AB-CD", created: "", expires_in: 60 }] })
        : json(200, { grants: [] }),
    ) as unknown as typeof fetch;
    const { GuestAccessPanel } = await import("../src/components/GuestAccessPanel");
    render(<GuestAccessPanel vaults={["alpha"]} />);
    fireEvent.click(await screen.findByLabelText("alpha 작성"));
    fireEvent.click(screen.getByLabelText("alpha 읽기"));
    expect((screen.getByLabelText("alpha 작성") as HTMLInputElement).checked).toBe(false);
  });
});

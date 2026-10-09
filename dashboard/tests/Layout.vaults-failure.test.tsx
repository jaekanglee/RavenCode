/* Issue #30 — Core API 실패를 "vault 0개"로 오인해 /vault/new로 보내던 회귀 가드.
 *
 * window.fetch만 stub하고 실제 api.ts(fetchVaults + cachedFetch)와 api-base.ts
 * (401 → AuthTokenDialog 흐름)를 그대로 태운다. fetchVaults를 mock하면 이번 버그의
 * 원인(실패 → [] 변환, 그 [] 캐시)이 통째로 테스트 밖으로 빠진다.
 *
 *   200 + 목록  : 정상 표시
 *   200 + []    : /vault/new (기존 동작 유지)
 *   401         : 이동 없음, 기존 토큰 입력창 1개 (중복 모달 없음)
 *   403/5xx/네트워크 : 이동 없음, 상태별 오류 + 재시도
 *   재시도      : 실제 /api/vaults 재요청, 성공 시 오류 해제
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

type Reply = () => Response | Promise<Response>;

const VAULT = { name: "notes", path: "/tmp/notes", mode: "personal", owner: "user", default: true };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const ok = (vaults: unknown[]) => () => json(200, { vaults });
const status = (code: number, headers: Record<string, string> = {}) => () =>
  json(code, { detail: "x" }, headers);
const networkDown = () => () => Promise.reject(new TypeError("Failed to fetch"));

let vaultReplies: Reply[];
let vaultCalls: number;
const realFetch = window.fetch;

function installFetch() {
  window.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/\/api\/vaults(\?|$)/.test(url)) {
      vaultCalls += 1;
      // 마지막 응답을 반복 — 백그라운드 재요청이 있어도 시나리오가 유지된다.
      const reply = vaultReplies.length > 1 ? vaultReplies.shift()! : vaultReplies[0];
      return reply();
    }
    // 사이드바 부속 요청(tree/raw/drafts)은 이번 계약과 무관 — 빈 성공으로 고정.
    return json(200, {});
  }) as unknown as typeof fetch;
}

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

async function mount() {
  // api-base는 module-load 시점에 window.fetch를 감싼다 → stub 설치 후 import.
  await import("../src/lib/api-base");
  const { Layout } = await import("../src/components/Layout");
  const { AuthTokenDialog } = await import("../src/components/AuthTokenDialog");
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<div>HOME-OUTLET</div>} />
          <Route path="/vault/new" element={<div>NEW-VAULT-PAGE</div>} />
        </Route>
      </Routes>
      <LocationProbe />
      <AuthTokenDialog onVerified={() => {}} />
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId("location").textContent;

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  localStorage.clear();
  vaultCalls = 0;
  vaultReplies = [ok([VAULT])];
  installFetch();
});

afterEach(() => {
  cleanup();
  window.fetch = realFetch;
});

describe("Layout — vault 목록 실패 vs 빈 목록 (Issue #30)", () => {
  it("200 + 목록: 정상 표시, 이동 없음", async () => {
    await mount();
    expect(await screen.findByText("HOME-OUTLET")).toBeTruthy();
    expect(location()).toBe("/");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("200 + 빈 목록: 기존대로 /vault/new 이동", async () => {
    vaultReplies = [ok([])];
    await mount();
    expect(await screen.findByText("NEW-VAULT-PAGE")).toBeTruthy();
    expect(location()).toBe("/vault/new");
  });

  it("500: /vault/new로 이동하지 않고 서버 오류 + 재시도", async () => {
    vaultReplies = [status(500)];
    await mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/서버 오류/);
    expect(alert.textContent).toMatch(/500/);
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    expect(location()).toBe("/");
    expect(screen.queryByText("NEW-VAULT-PAGE")).toBeNull();
  });

  it("네트워크 오류: /vault/new로 이동하지 않고 연결 오류 + 재시도", async () => {
    vaultReplies = [networkDown()];
    await mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/연결할 수 없습니다/);
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    expect(location()).toBe("/");
  });

  it("403: /vault/new로 이동하지 않고 권한 오류", async () => {
    vaultReplies = [status(403)];
    await mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/권한/);
    expect(location()).toBe("/");
    expect(screen.queryByText("NEW-VAULT-PAGE")).toBeNull();
  });

  it("401: 이동 없음 + 기존 토큰 입력창 1개만 (중복 인증 모달 없음)", async () => {
    vaultReplies = [status(401, { "www-authenticate": 'Bearer realm="raven"' })];
    await mount();
    // 기존 흐름: api-base 래퍼 → requestAuth → AuthTokenDialog
    expect(await screen.findByText("접근 토큰이 필요합니다")).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/인증이 필요합니다/);
    expect(screen.getAllByText("접근 토큰이 필요합니다")).toHaveLength(1);
    expect(screen.getAllByPlaceholderText("rvn_...")).toHaveLength(1);
    expect(location()).toBe("/");
    expect(screen.queryByText("NEW-VAULT-PAGE")).toBeNull();
  });

  it("재시도: 실제 /api/vaults를 다시 요청하고, 성공하면 오류가 해제된다", async () => {
    vaultReplies = [status(503), ok([VAULT])];
    await mount();
    await screen.findByRole("alert");
    const before = vaultCalls;
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(vaultCalls).toBeGreaterThan(before);
    expect(await screen.findByText("HOME-OUTLET")).toBeTruthy();
    expect(location()).toBe("/");
  });

  it("재시도 후에도 빈 목록이면 그때 /vault/new로 간다", async () => {
    vaultReplies = [networkDown(), ok([])];
    await mount();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("NEW-VAULT-PAGE")).toBeTruthy();
  });
});

describe("fetchVaults 반환 계약 (Issue #30)", () => {
  async function api() {
    await import("../src/lib/api-base");
    return import("../src/lib/api");
  }

  it("HTTP 실패는 빈 배열이 아니라 상태 코드를 담은 오류로 reject", async () => {
    vaultReplies = [status(500)];
    const { fetchVaults, ApiHttpError } = await api();
    const err = await fetchVaults().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiHttpError);
    expect((err as InstanceType<typeof ApiHttpError>).status).toBe(500);
  });

  it("실패 결과는 캐시되지 않는다 — 다음 호출은 실제 fetch", async () => {
    vaultReplies = [status(500), ok([VAULT])];
    const { fetchVaults } = await api();
    await expect(fetchVaults()).rejects.toBeTruthy();
    expect(vaultCalls).toBe(1);
    await expect(fetchVaults()).resolves.toEqual([VAULT]);
    expect(vaultCalls).toBe(2);
  });

  it("네트워크 실패도 캐시되지 않는다", async () => {
    vaultReplies = [networkDown(), ok([VAULT])];
    const { fetchVaults } = await api();
    await expect(fetchVaults()).rejects.toBeInstanceOf(TypeError);
    await expect(fetchVaults()).resolves.toEqual([VAULT]);
    expect(vaultCalls).toBe(2);
  });

  it("성공한 목록은 기존대로 TTL 캐시된다 (회귀 없음)", async () => {
    const { fetchVaults } = await api();
    await fetchVaults();
    await fetchVaults();
    expect(vaultCalls).toBe(1);
  });
});

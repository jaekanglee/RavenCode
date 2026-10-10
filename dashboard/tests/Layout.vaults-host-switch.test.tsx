/* Issue #30 / PR #31 review — "이전 목록 유지"는 같은 호스트의 일시 장애에만.
 *
 * 같은 탭의 HostPicker 전환은 setActiveHostId + 전체 페이지 이동(location.href)이라
 * React state가 남지 않는다. PR #31 당시 api-base는 매 요청마다 localStorage의 활성
 * 호스트를 읽어서, 다른 탭에서 호스트를 바꾸면 이 탭의 다음 요청이 새 호스트로 갔다.
 * Issue #32부터는 탭이 로드 때의 호스트에 고정되므로(아래 주석) 같은 목적을 그 위에서 확인한다.
 * PR #31의 목적:
 *   - 호스트 B 실패 시 A의 vault 목록이 B 화면에 남아 선택·조작 가능하면 안 된다.
 *   - A의 캐시된 목록이 B의 응답처럼 돌아오면 안 된다 (캐시 키가 호스트 무관이었음).
 *   - A로 보낸 늦은 응답이 B의 결과를 덮으면 안 된다 (완료 순서 역전).
 *   - 같은 호스트의 일시 장애에서는 이전 목록을 유지한다 (기존 정책 보존).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useOutletContext } from "react-router-dom";

const B = "http://100.64.0.2:8765";

type Outcome = { vaults: string[] } | { status: number } | { pending: Deferred };

interface Deferred {
  promise: Promise<Response>;
  resolve: (r: Response) => void;
}

function deferred(): Deferred {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const vaultsBody = (names: string[]) => ({
  vaults: names.map((name, i) => ({ name, path: `/v/${name}`, mode: "personal", owner: "u", default: i === 0 })),
});

/** host("" = local, B) → 다음 /api/vaults 응답. */
let outcome: Record<string, Outcome>;
let vaultCalls: Record<string, number>;
const realFetch = window.fetch;

function installFetch() {
  window.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = /^(https?:\/\/[^/]+)?\/api\/vaults(\?|$)/.exec(url);
    if (m) {
      const host = m[1] ?? "";
      vaultCalls[host] = (vaultCalls[host] ?? 0) + 1;
      const o = outcome[host];
      if ("pending" in o) return o.pending.promise;
      if ("status" in o) return json(o.status, { detail: "x" });
      return json(200, vaultsBody(o.vaults));
    }
    return json(200, {});
  }) as unknown as typeof fetch;
}

/** 다른 탭에서 활성 호스트를 바꾼 것과 같은 상태 — localStorage만 바뀌고 이 탭은 reload되지 않는다. */
function switchActiveHost(to: "local" | "b") {
  localStorage.setItem(
    "raven:hosts",
    JSON.stringify([
      { id: "local", name: "로컬", endpoint: "", isLocal: true },
      { id: "b", name: "B", endpoint: B, isLocal: false },
    ]),
  );
  localStorage.setItem("raven:active_host", to);
}

function RefreshProbe() {
  const { refresh } = useOutletContext<{ refresh: () => void }>();
  return (
    <button type="button" onClick={refresh}>
      REFRESH
    </button>
  );
}

async function mount() {
  await import("../src/lib/api-base");
  const api = await import("../src/lib/api");
  const { Layout } = await import("../src/components/Layout");
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<RefreshProbe />} />
          <Route path="/vault/new" element={<div>NEW-VAULT-PAGE</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return api;
}

/** 사이드바 vault 셀렉터의 옵션 이름들. 셀렉터가 없으면 []. */
function selectorVaults(): string[] {
  const select = screen.queryByRole("combobox", { name: "보관소 선택" }) as HTMLSelectElement | null;
  if (!select) return [];
  return Array.from(select.options).map((o) => o.value);
}

const refresh = () => fireEvent.click(screen.getByRole("button", { name: "REFRESH" }));

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  localStorage.clear();
  switchActiveHost("local");
  vaultCalls = {};
  outcome = { "": { vaults: ["alpha"] }, [B]: { vaults: ["beta"] } };
  installFetch();
});

afterEach(() => {
  cleanup();
  window.fetch = realFetch;
});

describe("Layout — 호스트 전환과 이전 목록 (PR #31 review)", () => {
  it("같은 호스트의 일시 장애: 이전 목록과 화면을 유지하고 오류만 알린다 (정책 보존)", async () => {
    const api = await mount();
    await waitFor(() => expect(selectorVaults()).toEqual(["alpha"]));
    outcome[""] = { status: 503 };
    api.invalidateCache(); // TTL 만료와 같은 상태
    refresh();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(selectorVaults()).toEqual(["alpha"]);
    expect(screen.getByRole("button", { name: "REFRESH" })).toBeTruthy();
    expect(screen.queryByText("NEW-VAULT-PAGE")).toBeNull();
  });

  // Issue #32: 탭은 로드 때의 호스트에 고정된다. 다른 탭의 전환은 이 탭의 요청을 옮기지 않고
  // (tab-host-sync가 "/"로 재로드), 새 호스트는 다음 로드에서 적용된다. 아래는 PR #31의 보호 목적
  // — 다른 호스트의 목록·이름을 이 화면에 섞지 않는다, 늦은 응답이 최신 결과를 덮지 않는다 — 을
  // 그 불변식 위에서 다시 확인한다.

  it("다른 탭이 B로 바꿔도 이 탭은 A의 목록을 A에만 다시 요청한다 (B 요청 0회)", async () => {
    const api = await mount();
    await waitFor(() => expect(selectorVaults()).toEqual(["alpha"]));
    outcome[B] = { status: 503 };
    switchActiveHost("b"); // 다른 탭의 전환
    api.invalidateCache();
    refresh();
    await waitFor(() => expect(vaultCalls[""]).toBe(2));
    expect(vaultCalls[B]).toBeUndefined();
    expect(selectorVaults()).toEqual(["alpha"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("B 호스트로 로드한 탭이 실패하면: 저장된 A의 vault 이름을 B의 '현재 보관소'로 보이지 않는다", async () => {
    localStorage.setItem("raven:active_vault", "alpha"); // A를 쓰던 시절의 선택이 남아 있음
    outcome[B] = { status: 503 };
    switchActiveHost("b");
    await mount(); // 재로드 = B로 로드
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(selectorVaults()).toEqual([]);
    // (실화면에서 사이드바 하단 위젯이 "alpha / 현재 보관소"를 보여 준 것을 잡은 PR #31 가드)
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.queryByRole("button", { name: "REFRESH" })).toBeNull();
    expect(screen.queryByText("NEW-VAULT-PAGE")).toBeNull();
    expect(vaultCalls[B]).toBeGreaterThan(0);
    expect(vaultCalls[""]).toBeUndefined();
  });

  it("B 호스트로 로드한 탭은 B의 목록만 받는다 (A 요청 0회)", async () => {
    switchActiveHost("b");
    await mount();
    await waitFor(() => expect(selectorVaults()).toEqual(["beta"]));
    expect(vaultCalls[""]).toBeUndefined();
  });

  it("완료 순서 역전: 먼저 보낸 요청의 늦은 성공 응답이 나중 요청의 결과를 덮지 않는다", async () => {
    const api = await mount();
    await waitFor(() => expect(selectorVaults()).toEqual(["alpha"]));
    const slow = deferred();
    outcome[""] = { pending: slow };
    api.invalidateCache();
    refresh(); // 1번 요청 진행 중
    await waitFor(() => expect(vaultCalls[""]).toBe(2));
    outcome[""] = { vaults: ["beta"] };
    api.invalidateCache();
    refresh(); // 2번 요청 → 즉시 beta
    await waitFor(() => expect(selectorVaults()).toEqual(["beta"]));
    await act(async () => {
      slow.resolve(json(200, vaultsBody(["alpha", "alpha-2"])));
      await slow.promise;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(selectorVaults()).toEqual(["beta"]);
  });

  it("완료 순서 역전: 먼저 보낸 요청의 늦은 실패 응답이 나중의 정상 화면에 오류를 띄우지 않는다", async () => {
    const api = await mount();
    await waitFor(() => expect(selectorVaults()).toEqual(["alpha"]));
    const slow = deferred();
    outcome[""] = { pending: slow };
    api.invalidateCache();
    refresh();
    await waitFor(() => expect(vaultCalls[""]).toBe(2));
    outcome[""] = { vaults: ["beta"] };
    api.invalidateCache();
    refresh();
    await waitFor(() => expect(selectorVaults()).toEqual(["beta"]));
    await act(async () => {
      slow.resolve(json(503, { detail: "x" }));
      await slow.promise;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(selectorVaults()).toEqual(["beta"]);
  });

  it("B로 로드한 탭: B 실패 후 B 복구 시 재시도로 B의 목록에 정상 복귀", async () => {
    outcome[B] = { status: 503 };
    switchActiveHost("b");
    await mount();
    await screen.findByRole("alert");
    outcome[B] = { vaults: ["beta"] };
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(selectorVaults()).toEqual(["beta"]);
  });
});

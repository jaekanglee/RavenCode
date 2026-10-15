/* Issue #32 — 탭이 보여 주는 호스트와 실제 요청 대상 호스트를 일치시킨다.
 *
 * 활성 호스트(raven:active_host / raven:hosts)는 탭끼리 공유하는 localStorage에 있다.
 * 수정 전에는 fetch 래퍼(api-base)와 apiFetch가 요청할 때마다 그 값을 다시 읽어서,
 * 다른 탭에서 호스트를 B로 바꾸면 A의 화면을 보고 있는 이 탭의 저장·삭제가 B로 갔다.
 *
 * 여기서 "탭 로드" = 모듈을 새로 import하는 것 (vi.resetModules 뒤 첫 import).
 * "다른 탭의 전환" = 이 탭의 모듈은 그대로 두고 localStorage만 바꾸는 것.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const A = "http://100.64.0.1:8765";
const B = "http://100.64.0.2:8765";

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

/** 다른 탭(또는 이 탭의 로드 전)에서 활성 호스트를 정한 것과 같은 상태. */
function storeActiveHost(to: "local" | "a" | "b", endpoints: { a?: string; b?: string } = {}) {
  localStorage.setItem(
    "raven:hosts",
    JSON.stringify([
      { id: "local", name: "로컬", endpoint: "", isLocal: true },
      { id: "a", name: "A", endpoint: endpoints.a ?? A, isLocal: false },
      { id: "b", name: "B", endpoint: endpoints.b ?? B, isLocal: false },
    ]),
  );
  localStorage.setItem("raven:active_host", to);
}

interface Call {
  url: string;
  method: string;
  auth: string | null;
}
let calls: Call[];
let respond: (url: string, method: string) => Response | Promise<Response>;
const realFetch = window.fetch;

function installFetch() {
  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const auth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization");
    calls.push({ url, method, auth });
    return respond(url, method);
  }) as unknown as typeof fetch;
}

/** 탭 로드: fetch를 깔고 모듈을 새로 읽는다 (api-base가 fetch 래퍼를 이때 설치). */
async function loadTab() {
  await import("../src/lib/api-base");
  const hostAuth = await import("../src/lib/host-auth");
  const api = await import("../src/lib/api");
  return { api, hostAuth };
}

const hostOf = (c: Call) => (c.url.startsWith(A) ? "A" : c.url.startsWith(B) ? "B" : "local");

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  calls = [];
  respond = (url) => {
    if (/\/tree$/.test(url)) return json(200, { tree: { type: "dir", path: url.startsWith(B) ? "tree-B" : "tree-A", children: [] } });
    if (/\/pages(\?|$)/.test(url)) return json(200, { pages: [{ slug: url.startsWith(B) ? "page-B" : "page-A" }] });
    return json(200, { ok: true, pages: [] });
  };
  installFetch();
});

afterEach(() => {
  window.fetch = realFetch;
  vi.useRealTimers();
});

describe("쓰기 요청은 탭이 보여 주는 호스트로만 간다 (Issue #32 D)", () => {
  it("다른 탭이 B로 바꾼 뒤에도 A 화면의 저장은 A로, A의 토큰으로 간다", async () => {
    storeActiveHost("a");
    const { api, hostAuth } = await loadTab();
    hostAuth.setHostToken(A, "rvn_tok_a");
    hostAuth.setHostToken(B, "rvn_tok_b");
    storeActiveHost("b"); // 다른 탭의 전환 — 이 탭은 아직 A를 보여 준다
    await api.updatePage("notes", "hello", { content: "from A screen" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "PUT", url: `${A}/api/vaults/notes/pages/hello`, auth: "Bearer rvn_tok_a" });
  });

  it("다른 탭 전환 뒤의 삭제도 A로만 간다 (B에 같은 vault·slug가 있어도)", async () => {
    storeActiveHost("a");
    const { api } = await loadTab();
    storeActiveHost("b");
    await api.deletePage("notes", "hello");
    expect(calls.map((c) => [c.method, hostOf(c)])).toEqual([["DELETE", "A"]]);
  });

  it("상대 경로 /api 요청(fetch 래퍼)도 다른 탭 전환에 끌려가지 않는다", async () => {
    storeActiveHost("a");
    await loadTab();
    storeActiveHost("b");
    await window.fetch("/api/vaults/notes/raw/x.md", { method: "DELETE" });
    expect(calls.map((c) => [c.method, hostOf(c)])).toEqual([["DELETE", "A"]]);
  });

  it("다른 탭이 이 탭 호스트의 주소를 바꾸거나 지워도 이 탭은 로드된 주소로만 보낸다", async () => {
    storeActiveHost("a");
    const { api } = await loadTab();
    storeActiveHost("a", { a: "http://100.64.0.9:8765" }); // 같은 id, 다른 주소
    await api.createPage("notes", { slug: "s", title: "t", content: "c", type: "note", tags: [] });
    localStorage.setItem("raven:hosts", JSON.stringify([{ id: "local", name: "로컬", endpoint: "", isLocal: true }]));
    await api.deletePage("notes", "s");
    expect(calls.map((c) => c.url)).toEqual([`${A}/api/vaults/notes/pages`, `${A}/api/vaults/notes/pages/s`]);
  });

  it("전송이 시작된 요청은 그 뒤의 전환과 무관하게 처음 정한 호스트로 완료된다", async () => {
    storeActiveHost("a");
    const { api } = await loadTab();
    const slow = deferred();
    respond = () => slow.promise;
    const p = api.updatePage("notes", "hello", { content: "x" });
    storeActiveHost("b");
    slow.resolve(json(200, { ok: true }));
    await p;
    expect(calls.map(hostOf)).toEqual(["A"]);
  });

  it("탭을 새로 로드하면(= 같은 탭 전환 뒤 재로드) 그때의 활성 호스트로 간다", async () => {
    storeActiveHost("b");
    const { api, hostAuth } = await loadTab();
    hostAuth.setHostToken(B, "rvn_tok_b");
    await api.updatePage("notes", "hello", { content: "x" });
    expect(calls[0]).toMatchObject({ url: `${B}/api/vaults/notes/pages/hello`, auth: "Bearer rvn_tok_b" });
  });

  it("이 탭이 보여 주는 호스트 정보도 로드 시점의 호스트다 (HostPicker·VaultManage 표시)", async () => {
    storeActiveHost("a");
    const { api } = await loadTab();
    storeActiveHost("b");
    expect(api.getActiveHostId()).toBe("a");
    expect(api.getActiveHostUrl()).toBe(A);
    expect(api.getActiveHost().endpoint).toBe(A);
  });

  it("동일 호스트 회귀: 로컬 탭은 상대 경로로, 원격 탭은 그 호스트로 계속 보낸다", async () => {
    const { api } = await loadTab(); // 저장된 호스트 없음 = local
    await api.fetchPage("notes", "hello");
    await window.fetch("/api/vaults");
    expect(calls.map(hostOf)).toEqual(["local", "local"]);
    expect(calls[0].url.startsWith("/api/vaults/notes/pages/hello")).toBe(true);
  });
});

describe("다른 탭의 호스트 변경 감지 (Issue #32 A)", () => {
  function storageEvent(key: string | null, newValue: string | null) {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  }

  it("다른 탭이 활성 호스트를 바꾸면 캐시를 비우고 한 번 다시 불러온다", async () => {
    storeActiveHost("a");
    const { api } = await loadTab();
    const { watchTabHostChange } = await import("../src/lib/api-base");
    await api.fetchTree("notes");
    const onChange = vi.fn();
    const stop = watchTabHostChange(onChange);
    storeActiveHost("b");
    storageEvent("raven:active_host", "b");
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("호스트 목록만 바뀌고 이 탭의 호스트가 그대로면 다시 불러오지 않는다", async () => {
    storeActiveHost("a");
    await loadTab();
    const { watchTabHostChange } = await import("../src/lib/api-base");
    const onChange = vi.fn();
    const stop = watchTabHostChange(onChange);
    storeActiveHost("a", { b: "http://100.64.0.7:8765" }); // B의 주소만 바뀜
    storageEvent("raven:hosts", localStorage.getItem("raven:hosts"));
    storageEvent("raven.dashboard.favoriteVaults", "[]"); // 무관한 키
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it("이 탭 호스트의 주소가 바뀌거나 저장소가 비워지면(key=null) 다시 불러온다", async () => {
    storeActiveHost("a");
    await loadTab();
    const { watchTabHostChange } = await import("../src/lib/api-base");
    const onChange = vi.fn();
    const stop = watchTabHostChange(onChange);
    storeActiveHost("a", { a: "http://100.64.0.9:8765" });
    storageEvent("raven:hosts", localStorage.getItem("raven:hosts"));
    expect(onChange).toHaveBeenCalledTimes(1);
    localStorage.clear();
    storageEvent(null, null);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it("App이 감지기를 설치한다: 다른 탭 전환 → '/'로 전체 이동", async () => {
    storeActiveHost("a");
    await loadTab();
    const { render, cleanup } = await import("@testing-library/react");
    const { default: App } = await import("../src/App");
    render(<App />);
    // BrowserRouter가 렌더 때 location을 읽으므로 첫 렌더 뒤에 assign만 감시한다
    const realLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign } });
    try {
      storeActiveHost("b");
      storageEvent("raven:active_host", "b");
      storageEvent("raven:active_host", "b"); // 중복 이벤트에도 이동은 한 번
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith("/");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: realLocation });
      cleanup();
    }
  });

  it("감지기: 다른 탭 전환 → 캐시 무효화 + '/'로 이동", async () => {
    storeActiveHost("a");
    const { api } = await loadTab();
    const { installTabHostSync } = await import("../src/lib/tab-host-sync");
    await api.fetchTree("notes");
    const navigate = vi.fn();
    const stop = installTabHostSync(navigate);
    storeActiveHost("b");
    storageEvent("raven:active_host", "b");
    expect(navigate).toHaveBeenCalledWith("/");
    // 이동이 막혀도(편집 중 beforeunload 취소) 이전 호스트 캐시는 비워져 있다
    await api.fetchTree("notes");
    expect(calls.filter((c) => /\/tree$/.test(c.url)).map(hostOf)).toEqual(["A", "A"]);
    stop();
  });
});

describe("문서 트리·페이지 캐시 (Issue #32 B)", () => {
  it("캐시 키에 호스트가 들어간다: 다른 호스트 접두어 무효화는 이 탭 캐시를 건드리지 않는다", async () => {
    storeActiveHost("a");
    const { api } = await loadTab();
    await api.fetchTree("notes");
    await api.fetchPages("notes");
    api.invalidateCache(`tree:notes@${B}`);
    api.invalidateCache(`pages:notes@${B}`);
    await api.fetchTree("notes");
    await api.fetchPages("notes");
    expect(calls).toHaveLength(2); // 둘 다 캐시 적중
    api.invalidateCache(`tree:notes@${A}`);
    await api.fetchTree("notes");
    expect(calls).toHaveLength(3);
  });

  it("같은 vault 이름이라도 호스트가 다른 탭(로드)은 서로의 캐시를 보지 않는다", async () => {
    storeActiveHost("a");
    const tabA = await loadTab();
    expect((await tabA.api.fetchTree("notes"))?.path).toBe("tree-A");
    vi.resetModules();
    storeActiveHost("b");
    const tabB = await loadTab();
    expect((await tabB.api.fetchTree("notes"))?.path).toBe("tree-B");
    expect((await tabB.api.fetchPages("notes"))[0].slug).toBe("page-B");
  });

  it("TTL 안에서는 적중, TTL(15초)이 지나면 다시 요청, 쓰기 뒤에는 무효화", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    storeActiveHost("a");
    const { api } = await loadTab();
    await api.fetchTree("notes");
    vi.setSystemTime(Date.now() + 14_000);
    await api.fetchTree("notes");
    expect(calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2_000);
    await api.fetchTree("notes");
    expect(calls).toHaveLength(2);
    await api.deletePage("notes", "x");
    await api.fetchTree("notes");
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "DELETE", "GET"]);
  });

  it("무효화 이전에 시작된 요청의 늦은 응답은 캐시에 남지 않는다 (진행 중 요청 격리)", async () => {
    storeActiveHost("a");
    const { api } = await loadTab();
    const slow = deferred();
    respond = () => slow.promise;
    const before = api.fetchTree("notes"); // 쓰기 전 트리 조회 시작
    api.invalidateCache(); // 쓰기·호스트 전환 등으로 무효화
    respond = () => json(200, { tree: { type: "dir", path: "tree-after", children: [] } });
    const after = await api.fetchTree("notes"); // 무효화 뒤 새 요청 — 진행 중 요청에 합류하지 않는다
    expect(after?.path).toBe("tree-after");
    slow.resolve(json(200, { tree: { type: "dir", path: "tree-before", children: [] } }));
    expect((await before)?.path).toBe("tree-before");
    expect((await api.fetchTree("notes"))?.path).toBe("tree-after"); // 늦은 응답이 캐시를 덮지 않음
    expect(calls).toHaveLength(2);
  });
});

describe("접두어 단위 무효화는 무관한 진행 중 요청·캐시를 건드리지 않는다 (Issue #87)", () => {
  // 이전 구현은 무효화마다 전역 세대 카운터를 올려서, 무관한 vault의 쓰기 한 번에도 그 시점
  // 진행 중이던 모든 요청의 결과가 캐시에서 버려졌다(다음 호출이 다시 받아옴). 무효화는 이제
  // 대상 key의 진행 중 항목만 지우고, 나머지 요청은 결과를 캐시에 남긴다.

  it("무관한 접두어를 무효화해도 진행 중 요청은 결과를 캐시에 남긴다 (동시 호출은 하나로 합쳐진다)", async () => {
    storeActiveHost("local");
    const { api } = await loadTab();
    const slow = deferred();
    let treeCalls = 0;
    respond = () => {
      treeCalls += 1;
      return treeCalls === 1
        ? slow.promise
        : json(200, { tree: { type: "dir", path: "tree-other-2", children: [] } });
    };
    const first = api.fetchTree("other");
    const second = api.fetchTree("other"); // 동시 호출 — 진행 중 요청에 합류한다
    expect(calls).toHaveLength(1);
    api.invalidateCache("pages:notes"); // 다른 vault의 페이지 쓰기
    api.invalidateCache("tree:notes");
    slow.resolve(json(200, { tree: { type: "dir", path: "tree-other", children: [] } }));
    expect((await first)?.path).toBe("tree-other");
    expect(await second).toBe(await first);
    expect(calls).toHaveLength(1);
    // 무효화 이전에 시작된 이 요청의 결과가 캐시에 남아 다시 받지 않는다
    expect((await api.fetchTree("other"))?.path).toBe("tree-other");
    expect(calls).toHaveLength(1);
  });

  it("A vault 쓰기(mutation 경로)는 B vault의 진행 중 트리 요청을 취소하지 않는다", async () => {
    storeActiveHost("local");
    const { api } = await loadTab();
    const slow = deferred();
    let treeCalls = 0;
    respond = (_url, method) => {
      if (method === "POST") return json(200, { ok: true });
      treeCalls += 1;
      return treeCalls === 1
        ? slow.promise
        : json(200, { tree: { type: "dir", path: "tree-b-2", children: [] } });
    };
    const inflight = api.fetchTree("b");
    await api.createPage("a", { slug: "s", title: "t", content: "c", type: "note", tags: [] });
    slow.resolve(json(200, { tree: { type: "dir", path: "tree-b", children: [] } }));
    expect((await inflight)?.path).toBe("tree-b");
    expect((await api.fetchTree("b"))?.path).toBe("tree-b"); // 캐시 적중 — 다시 받지 않는다
    expect(calls).toHaveLength(2); // 트리 1회 + 쓰기 1회
  });

  it("무효화된 접두어의 진행 중 요청은 늦게 끝나도 캐시에 남지 않는다", async () => {
    storeActiveHost("local");
    const { api } = await loadTab();
    const slow = deferred();
    respond = () => slow.promise;
    const before = api.fetchTree("notes");
    api.invalidateCache("tree:notes"); // 이 쓰기로 tree:notes 캐시는 신선하지 않다
    respond = () => json(200, { tree: { type: "dir", path: "tree-after", children: [] } });
    const after = await api.fetchTree("notes"); // 합류하지 않고 새로 요청한다
    expect(after?.path).toBe("tree-after");
    slow.resolve(json(200, { tree: { type: "dir", path: "tree-before", children: [] } }));
    expect((await before)?.path).toBe("tree-before");
    expect((await api.fetchTree("notes"))?.path).toBe("tree-after"); // 늦은 응답이 캐시를 덮지 않음
    expect(calls).toHaveLength(2);
  });

  it("다른 호스트 key를 무효화해도 이 탭의 진행 중 요청 결과는 캐시에 남는다 (호스트 격리 유지)", async () => {
    storeActiveHost("a");
    const { api } = await loadTab();
    const slow = deferred();
    let treeCalls = 0;
    respond = () => {
      treeCalls += 1;
      return treeCalls === 1
        ? slow.promise
        : json(200, { tree: { type: "dir", path: "tree-A-2", children: [] } });
    };
    const inflight = api.fetchTree("notes");
    api.invalidateCache(`tree:notes@${B}`); // 다른 호스트의 같은 vault
    slow.resolve(json(200, { tree: { type: "dir", path: "tree-A", children: [] } }));
    expect((await inflight)?.path).toBe("tree-A");
    expect((await api.fetchTree("notes"))?.path).toBe("tree-A"); // 이 탭 호스트의 캐시는 살아 있다
    expect(calls).toHaveLength(1);
  });
  it("제목 수정(updatePage)도 그 vault의 tree 캐시를 무효화한다 (rename → 옛 제목 재사용 방지)", async () => {
    storeActiveHost("local");
    const { api } = await loadTab();
    let treeCalls = 0;
    respond = (_url, method) => {
      if (method === "PUT") return json(200, { ok: true });
      treeCalls += 1;
      return json(200, {
        tree: { type: "dir", path: treeCalls === 1 ? "t" : "renamed", children: [] },
      });
    };
    expect((await api.fetchTree("notes"))?.path).toBe("t");
    await api.updatePage("notes", "hello", { content: "x", title: "새 제목" });
    expect((await api.fetchTree("notes"))?.path).toBe("renamed"); // 캐시를 재사용하지 않는다
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
  });
});

describe("편집 초안은 호스트별로 분리된다 (Issue #32 D — 다른 호스트 내용 저장 방지)", () => {
  it("초안 키에는 항상 호스트가 들어간다 (원격 = endpoint, 로컬 = local)", async () => {
    storeActiveHost("a");
    const { api } = await loadTab();
    const { draftStorageKey } = await import("../src/lib/api");
    expect(api.getActiveHostId()).toBe("a");
    expect(draftStorageKey("notes", "hello")).toBe(`raven:draft@${A}:notes:hello`);
    vi.resetModules();
    storeActiveHost("local");
    await loadTab();
    const local = await import("../src/lib/api");
    // PR #35 review: 로컬도 레거시 키(raven:draft:<vault>:<slug>)에 쓰지 않는다
    expect(local.draftStorageKey("notes", "hello")).toBe("raven:draft@local:notes:hello");
  });
});

describe("UI 선호도 호스트별로 분리된다 (Issue #32 잔여 — 활성 vault·즐겨찾기·열린 폴더)", () => {
  const FAV = "raven.dashboard.favoriteVaults";

  it("저장 키에 이 탭의 호스트가 들어가고, 쓰기는 호스트별 키로만 간다", async () => {
    const local = await loadTab();
    expect(local.api.hostScopedStorageKey("raven:active_vault")).toBe("raven:active_vault@local");
    local.api.setActiveVault("alpha");
    expect(localStorage.getItem("raven:active_vault@local")).toBe("alpha");
    expect(localStorage.getItem("raven:active_vault")).toBeNull(); // 레거시 키는 고치지 않는다

    vi.resetModules();
    localStorage.clear();
    storeActiveHost("a");
    const remote = await loadTab();
    expect(remote.api.hostScopedStorageKey("raven:active_vault")).toBe(`raven:active_vault@${A}`);
    expect(remote.api.hostScopedStorageKey(FAV)).toBe(`${FAV}@${A}`);
    remote.api.setActiveVault("beta");
    expect(localStorage.getItem(`raven:active_vault@${A}`)).toBe("beta");
    expect(localStorage.getItem("raven:active_vault")).toBeNull();
  });

  it("레거시(호스트 구분 없음) 값은 로컬 탭에서만 초기 선택으로 읽는다", async () => {
    localStorage.setItem("raven:active_vault", "legacy-vault");
    const local = await loadTab();
    expect(local.api.getActiveVault()).toBe("legacy-vault"); // 로컬: 폴백 허용

    vi.resetModules();
    storeActiveHost("a");
    const remote = await loadTab();
    expect(remote.api.getActiveVault()).toBe(""); // 원격: 출처를 알 수 없는 값을 쓰지 않는다
  });

  it("원격 호스트 탭의 사이드바는 그 호스트의 즐겨찾기만 반영한다 (레거시 값 무시)", async () => {
    localStorage.setItem(FAV, JSON.stringify(["gamma"])); // A를 쓰던 시절의 값일 수 있다
    localStorage.setItem(`${FAV}@${A}`, JSON.stringify(["beta"]));
    storeActiveHost("a");
    await loadTab();
    const { render, cleanup, screen } = await import("@testing-library/react");
    const { MemoryRouter } = await import("react-router-dom");
    const { Sidebar } = await import("../src/components/Sidebar");
    const meta = (name: string, isDefault = false) => ({
      name,
      path: `/v/${name}`,
      mode: "personal",
      owner: "u",
      default: isDefault,
    });
    try {
      render(
        <MemoryRouter>
          <Sidebar
            vaults={[meta("alpha", true), meta("beta"), meta("gamma")]}
            trees={{}}
            rawItems={{}}
            activeVault="gamma"
            activeSlug={null}
            onSelectVault={() => {}}
            onRefresh={() => {}}
            open={true}
            onClose={() => {}}
          />
        </MemoryRouter>,
      );
      // A의 즐겨찾기 = beta뿐 → gamma 화면의 토글은 OFF, 정렬은 beta → default alpha → gamma
      const btn = screen.getByRole("button", { name: /즐겨찾기/ }) as HTMLButtonElement;
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.textContent).toContain("☆");
      const select = document.querySelector('select[aria-label="보관소 선택"]') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toEqual(["beta", "alpha", "gamma"]);
    } finally {
      cleanup();
    }
  });
});

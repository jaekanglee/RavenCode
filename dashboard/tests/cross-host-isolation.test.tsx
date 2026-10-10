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

describe("편집 초안은 호스트별로 분리된다 (Issue #32 D — 다른 호스트 내용 저장 방지)", () => {
  it("원격 호스트의 초안 키에는 호스트가 들어가고, 로컬은 기존 키를 그대로 쓴다", async () => {
    storeActiveHost("a");
    const { api } = await loadTab();
    const { draftStorageKey } = await import("../src/lib/api");
    expect(api.getActiveHostId()).toBe("a");
    expect(draftStorageKey("notes", "hello")).toBe(`raven:draft@${A}:notes:hello`);
    vi.resetModules();
    storeActiveHost("local");
    await loadTab();
    const local = await import("../src/lib/api");
    expect(local.draftStorageKey("notes", "hello")).toBe("raven:draft:notes:hello");
  });
});

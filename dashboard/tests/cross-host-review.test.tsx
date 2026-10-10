/* PR #35 review — Issue #32 보완.
 *
 * P1-1 레거시 초안: PR #35 이전에는 모든 호스트의 초안이 `raven:draft:<vault>:<slug>` 한 키에 저장됐다.
 *      원격 호스트 A에서 쓰던 초안이 그 키에 남아 있으면, 같은 vault·slug의 로컬 페이지에 "초안 복구"가 뜨고
 *      복구 → 저장하면 A의 내용이 로컬 페이지를 덮는다. 레거시 키는 어느 호스트의 것인지 알 수 없으므로
 *      편집기로 불러오지 않고(읽기 전용 보기·버리기만), 새 초안은 로컬도 호스트를 넣은 키에 쓴다.
 * P1-2 원격 설정 누락: 원격 호스트를 고른 상태인데 호스트 목록이 없거나 깨졌거나 endpoint가 없으면
 *      수정 전에는 조용히 로컬 Core로 요청했다. 설정 오류로 표시하고 /api 요청을 막는다.
 * P2   부분 무효화의 세대 증가가 관련 없는 키의 진행 중 요청을 틀리게 만들지 않는지 확인한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const A = "http://100.64.0.1:8765";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Call {
  url: string;
  method: string;
  body: string | null;
}
let calls: Call[];
let respond: (url: string) => Response | Promise<Response>;
const realFetch = window.fetch;

function installFetch() {
  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
    return respond(url);
  }) as unknown as typeof fetch;
}

const HOSTS_OK = [
  { id: "local", name: "로컬", endpoint: "", isLocal: true },
  { id: "a", name: "A", endpoint: A, isLocal: false },
];

function storeHosts(active: string, hosts: unknown) {
  if (hosts === undefined) localStorage.removeItem("raven:hosts");
  else localStorage.setItem("raven:hosts", typeof hosts === "string" ? hosts : JSON.stringify(hosts));
  localStorage.setItem("raven:active_host", active);
}

/** 같은 탭의 재로드 — 이전 모듈이 감싼 fetch 래퍼를 버리고 새로 깐다. */
function reloadTab() {
  vi.resetModules();
  window.fetch = realFetch;
  calls = [];
  installFetch();
}

async function loadTab() {
  const base = await import("../src/lib/api-base");
  const api = await import("../src/lib/api");
  return { base, api };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  calls = [];
  respond = () => json(200, { ok: true });
  installFetch();
});

afterEach(() => {
  cleanup();
  window.fetch = realFetch;
});

// ─── P1-1 ─────────────────────────────────────────────────────────────

const VAULT = "notes";
const SLUG = "hello";
const LEGACY_KEY = `raven:draft:${VAULT}:${SLUG}`;
const LOCAL_BODY = "로컬 페이지 원문";
const REMOTE_DRAFT = "원격 A에서 쓰다 만 초안";

async function renderEditor() {
  const { InlineMarkdownEditor } = await import("../src/components/InlineMarkdownEditor");
  return render(
    <MemoryRouter>
      <InlineMarkdownEditor vault={VAULT} slug={SLUG} title="Hello" content={LOCAL_BODY} precondition="1-1" />
    </MemoryRouter>,
  );
}

describe("P1-1 레거시 초안은 다른 호스트의 페이지에 저장되지 않는다", () => {
  it("로컬 페이지에서 레거시 초안을 편집기로 불러오지 않는다 → 저장해도 원격 초안이 로컬을 덮지 않는다", async () => {
    localStorage.setItem(LEGACY_KEY, REMOTE_DRAFT); // PR #35 이전, 원격 A에서 작성
    storeHosts("local", HOSTS_OK);
    await loadTab();
    await renderEditor();

    expect(await screen.findByText(/어느 호스트에서 작성됐는지 알 수 없는 이전 초안/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "초안 복구" })).toBeNull();

    // 사용자가 편집 → 저장해도 레거시 초안 내용은 요청에 실리지 않는다.
    fireEvent.click(await screen.findByLabelText("편집"));
    const editor = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(editor.value).toBe(LOCAL_BODY);
    fireEvent.change(editor, { target: { value: LOCAL_BODY + " 수정" } });
    fireEvent.click(await screen.findByLabelText("저장"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).not.toContain(REMOTE_DRAFT);
    expect(JSON.parse(put.body!).content).toBe(LOCAL_BODY + " 수정");
    // 레거시 초안은 지우지 않는다.
    expect(localStorage.getItem(LEGACY_KEY)).toBe(REMOTE_DRAFT);
  });

  it("레거시 초안 내용은 읽기 전용으로 볼 수 있고, 사용자가 버리기를 눌렀을 때만 지운다", async () => {
    localStorage.setItem(LEGACY_KEY, REMOTE_DRAFT);
    storeHosts("local", HOSTS_OK);
    await loadTab();
    await renderEditor();

    fireEvent.click(await screen.findByRole("button", { name: "이전 초안 내용 보기" }));
    const view = screen.getByLabelText("이전 초안 내용 (읽기 전용)") as HTMLTextAreaElement;
    expect(view.value).toBe(REMOTE_DRAFT);
    expect(view.readOnly).toBe(true);
    expect(localStorage.getItem(LEGACY_KEY)).toBe(REMOTE_DRAFT);

    fireEvent.click(screen.getByRole("button", { name: "이전 초안 버리기" }));
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(screen.queryByText(/알 수 없는 이전 초안/)).toBeNull();
  });

  it("원격 페이지에서도 레거시 초안은 숨기지 않고 같은 읽기 전용 안내로 보인다 (원격 초안 유실 방지)", async () => {
    localStorage.setItem(LEGACY_KEY, REMOTE_DRAFT);
    storeHosts("a", HOSTS_OK);
    await loadTab();
    await renderEditor();
    expect(await screen.findByText(/알 수 없는 이전 초안/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "초안 복구" })).toBeNull();
  });

  it("새 초안은 로컬도 호스트가 들어간 키에 쓴다 — 레거시 키에 섞이지 않는다", async () => {
    storeHosts("local", HOSTS_OK);
    const { api } = await loadTab();
    expect(api.draftStorageKey(VAULT, SLUG)).toBe(`raven:draft@local:${VAULT}:${SLUG}`);
    await renderEditor();
    fireEvent.click(await screen.findByLabelText("편집"));
    fireEvent.change(document.querySelector("textarea")!, { target: { value: "새 로컬 초안" } });
    await waitFor(() => expect(localStorage.getItem(`raven:draft@local:${VAULT}:${SLUG}`)).toBe("새 로컬 초안"));
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("같은 호스트의 새 키 초안은 기존처럼 편집기로 복구된다 (레거시가 함께 있어도 섞이지 않음)", async () => {
    localStorage.setItem(LEGACY_KEY, REMOTE_DRAFT);
    localStorage.setItem(`raven:draft@local:${VAULT}:${SLUG}`, "로컬에서 쓰던 초안");
    storeHosts("local", HOSTS_OK);
    await loadTab();
    await renderEditor();
    fireEvent.click(await screen.findByRole("button", { name: "초안 복구" }));
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("로컬에서 쓰던 초안");
  });
});

// ─── P1-2 ─────────────────────────────────────────────────────────────

const BROKEN: Array<[string, () => void]> = [
  ["활성 ID는 원격인데 raven:hosts가 없음", () => storeHosts("a", undefined)],
  ["호스트 목록 JSON 손상", () => storeHosts("a", "{not json")],
  ["호스트 목록이 배열이 아님", () => storeHosts("a", { a: A })],
  ["활성 ID에 해당하는 호스트가 없음", () => storeHosts("gone", HOSTS_OK)],
  ["endpoint 누락", () => storeHosts("a", [{ id: "a", name: "A", isLocal: false }])],
  ["endpoint 빈 문자열", () => storeHosts("a", [{ id: "a", name: "A", endpoint: "", isLocal: false }])],
  ["endpoint가 URL이 아님", () => storeHosts("a", [{ id: "a", name: "A", endpoint: "not a url", isLocal: false }])],
  ["endpoint가 http(s)가 아님", () => storeHosts("a", [{ id: "a", name: "A", endpoint: "ftp://100.64.0.1", isLocal: false }])],
];

describe("P1-2 원격 호스트 설정이 깨지면 로컬로 조용히 보내지 않고 막는다", () => {
  it.each(BROKEN)("%s → 설정 오류, /api 쓰기·읽기 요청 0건", async (_name, setup) => {
    setup();
    const { base, api } = await loadTab();
    expect(base.getTabHostError()).toBeTruthy();
    await expect(api.updatePage(VAULT, SLUG, { content: "x" })).rejects.toThrow(/호스트 설정/);
    await expect(api.deletePage(VAULT, SLUG)).rejects.toThrow(/호스트 설정/);
    await expect(window.fetch("/api/vaults")).rejects.toThrow(/호스트 설정/);
    expect(navigator.sendBeacon?.("/api/vaults/notes/locks", "x") ?? false).toBe(false);
    expect(calls).toEqual([]);
  });

  it("정상 설정(로컬·원격)은 그대로 동작한다", async () => {
    storeHosts("a", HOSTS_OK);
    let t = await loadTab();
    expect(t.base.getTabHostError()).toBeNull();
    await t.api.updatePage(VAULT, SLUG, { content: "x" });
    expect(calls.map((c) => c.url)).toEqual([`${A}/api/vaults/notes/pages/hello`]);
    reloadTab();
    storeHosts("local", undefined); // 로컬은 목록이 없어도 정상
    t = await loadTab();
    expect(t.base.getTabHostError()).toBeNull();
    await window.fetch("/api/vaults");
    expect(calls.map((c) => c.url)).toEqual(["/api/vaults"]);
  });

  it("설정 오류 화면: 설정 문제를 알리고 앱 화면을 그리지 않으며, '로컬로 전환'은 사용자가 누를 때만", async () => {
    storeHosts("gone", HOSTS_OK);
    await loadTab();
    const { HostConfigGate } = await import("../src/components/HostConfigGate");
    const reload = vi.fn();
    render(
      <HostConfigGate reload={reload}>
        <div>APP-SCREEN</div>
      </HostConfigGate>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/원격 호스트 설정/);
    expect(screen.queryByText("APP-SCREEN")).toBeNull();
    expect(localStorage.getItem("raven:active_host")).toBe("gone"); // 자동 전환 없음
    fireEvent.click(screen.getByRole("button", { name: "로컬로 전환" }));
    expect(localStorage.getItem("raven:active_host")).toBe("local");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("정상 설정이면 게이트는 앱 화면을 그대로 그린다", async () => {
    storeHosts("a", HOSTS_OK);
    await loadTab();
    const { HostConfigGate } = await import("../src/components/HostConfigGate");
    render(
      <HostConfigGate>
        <div>APP-SCREEN</div>
      </HostConfigGate>,
    );
    expect(screen.getByText("APP-SCREEN")).toBeTruthy();
  });

  it("다른 탭에서 이 탭의 원격 호스트가 삭제되면: 이 탭은 재로드 전까지 A로만 보내고, 변경을 감지한다", async () => {
    storeHosts("a", HOSTS_OK);
    const { base, api } = await loadTab();
    const onChange = vi.fn();
    const stop = base.watchTabHostChange(onChange);
    // (1) 선택을 남긴 채 목록에서만 지움 → 재로드하면 설정 오류
    storeHosts("a", [HOSTS_OK[0]]);
    window.dispatchEvent(new StorageEvent("storage", { key: "raven:hosts" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    await api.updatePage(VAULT, SLUG, { content: "x" });
    expect(calls.map((c) => c.url)).toEqual([`${A}/api/vaults/notes/pages/hello`]);
    stop();
    reloadTab();
    const after = await loadTab();
    expect(after.base.getTabHostError()).toBeTruthy();
    await expect(after.api.updatePage(VAULT, SLUG, { content: "x" })).rejects.toThrow(/호스트 설정/);
    expect(calls).toEqual([]);
  });

  it("설정 오류 상태의 탭은 다른 탭이 설정을 고치면 감지해 재로드 대상이 된다", async () => {
    storeHosts("a", undefined);
    const { base } = await loadTab();
    const onChange = vi.fn();
    base.watchTabHostChange(onChange);
    storeHosts("a", HOSTS_OK);
    window.dispatchEvent(new StorageEvent("storage", { key: "raven:hosts" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

// ─── P2 ───────────────────────────────────────────────────────────────

describe("P2 부분 무효화는 관련 없는 키의 진행 중 요청 결과를 틀리게 만들지 않는다", () => {
  it("tree 무효화 중 진행되던 pages 요청: 합류한 호출은 같은 결과를 받고, 다음 조회는 다시 요청한다(성능만 영향)", async () => {
    storeHosts("local", undefined);
    const { api } = await loadTab();
    let release!: (r: Response) => void;
    respond = (url) =>
      /\/pages/.test(url) ? new Promise<Response>((r) => (release = r)) : json(200, { tree: { type: "dir", path: "t", children: [] } });
    const first = api.fetchPages(VAULT);
    api.invalidateCache(`tree:${VAULT}`);
    const joined = api.fetchPages(VAULT); // 관련 없는 키 → 진행 중 요청에 그대로 합류
    release(json(200, { pages: [{ slug: "p1" }] }));
    expect(await first).toEqual(await joined);
    expect(calls.filter((c) => /\/pages/.test(c.url))).toHaveLength(1);
    respond = () => json(200, { pages: [{ slug: "p2" }] });
    expect((await api.fetchPages(VAULT)).map((p: { slug: string }) => p.slug)).toEqual(["p2"]); // 캐시에 안 남아 재요청
    expect(calls.filter((c) => /\/pages/.test(c.url))).toHaveLength(2);
  });
});

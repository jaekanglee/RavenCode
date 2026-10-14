/* Issue #32 잔여 — "같은 호스트 안의 응답 순서: 검색·그래프·페이지".
 *
 * 같은 호스트(같은 탭) 안에서도 slug/vault를 빠르게 바꾸면 이전 요청의 응답이
 * 나중에 도착해 현재 화면을 덮어썼다. 호스트가 바뀌는 경로(PR #35에서 처리)와
 * 달리, 이 경로는 전체 재로드가 없어 React state가 그대로 살아 있다.
 *
 * 회귀 가드:
 *  1. PageView: 이전 slug의 늦은 성공 응답은 현재 문서를 덮지 않는다
 *  2. PageView: 이전 slug의 늦은 실패 응답은 현재 문서를 "찾을 수 없음"으로 만들지 않는다
 *  3. GraphPage: 이전 vault의 늦은 응답은 현재 그래프를 덮지 않는다
 *
 * 검색(SearchPage)은 AbortController로 이미 막혀 있고 apiFetch가 signal을
 * 전달하므로, 여기서는 그 전달 자체를 가드한다(4번).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Link, Outlet, Route, Routes } from "react-router-dom";

import { PageView } from "../src/routes/PageView";
import { GraphPage } from "../src/routes/GraphPage";
import { apiFetch } from "../src/lib/api";

const mocks = vi.hoisted(() => ({
  fetchPage: vi.fn(),
  fetchRecommendations: vi.fn(),
}));

vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  fetchPage: mocks.fetchPage,
  fetchRecommendations: mocks.fetchRecommendations,
  getActiveVault: () => "fallback-vault",
}));

vi.mock("../src/components/MarkdownView", () => ({
  MarkdownView: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));
vi.mock("../src/components/BacklinksPanel", () => ({ BacklinksPanel: () => <div /> }));
vi.mock("../src/components/DeleteButton", () => ({ DeleteButton: () => <button type="button">delete</button> }));
vi.mock("../src/components/PageMetaRow", () => ({ PageMetaRow: () => <div /> }));
vi.mock("../src/components/FloatingGraphPanel", () => ({ FloatingGraphPanel: () => <div /> }));
vi.mock("../src/components/FullscreenGraphModal", () => ({ FullscreenGraphModal: () => null }));

vi.mock("../src/components/GraphCanvas", async () => {
  const actual = await vi.importActual<typeof import("../src/components/GraphCanvas")>(
    "../src/components/GraphCanvas"
  );
  return {
    ...actual,
    GraphCanvas: (props: any) => (
      <div data-testid="graph-canvas">
        {props.nodes.map((node: any) => (
          <span key={node.id}>{node.title}</span>
        ))}
      </div>
    ),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pageData = (slug: string, title: string) => ({
  slug,
  file_path: `${slug}.md`,
  content: `# ${title}\n\n본문`,
  backlinks: [],
  frontmatter: { title, type: "concept", tags: "", created: "2026-07-01", updated: "2026-07-01" },
});

function OutletShell() {
  return <Outlet context={{ vault: "ctx-vault", refresh: vi.fn() }} />;
}

function renderPageView() {
  return render(
    <MemoryRouter initialEntries={["/page/alpha/content/a"]}>
      <Link to="/page/alpha/content/b" data-testid="go-b">
        go-b
      </Link>
      <Routes>
        <Route element={<OutletShell />}>
          <Route path="/page/:vault/*" element={<PageView />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

const heading = () => screen.getByRole("heading", { level: 1 }).textContent;

describe("Issue #32 잔여 — 같은 호스트 안의 응답 순서", () => {
  beforeEach(() => {
    mocks.fetchPage.mockReset();
    mocks.fetchRecommendations.mockReset();
    mocks.fetchRecommendations.mockResolvedValue({ recommendations: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PageView: 이전 slug의 늦은 성공 응답이 현재 문서를 덮지 않는다", async () => {
    const slowA = deferred<ReturnType<typeof pageData>>();
    const fastB = deferred<ReturnType<typeof pageData>>();
    mocks.fetchPage.mockImplementation((_vault: string, slug: string) =>
      slug === "content/a" ? slowA.promise : fastB.promise
    );

    renderPageView();
    await waitFor(() => expect(mocks.fetchPage).toHaveBeenCalledWith("alpha", "content/a"));

    // B로 이동 — A 요청은 아직 pending이다.
    fireEvent.click(screen.getByTestId("go-b"));
    await waitFor(() => expect(mocks.fetchPage).toHaveBeenCalledWith("alpha", "content/b"));

    await act(async () => {
      fastB.resolve(pageData("content/b", "B 문서"));
      await fastB.promise;
    });
    await waitFor(() => expect(heading()).toBe("B 문서"));

    // 뒤늦게 도착한 A 응답은 버려져야 한다.
    await act(async () => {
      slowA.resolve(pageData("content/a", "A 문서"));
      await slowA.promise;
    });

    expect(heading()).toBe("B 문서");
  });

  it("PageView: 이전 slug의 늦은 실패가 현재 문서를 '찾을 수 없음'으로 만들지 않는다", async () => {
    const slowA = deferred<ReturnType<typeof pageData>>();
    const fastB = deferred<ReturnType<typeof pageData>>();
    mocks.fetchPage.mockImplementation((_vault: string, slug: string) =>
      slug === "content/a" ? slowA.promise : fastB.promise
    );

    renderPageView();
    await waitFor(() => expect(mocks.fetchPage).toHaveBeenCalledWith("alpha", "content/a"));

    fireEvent.click(screen.getByTestId("go-b"));
    await waitFor(() => expect(mocks.fetchPage).toHaveBeenCalledWith("alpha", "content/b"));

    await act(async () => {
      fastB.resolve(pageData("content/b", "B 문서"));
      await fastB.promise;
    });
    await waitFor(() => expect(heading()).toBe("B 문서"));

    await act(async () => {
      slowA.reject(new Error("A not found"));
      await slowA.promise.catch(() => {});
    });

    expect(heading()).toBe("B 문서");
    expect(screen.queryByText("문서를 찾을 수 없습니다")).toBeNull();
  });

  it("GraphPage: 이전 vault의 늦은 응답이 현재 그래프를 덮지 않는다", async () => {
    const slowA = deferred<any>();
    const fastB = deferred<any>();
    const graph = (title: string) => ({
      nodes: [
        { id: `content/${title}1`, slug: `content/${title}1`, title, type: "concept", weight: 1 },
        { id: `content/${title}2`, slug: `content/${title}2`, title: `${title}2`, type: "concept", weight: 1 },
      ],
      edges: [{ source: `content/${title}1`, target: `content/${title}2` }],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const d = /\/api\/vaults\/([^/]+)\/graph/.exec(url)?.[1];
        const body = d === "order-vault-a" ? await slowA.promise : await fastB.promise;
        return { ok: true, json: async () => body } as unknown as Response;
      }) as unknown as typeof fetch
    );

    function VaultShell() {
      const [vault, setVault] = useState("order-vault-a");
      return (
        <>
          <button type="button" data-testid="switch-vault" onClick={() => setVault("order-vault-b")}>
            switch
          </button>
          <Outlet context={{ vault }} />
        </>
      );
    }

    render(
      <MemoryRouter initialEntries={["/graph"]}>
        <Routes>
          <Route element={<VaultShell />}>
            <Route path="/graph" element={<GraphPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTestId("switch-vault"));

    await act(async () => {
      fastB.resolve(graph("B그래프"));
      await fastB.promise;
    });
    await waitFor(() => expect(screen.getByText("B그래프")).toBeTruthy());

    await act(async () => {
      slowA.resolve(graph("A그래프"));
      await slowA.promise;
    });

    expect(screen.getByText("B그래프")).toBeTruthy();
    expect(screen.queryByText("A그래프")).toBeNull();
  });
});

describe("apiFetch는 AbortSignal을 fetch로 전달한다", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SearchPage의 이전 검색 취소가 실제로 요청을 끊는다", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init?: RequestInit) => {
        seen.push(init?.signal ?? undefined);
        return { ok: true, json: async () => ({ results: [] }) } as unknown as Response;
      }) as unknown as typeof fetch
    );

    const ctrl = new AbortController();
    await apiFetch("/api/vaults/v/hybrid-search?query=x", { signal: ctrl.signal });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(ctrl.signal);
  });
});

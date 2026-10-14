import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { PageView } from "../src/routes/PageView";

const mocks = vi.hoisted(() => ({
  fetchPage: vi.fn(),
  fetchRecommendations: vi.fn(),
  floatingPanel: vi.fn(),
  fullscreenModal: vi.fn(),
}));

// v0.7.180: 모듈 전체를 대체하면 PageView가 쓰는 apiFetch(그래프 fetch)가 빠져
// 렌더 자체가 죽는다. 실제 apiFetch를 남겨 stub된 global fetch를 타게 하고,
// 단언 대상인 fetchPage/fetchRecommendations만 교체한다.
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  fetchPage: mocks.fetchPage,
  fetchRecommendations: mocks.fetchRecommendations,
  getActiveVault: () => "fallback-vault",
}));

vi.mock("../src/components/MarkdownView", () => ({
  MarkdownView: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

vi.mock("../src/components/BacklinksPanel", () => ({
  BacklinksPanel: () => <div data-testid="backlinks" />,
}));

vi.mock("../src/components/DeleteButton", () => ({
  DeleteButton: () => <button type="button">delete</button>,
}));

vi.mock("../src/components/PageMetaRow", () => ({
  PageMetaRow: () => <div data-testid="page-meta" />,
}));

vi.mock("../src/components/FloatingGraphPanel", () => ({
  FloatingGraphPanel: (props: any) => {
    mocks.floatingPanel(props);
    return (
      <button type="button" data-testid="open-full-graph" onClick={props.onOpenFullGraph}>
        open
      </button>
    );
  },
}));

vi.mock("../src/components/FullscreenGraphModal", () => ({
  FullscreenGraphModal: (props: any) => {
    mocks.fullscreenModal(props);
    return <div data-testid="fullscreen-graph-modal" />;
  },
}));

function OutletShell() {
  return <Outlet context={{ vault: "ctx-vault", refresh: vi.fn() }} />;
}

describe("PageView graph scope", () => {
  beforeEach(() => {
    mocks.fetchPage.mockReset();
    mocks.fetchRecommendations.mockReset();
    mocks.fetchRecommendations.mockResolvedValue({ ok: true, recommendations: [] });
    mocks.floatingPanel.mockReset();
    mocks.fullscreenModal.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the fullscreen graph scoped to the current page neighborhood, not the whole vault", async () => {
    mocks.fetchPage.mockResolvedValue({
      slug: "content/a",
      file_path: "content/a.md",
      content: ["# A", "", "본문", "", "관련", "[[content/b]]"].join("\n"),
      backlinks: [],
      frontmatter: {
        title: "A",
        type: "concept",
        tags: "alpha",
        created: "2026-07-01",
        updated: "2026-07-01",
      },
    });

    const graphResponse = {
      nodes: [
        { id: "content/a", slug: "content/a", title: "A", x: 0, y: 0 },
        { id: "content/b", slug: "content/b", title: "B", x: 120, y: 10 },
        { id: "content/c", slug: "content/c", title: "C", x: -80, y: 30 },
        { id: "content/d", slug: "content/d", title: "D", x: 260, y: 40 },
      ],
      edges: [
        { source: "content/a", target: "content/b" },
        { source: "content/c", target: "content/a" },
        { source: "content/b", target: "content/d" },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => graphResponse,
      })
    );

    const view = render(
      <MemoryRouter initialEntries={["/page/alpha/content/a"]}>
        <Routes>
          <Route element={<OutletShell />}>
            <Route path="/page/:vault/*" element={<PageView />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mocks.floatingPanel).toHaveBeenCalled();
    });

    const floatingProps = mocks.floatingPanel.mock.calls.at(-1)?.[0];
    expect(floatingProps.currentNodeId).toBe("content/a");
    expect(floatingProps.nodes.map((node: any) => node.id)).toEqual(["content/a", "content/b"]);
    expect(floatingProps.edges).toEqual([{ source: "content/a", target: "content/b" }]);

    fireEvent.click(view.getByTestId("open-full-graph"));

    await waitFor(() => {
      expect(mocks.fullscreenModal).toHaveBeenCalled();
    });

    const fullscreenProps = mocks.fullscreenModal.mock.calls.at(-1)?.[0];
    expect(fullscreenProps.currentNodeId).toBe("content/a");
    expect(fullscreenProps.centerTitle).toBe("A 관련 그래프");
    expect(fullscreenProps.nodes.map((node: any) => node.id)).toEqual(["content/a", "content/b"]);
    expect(fullscreenProps.edges).toEqual([{ source: "content/a", target: "content/b" }]);
  });
});

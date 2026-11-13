import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { GraphPage } from "../src/routes/GraphPage";

// 그래프 탭 문서 검색: 하이브리드 검색에 걸린 문서를 노드 제거 없이 강조만 한다.
const mockGraphCanvas = vi.fn();

vi.mock("../src/components/GraphCanvas", async () => {
  const actual = await vi.importActual<typeof import("../src/components/GraphCanvas")>(
    "../src/components/GraphCanvas"
  );
  return {
    ...actual,
    GraphCanvas: (props: any) => {
      mockGraphCanvas(props);
      return (
        <div data-testid="graph-canvas">
          {props.nodes.map((node: any) => (
            <span key={node.id} data-testid={`graph-node-${node.id}`} />
          ))}
        </div>
      );
    },
  };
});

vi.mock("../src/components/FullscreenGraphModal", () => ({
  FullscreenGraphModal: () => null,
}));

function OutletShell() {
  return <Outlet context={{ vault: "search-highlight-vault" }} />;
}

const graphPayload = {
  nodes: [
    { id: "a", slug: "a", title: "Alpha", type: "concept", weight: 1 },
    { id: "b", slug: "b", title: "Beta", type: "tool", weight: 1 },
    { id: "c", slug: "c", title: "Gamma", type: "project", weight: 1 },
  ],
  edges: [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ],
};

const lastCanvasProps = () => mockGraphCanvas.mock.calls[mockGraphCanvas.mock.calls.length - 1][0];

describe("GraphPage search highlight", () => {
  it("highlights hybrid-search hits without removing other nodes", async () => {
    mockGraphCanvas.mockReset();
    const fetchMock = vi.fn((url: string) => {
      const body = url.includes("/hybrid-search")
        ? { results: [{ slug: "c", title: "Gamma", type: "project", score: 1, bm25_score: 1, distance: 0, method: "hybrid" }] }
        : graphPayload;
      return Promise.resolve({ ok: true, json: async () => body });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/graph"]}>
        <Routes>
          <Route element={<OutletShell />}>
            <Route path="/graph" element={<GraphPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.queryByTestId("graph-node-a")).not.toBeNull());
    expect(lastCanvasProps().externalHighlightNodeIds).toBeNull();

    // 본문 검색이라 제목에 없는 단어여도 서버 결과대로 강조된다.
    fireEvent.change(screen.getByPlaceholderText(/문서 검색/), { target: { value: "본문키워드" } });

    await waitFor(() => {
      const ids = lastCanvasProps().externalHighlightNodeIds as Set<string> | null;
      expect(ids && [...ids]).toEqual(["c"]);
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/hybrid-search"))).toBe(true);
    // 필터가 아니라 강조 — 나머지 노드는 그대로 남는다.
    expect(lastCanvasProps().nodes.map((n: any) => n.id).sort()).toEqual(["a", "b", "c"]);

    fireEvent.change(screen.getByPlaceholderText(/문서 검색/), { target: { value: "" } });
    await waitFor(() => expect(lastCanvasProps().externalHighlightNodeIds).toBeNull());
  });
});

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { GraphPage } from "../src/routes/GraphPage";

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

vi.mock("../src/components/FullscreenGraphModal", () => ({
  FullscreenGraphModal: () => null,
}));

function renderGraphPage(vault: string) {
  function OutletShell() {
    return <Outlet context={{ vault }} />;
  }
  return render(
    <MemoryRouter initialEntries={["/graph"]}>
      <Routes>
        <Route element={<OutletShell />}>
          <Route path="/graph" element={<GraphPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("GraphPage graph cache", () => {
  it("다시 방문하면 이전 그래프를 즉시 보여주고 백그라운드에서 새로 받는다", async () => {
    const graph = {
      nodes: [
        { id: "content/a", slug: "content/a", title: "캐시된 A", type: "concept", weight: 1 },
        { id: "content/b", slug: "content/b", title: "캐시된 B", type: "concept", weight: 1 },
      ],
      edges: [{ source: "content/a", target: "content/b" }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => graph }));
    const first = renderGraphPage("cache-vault");
    await waitFor(() => expect(screen.getByText("캐시된 A")).toBeTruthy());
    first.unmount();

    // 두 번째 방문: 응답이 오지 않아도(문서 수정 직후 DB 재빌드 중) 이전 그래프가 보여야 한다.
    const pending = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", pending);
    renderGraphPage("cache-vault");

    expect(screen.getByText("캐시된 A")).toBeTruthy();
    expect(screen.queryByText("그래프를 불러오는 중입니다")).toBeNull();
    expect(pending).toHaveBeenCalled();
  });
});

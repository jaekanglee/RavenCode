/* Issue #3 C-1 — 사이드바 하단 위젯은 "Stats"인데 수치가 하나도 없었다.
 *
 * 수정 전: vault 이름만 200px 위 셀렉터와 중복 표시하고 페이지/링크 수는 없었다.
 * 수정 후: 이미 렌더에 쓰는 정규화 트리·raw 목록에서 페이지·raw 수를 센다.
 *
 * 두 가지를 지킨다.
 *   1) 트리가 있으면 실제 수치를 보여준다 (0으로 굳지 않는다).
 *   2) 트리가 아직 없으면(미선택·로딩) 0이라고 단정하지 않는다 — 없는 것과 0개는 다르다.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "../src/components/Sidebar";
import type { RawItem } from "../src/lib/api";
import type { TreeNode } from "../src/types";

const VAULTS = [{ name: "test", path: "/tmp/test", mode: "personal", owner: "user", default: true }];

const TREE: TreeNode = {
  type: "dir",
  path: "content",
  children: [
    { type: "page", path: "content/a", slug: "a", title: "A", pageType: "concept" },
    { type: "page", path: "content/b", slug: "b", title: "B", pageType: "concept" },
    { type: "page", path: "content/c", slug: "c", title: "C", pageType: "note" },
  ],
};

const RAW_ITEMS: RawItem[] = [
  { path: "raw/notes.md", name: "notes.md", type: "file", kind: "raw" },
  { path: "raw/log.md", name: "log.md", type: "file", kind: "raw" },
];

function renderSidebar(trees: Record<string, TreeNode | null>) {
  return render(
    <MemoryRouter>
      <Sidebar
        vaults={VAULTS}
        trees={trees}
        activeVault="test"
        activeSlug={null}
        onSelectVault={() => {}}
        onRefresh={() => {}}
        open={true}
        onClose={() => {}}
        rawItems={{ test: RAW_ITEMS }}
      />
    </MemoryRouter>
  );
}

describe("Sidebar Stats 위젯 (Issue #3 C-1)", () => {
  it("트리와 raw 목록에서 실제 수치를 보여준다", () => {
    renderSidebar({ test: TREE });

    expect(screen.getByText("현재 보관소")).toBeTruthy();
    expect(screen.getByText("페이지 3")).toBeTruthy();
    expect(screen.getByText("raw 2")).toBeTruthy();
  });

  it("트리가 아직 없으면 0으로 단정하지 않고 수치 줄을 생략한다", () => {
    renderSidebar({ test: null });

    expect(screen.getByText("현재 보관소")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-stats-counts")).toBeNull();
  });
});

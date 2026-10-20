/* 사이드바 초안 표시 (spec 2026-10-20-draft-review-queue-design).
 *
 *  1) draft가 있으면 vault 섹션 맨 위에 "검토 대기 N" 줄이 생기고 /review/<vault>로 간다
 *  2) draft 문서 행에는 점, 그룹(폴더) 행에는 하위 draft 개수
 *  3) draft가 없거나 손님 탭이면 검토 대기 줄이 없다
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import type { TreeNode } from "../src/types";

const guest = vi.hoisted(() => ({ on: false }));
vi.mock("../src/lib/guest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/guest")>()),
  isGuestTab: () => guest.on,
}));

import { Sidebar } from "../src/components/Sidebar";

const VAULTS = [{ name: "test", path: "/tmp/test", mode: "personal", owner: "user", default: true }];

const TREE: TreeNode = {
  type: "dir",
  path: "content",
  children: [
    {
      type: "dir",
      path: "content/issues",
      children: [
        { type: "page", path: "content/issues/a", slug: "content/issues/a", title: "A", pageType: "issue", status: "draft" },
        { type: "page", path: "content/issues/b", slug: "content/issues/b", title: "B", pageType: "issue", status: "draft" },
      ],
    },
    { type: "page", path: "content/c", slug: "content/c", title: "C", pageType: "concept", status: "draft" },
    { type: "page", path: "content/d", slug: "content/d", title: "D", pageType: "concept", status: "current" },
  ],
};

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderSidebar(tree: TreeNode) {
  localStorage.clear();
  render(
    <MemoryRouter>
      <Sidebar
        vaults={VAULTS}
        trees={{ test: tree }}
        activeVault="test"
        activeSlug={null}
        onSelectVault={() => {}}
        onRefresh={() => {}}
        open={true}
        onClose={() => {}}
        rawItems={{ test: [] }}
      />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  // vault 섹션은 접힌 채로 시작한다 — 펼친다.
  fireEvent.click(screen.getByText("test", { selector: ".sidebar-vault-name" }));
}

afterEach(() => {
  guest.on = false;
});

describe("사이드바 초안 표시", () => {
  it("검토 대기 줄이 개수를 보이고 검토 화면으로 간다", () => {
    renderSidebar(TREE);

    fireEvent.click(screen.getByRole("button", { name: "검토 대기 3건" }));

    expect(screen.getByTestId("where").textContent).toBe("/review/test");
  });

  it("draft 문서 행에 점, 그룹 행에 하위 draft 개수를 붙인다", () => {
    renderSidebar(TREE);

    // 사이드바는 문서를 type 그룹으로 묶는다(normalizeSidebarTree): issue 그룹에 A·B, concept 그룹에 C·D.
    expect(screen.getByRole("img", { name: "초안 2개" })).toBeTruthy();
    const concept = screen.getByRole("img", { name: "초안 1개" }).closest("button")!;
    expect(screen.queryAllByRole("img", { name: "검토 대기" })).toHaveLength(0); // 그룹은 접힌 채로 시작

    fireEvent.click(concept);

    expect(screen.getAllByRole("img", { name: "검토 대기" })).toHaveLength(1); // C만 draft
  });

  it("draft가 없으면 검토 대기 줄이 없다", () => {
    renderSidebar({ type: "dir", path: "content", children: [TREE.children![2]] });

    expect(screen.queryByRole("button", { name: /검토 대기/ })).toBeNull();
  });

  it("손님 탭에서는 검토 대기 줄을 숨긴다", () => {
    guest.on = true;
    renderSidebar(TREE);

    expect(screen.queryByRole("button", { name: /검토 대기/ })).toBeNull();
  });
});

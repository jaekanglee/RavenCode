/* 사이드바 문서 우클릭 메뉴 — 공유하기 / 삭제.
 *
 *  1) 문서 줄을 우클릭하면 메뉴가 뜨고 Escape로 닫힌다
 *  2) 삭제 → 확인 → deletePage(slug) 호출 후 트리 새로고침
 *  3) 공유하기 → 기존 공유 팝오버가 열린다
 *  4) 손님 탭에는 삭제가 없다 (DELETE pages는 owner 전용)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import type { TreeNode } from "../src/types";
import * as api from "../src/lib/api";

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
    { type: "page", path: "content/notes/c", slug: "content/notes/c", title: "Charlie", pageType: "concept", status: "current" },
  ],
};

function renderSidebar(onRefresh = vi.fn()) {
  localStorage.clear();
  render(
    <MemoryRouter>
      <Sidebar
        vaults={VAULTS}
        trees={{ test: TREE }}
        activeVault="test"
        activeSlug={null}
        onSelectVault={() => {}}
        onRefresh={onRefresh}
        open={true}
        onClose={() => {}}
        rawItems={{ test: [] }}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText("test", { selector: ".sidebar-vault-name" }));
  // 문서는 type 그룹(concept) 아래에 접힌 채로 시작한다 — 펼친다.
  fireEvent.click(screen.getByRole("button", { name: /^concept/ }));
  return onRefresh;
}

function rightClickPage() {
  fireEvent.contextMenu(screen.getByRole("button", { name: /Charlie/ }), { clientX: 40, clientY: 60 });
}

beforeEach(() => {
  vi.spyOn(api, "fetchSystemInfo").mockResolvedValue(null);
});

afterEach(() => {
  guest.on = false;
  vi.restoreAllMocks();
});

describe("사이드바 문서 우클릭 메뉴", () => {
  it("우클릭하면 공유하기·삭제 메뉴가 뜨고 Escape로 닫힌다", () => {
    renderSidebar();
    rightClickPage();

    const menu = screen.getByRole("menu", { name: "문서 메뉴" });
    expect(screen.getByRole("menuitem", { name: "공유하기" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "삭제" })).toBeTruthy();

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "문서 메뉴" })).toBeNull();
  });

  it("삭제를 확인하면 deletePage를 부르고 트리를 새로고침한다", async () => {
    const del = vi.spyOn(api, "deletePage").mockResolvedValue({ ok: true });
    const onRefresh = renderSidebar();
    rightClickPage();

    fireEvent.click(screen.getByRole("menuitem", { name: "삭제" }));
    // 메뉴는 닫히고 확인 창만 남는다. 확인 전에는 지우지 않는다.
    expect(screen.queryByRole("menu", { name: "문서 메뉴" })).toBeNull();
    expect(del).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "삭제" }));

    await waitFor(() => expect(del).toHaveBeenCalledWith("test", "notes/c"));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it("공유하기는 공유 팝오버를 연다", async () => {
    renderSidebar();
    rightClickPage();

    fireEvent.click(screen.getByRole("menuitem", { name: "공유하기" }));

    await waitFor(() => expect(screen.getByTestId("share-popover")).toBeTruthy());
    expect(screen.queryByRole("menu", { name: "문서 메뉴" })).toBeNull();
  });

  it("손님 탭에는 삭제가 없다", () => {
    guest.on = true;
    renderSidebar();
    rightClickPage();

    expect(screen.getByRole("menuitem", { name: "공유하기" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "삭제" })).toBeNull();
  });
});

/* v0.7.181 — 사이드바 dir row "＋"(새 페이지)의 프리필 (경로 + 문서 분류).
 *
 * v0.7.111 canonical tree view 이후 사이드바 트리의 dir 노드는 전부
 * `__canonical/<type>` 가상 그룹이다 (실제 폴더가 아님). 그런데 TreeLeaf가
 * 그 가상 path를 NewPageButton initialSlug로 그대로 넘겨서, content/issue
 * 그룹 옆 "＋"를 누르면 경로가 `__canonical/issue`로 잡혔다. 그대로 저장하면
 * 백엔드 normalize_prefix가 content/를 붙여 `content/__canonical/issue.md`를
 * 만든다 — UI 내부 sentinel이 vault 파일시스템에 새는 오염.
 *
 * 회귀 가드:
 *  1. canonical 그룹 "＋" → 그룹 페이지들의 공통 부모 폴더 (예: content/issues/)
 *  2. 공통 부모가 없으면 content/ 폴백
 *  3. 어떤 그룹에서도 __canonical 이 프리필로 새지 않음
 *  4. 실제 dir 노드는 자기 경로 + trailing slash (마지막 segment=파일명 여지)
 *  5. canonical 그룹 "＋"는 그룹의 SCHEMA type을 문서 분류로 프리필 —
 *     안 하면 issue 그룹에서 만든 페이지가 type=concept으로 저장돼 방금
 *     클릭한 그룹이 아닌 "일반 노트" 그룹으로 들어간다.
 *  6. NewPageButton이 모르는 type(misc 등)은 무시하고 기본값 유지
 *  7. DOM: 사이드바에서 실제로 "＋"를 눌렀을 때 모달 "경로"/"문서 분류" 값
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  Sidebar,
  newPageTargetSlug,
  newPageTargetType,
  normalizeSidebarTree,
} from "../src/components/Sidebar";
import { NewPageButton } from "../src/components/NewPageButton";
import type { TreeNode } from "../src/types";

function group(type: string, pagePaths: string[]): TreeNode {
  return {
    type: "dir",
    path: `__canonical/${type}`,
    children: pagePaths.map((p) => ({
      type: "page" as const,
      path: p,
      slug: p,
      title: p.split("/").pop(),
      pageType: type,
    })),
  };
}

describe("Sidebar ＋ (새 페이지) 경로 프리필", () => {
  it("canonical 그룹은 그룹 페이지들의 공통 부모 폴더를 쓴다", () => {
    expect(
      newPageTargetSlug(group("issue", ["content/issues/a", "content/issues/b"]))
    ).toBe("content/issues/");
  });

  it("공통 부모가 더 깊어도 그 깊이까지 따라간다", () => {
    expect(
      newPageTargetSlug(group("rule", ["content/ops/rules/a", "content/ops/rules/b"]))
    ).toBe("content/ops/rules/");
  });

  it("페이지들이 서로 다른 폴더에 흩어져 있으면 공통 부모까지만", () => {
    expect(
      newPageTargetSlug(group("issue", ["content/issues/a", "content/bugs/b"]))
    ).toBe("content/");
  });

  it("flat 페이지 그룹은 content/ 폴백", () => {
    expect(newPageTargetSlug(group("concept", ["content/flat"]))).toBe("content/");
  });

  it("페이지가 없는 그룹도 content/ 폴백 (빈 그룹 방어)", () => {
    expect(newPageTargetSlug(group("misc", []))).toBe("content/");
  });

  it("실제 dir 노드는 자기 경로 + trailing slash", () => {
    const dir: TreeNode = { type: "dir", path: "content/concepts", children: [] };
    expect(newPageTargetSlug(dir)).toBe("content/concepts/");
  });

  it("canonical 그룹은 그룹의 SCHEMA type을 문서 분류로 넘긴다", () => {
    expect(newPageTargetType(group("issue", ["content/issues/a"]))).toBe("issue");
    expect(newPageTargetType(group("rule", ["content/rules/a"]))).toBe("rule");
  });

  it("실제 dir 노드는 문서 분류를 강제하지 않는다", () => {
    const dir: TreeNode = { type: "dir", path: "content/concepts", children: [] };
    expect(newPageTargetType(dir)).toBeUndefined();
  });

  it("normalizeSidebarTree가 만든 어떤 그룹도 __canonical 을 프리필로 새지 않는다", () => {
    const tree: TreeNode = {
      type: "dir",
      path: "content",
      children: [
        { type: "page", path: "content/issues/x", slug: "content/issues/x", pageType: "issue" },
        { type: "page", path: "content/flat", slug: "content/flat", pageType: "concept" },
        { type: "page", path: "content/weird", slug: "content/weird", pageType: "?" },
      ],
    };
    const normalized = normalizeSidebarTree(tree);
    const groups = normalized?.children ?? [];
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(newPageTargetSlug(g)).not.toContain("__canonical");
    }
  });
});

const ISSUE_TREE: TreeNode = {
  type: "dir",
  path: "content",
  children: [
    {
      type: "dir",
      path: "content/issues",
      children: [
        {
          type: "page",
          path: "content/issues/2026-09-01-foo",
          slug: "content/issues/2026-09-01-foo",
          title: "Foo",
          pageType: "issue",
        },
      ],
    },
  ],
};

describe("Sidebar ＋ DOM 통합 (issue 그룹)", () => {
  it("issue 그룹 ＋ 클릭 시 모달 경로가 content/issues/ 로 채워진다", async () => {
    render(
      <MemoryRouter>
        <Sidebar
          vaults={[{ name: "test", path: "/tmp/test", mode: "personal", owner: "user", default: true }]}
          trees={{ test: ISSUE_TREE }}
          activeVault="test"
          activeSlug={null}
          onSelectVault={() => {}}
          onRefresh={() => {}}
          open={true}
          onClose={() => {}}
          rawItems={{}}
        />
      </MemoryRouter>
    );

    // vault row 펼치기
    const vaultChevron = document.querySelector(".sidebar-chevron");
    if (!vaultChevron) throw new Error("vaultChevron not found");
    fireEvent.click(vaultChevron);

    // issue 그룹 row의 ＋ (dir row와 같은 flex 컨테이너의 sidebar-icon-action)
    const groupLabel = await screen.findByText("issue");
    const row = groupLabel.closest("div");
    const plus = row?.querySelector("button.sidebar-icon-action");
    if (!plus) throw new Error("group ＋ button not found");
    fireEvent.click(plus);

    await waitFor(() => screen.getByLabelText(/^경로/));
    const pathInput = screen.getByLabelText(/^경로/) as HTMLInputElement;
    expect(pathInput.value).toBe("content/issues/");
    expect(pathInput.value).not.toContain("__canonical");

    // 문서 분류는 "세부 옵션" 안에 있다.
    fireEvent.click(screen.getByRole("button", { name: "세부 옵션" }));
    const typeSelect = screen.getByLabelText(/문서 분류/) as HTMLSelectElement;
    expect(typeSelect.value).toBe("issue");
  });
});

describe("NewPageButton initialType 수용 범위", () => {
  it("모르는 type(misc)은 무시하고 기본값 concept 유지", async () => {
    render(
      <MemoryRouter>
        <NewPageButton vault="test" variant="icon" initialType="misc" />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole("button", { name: /페이지 만들기/ }));
    await waitFor(() => screen.getByRole("button", { name: "세부 옵션" }));
    fireEvent.click(screen.getByRole("button", { name: "세부 옵션" }));
    const typeSelect = screen.getByLabelText(/문서 분류/) as HTMLSelectElement;
    expect(typeSelect.value).toBe("concept");
  });
});

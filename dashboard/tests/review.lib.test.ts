/* 초안 검토 대기열 순수 함수 (spec 2026-10-20-draft-review-queue-design). */
import { describe, expect, it } from "vitest";

import { countDrafts, isDraftStatus, summarizeApproval } from "../src/lib/review";
import type { TreeNode } from "../src/types";

const TREE: TreeNode = {
  type: "dir",
  path: "content",
  children: [
    { type: "page", path: "content/a", slug: "content/a", title: "A", pageType: "concept", status: "draft" },
    { type: "page", path: "content/b", slug: "content/b", title: "B", pageType: "concept", status: "current" },
    {
      type: "dir",
      path: "content/issues",
      children: [
        { type: "page", path: "content/issues/c", slug: "content/issues/c", title: "C", pageType: "issue", status: "draft" },
        { type: "dir", path: "content/issues/empty", children: [] },
      ],
    },
  ],
};

describe("isDraftStatus", () => {
  it("draft만 참이다", () => {
    expect(isDraftStatus("draft")).toBe(true);
    expect(isDraftStatus(" draft ")).toBe(true);
    expect(isDraftStatus("current")).toBe(false);
    expect(isDraftStatus(undefined)).toBe(false);
  });
});

describe("countDrafts", () => {
  it("중첩 폴더까지 draft 문서를 센다", () => {
    expect(countDrafts(TREE)).toBe(2);
    expect(countDrafts(TREE.children![2])).toBe(1);
  });

  it("트리가 없으면 0", () => {
    expect(countDrafts(null)).toBe(0);
  });
});

describe("summarizeApproval", () => {
  it("모두 승인되면 승인 수만 말한다", () => {
    expect(summarizeApproval([{ result: "approved" }, { result: "approved" }])).toBe("✅ 2건 승인");
  });

  it("건너뛴 이유를 종류별로 센다", () => {
    expect(
      summarizeApproval([
        { result: "approved" },
        { result: "not_draft" },
        { result: "not_draft" },
        { result: "stale_precondition" },
      ]),
    ).toBe("✅ 1건 승인 · 3건 건너뜀(이미 승인됨 2, 내용 변경됨 1)");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyFindHighlights,
  clearFindHighlights,
  collectTextRanges,
  FIND_HIGHLIGHT,
  FIND_HIGHLIGHT_CURRENT,
} from "../src/lib/domFind";

function mount(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("collectTextRanges", () => {
  it("여러 텍스트 노드에 걸친 일치를 문서 순서로 모은다", () => {
    const root = mount("<p>백업 하나</p><p><strong>백업</strong> 둘</p>");
    const ranges = collectTextRanges(root, "백업");
    expect(ranges).toHaveLength(2);
    expect(ranges.map((r) => r.toString())).toEqual(["백업", "백업"]);
  });
  it("빈 검색어는 빈 배열", () => {
    expect(collectTextRanges(mount("<p>x</p>"), "")).toEqual([]);
  });
});

describe("applyFindHighlights", () => {
  it("Highlight API가 없으면 아무것도 하지 않는다 (에러 없음)", () => {
    const root = mount("<p>a a</p>");
    expect(() => applyFindHighlights(collectTextRanges(root, "a"), 0)).not.toThrow();
    expect(() => clearFindHighlights()).not.toThrow();
  });

  it("현재 항목은 별도 이름으로, 나머지는 기본 이름으로 등록한다", () => {
    const registry = new Map<string, { ranges: Range[] }>();
    class FakeHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal("Highlight", FakeHighlight);

    const ranges = collectTextRanges(mount("<p>a a a</p>"), "a");
    applyFindHighlights(ranges, 1);
    expect(registry.get(FIND_HIGHLIGHT)!.ranges).toHaveLength(2);
    expect(registry.get(FIND_HIGHLIGHT_CURRENT)!.ranges).toEqual([ranges[1]]);

    clearFindHighlights();
    expect(registry.size).toBe(0);
  });
});

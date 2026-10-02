// domFind — 읽기 모드 문서 내 찾기: 렌더된 DOM의 텍스트 노드에서 Range를 모아
// CSS Custom Highlight API로 칠한다. DOM을 바꾸지 않으므로 React 렌더와 충돌하지 않는다.
//
// 한계: 텍스트 노드 경계를 넘는 일치("foo **bar**"에서 "foo bar")는 찾지 않는다.
// Highlight API가 없는 환경(구버전 WebKit, jsdom)에서는 강조 없이 개수·스크롤만 동작한다.
import { findMatches } from "./findInText";

export const FIND_HIGHLIGHT = "raven-find";
export const FIND_HIGHLIGHT_CURRENT = "raven-find-current";

interface HighlightApi {
  registry: { set(name: string, h: unknown): unknown; delete(name: string): unknown };
  Highlight: new (...ranges: Range[]) => unknown;
}

function highlightApi(): HighlightApi | null {
  const g = globalThis as unknown as { CSS?: { highlights?: HighlightApi["registry"] }; Highlight?: HighlightApi["Highlight"] };
  if (!g.CSS?.highlights || typeof g.Highlight !== "function") return null;
  return { registry: g.CSS.highlights, Highlight: g.Highlight };
}

export function collectTextRanges(root: Node, query: string): Range[] {
  if (!query) return [];
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const ranges: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const [start, end] of findMatches(node.nodeValue ?? "", query)) {
      const range = doc.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      ranges.push(range);
    }
  }
  return ranges;
}

export function applyFindHighlights(ranges: Range[], current: number): void {
  const api = highlightApi();
  if (!api) return;
  api.registry.set(FIND_HIGHLIGHT, new api.Highlight(...ranges.filter((_, i) => i !== current)));
  if (current >= 0 && ranges[current]) {
    api.registry.set(FIND_HIGHLIGHT_CURRENT, new api.Highlight(ranges[current]));
  } else {
    api.registry.delete(FIND_HIGHLIGHT_CURRENT);
  }
}

export function clearFindHighlights(): void {
  const api = highlightApi();
  if (!api) return;
  api.registry.delete(FIND_HIGHLIGHT);
  api.registry.delete(FIND_HIGHLIGHT_CURRENT);
}

/** 현재 항목이 화면 가운데 오도록 스크롤. 페이지/패널 어느 스크롤 컨테이너든 동작한다. */
export function scrollRangeIntoView(range: Range): void {
  const el = range.startContainer.parentElement;
  if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
}

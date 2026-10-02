# 문서 내 찾기 (Cmd/Ctrl+F) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 문서 화면(읽기와 편집 모드)에서 Cmd/Ctrl+F를 누르면 찾기 막대가 열리고, 일치 항목을 강조해 순서대로 이동할 수 있게 한다.

**Architecture:** 보기/편집 모드는 `InlineMarkdownEditor`가 갖고 있으므로 찾기 상태와 단축키도 그 안에 둔다(PageView와 HomePage 양쪽이 이 컴포넌트를 쓴다). 읽기 모드는 렌더된 DOM의 텍스트 노드에서 Range를 모아 CSS Custom Highlight API로 칠한다. 편집 모드는 textarea 뒤에 같은 글꼴과 줄바꿈을 쓰는 backdrop을 깔고 `<mark>`로 칠한다. WebKit은 포커스가 없는 textarea의 선택 영역을 그리지 않기 때문에 spec의 `setSelectionRange` 방식에서 바꾼 것이다.

**Tech Stack:** React 18 + TypeScript, vitest + @testing-library/react (jsdom). 새 의존성은 없다.

**Spec:** `docs/superpowers/specs/2026-10-02-in-page-find-design.md`

**규약:** AGENTS.md §6에 따라 **commit은 사용자 승인 후**에만 한다. task마다 commit하지 않고, 마지막 task에서 승인을 받아 한 번에 commit한다.

---

## 파일 구조

| 파일 | 역할 |
|---|---|
| Create `dashboard/src/lib/findInText.ts` | 순수 함수: 문자열에서 일치 구간 찾기, 인덱스 순환 |
| Create `dashboard/src/lib/domFind.ts` | DOM 텍스트 노드에서 Range 수집, Highlight API 적용·해제, 스크롤 |
| Create `dashboard/src/components/FindBar.tsx` | 찾기 막대 UI (입력, n/m, 이전·다음·닫기) |
| Create `dashboard/src/components/FindBackdrop.tsx` | 편집 모드 textarea 뒤에 까는 강조 레이어 |
| Modify `dashboard/src/components/InlineMarkdownEditor.tsx` | 찾기 상태, Cmd+F, 두 모드 연결 |
| Modify `dashboard/src/styles/globals.css` | 토큰 2개(라이트와 다크 2곳) + 막대·하이라이트 스타일 |
| Test `dashboard/tests/findInText.test.ts`, `domFind.test.ts`, `FindBar.test.tsx`, `FindBackdrop.test.tsx`, `InlineMarkdownEditor.find.test.tsx` | |

모든 명령은 `dashboard/`에서 실행한다.

---

### Task 1: `findInText` 순수 함수

**Files:**
- Create: `dashboard/src/lib/findInText.ts`
- Test: `dashboard/tests/findInText.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { describe, expect, it } from "vitest";
import { findMatches, wrapIndex } from "../src/lib/findInText";

describe("findMatches", () => {
  it("빈 검색어는 일치 없음", () => {
    expect(findMatches("abc", "")).toEqual([]);
  });
  it("대소문자를 구분하지 않는다", () => {
    expect(findMatches("Foo foo FOO", "foo")).toEqual([[0, 3], [4, 7], [8, 11]]);
  });
  it("겹치는 일치는 세지 않는다 (브라우저 찾기와 동일)", () => {
    expect(findMatches("aaa", "aa")).toEqual([[0, 2]]);
  });
  it("한글과 줄바꿈", () => {
    expect(findMatches("백업\n백업 기능", "백업")).toEqual([[0, 2], [3, 5]]);
  });
  it("소문자화로 길이가 바뀌는 문자가 있으면 원문 그대로 비교한다", () => {
    // "İ".toLowerCase()는 2글자 → 인덱스가 밀리지 않아야 한다
    expect(findMatches("İx x", "x")).toEqual([[1, 2], [3, 4]]);
  });
});

describe("wrapIndex", () => {
  it("total 0이면 -1", () => expect(wrapIndex(3, 0)).toBe(-1));
  it("앞뒤로 순환한다", () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/findInText.test.ts`
Expected: FAIL (`Failed to resolve import "../src/lib/findInText"`)

- [ ] **Step 3: 구현**

```ts
// findInText — 문서 내 찾기의 순수 매칭 로직 (Cmd/Ctrl+F).
//
// 대소문자 무시, 겹치지 않는 부분 문자열 일치. 정규식·단어 단위 옵션은 없다.
// 읽기 모드(domFind)와 편집 모드(FindBackdrop)가 같은 함수를 쓴다.

/** [start, end) 구간 */
export type Match = [number, number];

export function findMatches(haystack: string, query: string): Match[] {
  if (!query) return [];
  let h = haystack.toLowerCase();
  let q = query.toLowerCase();
  // 소문자화로 길이가 바뀌는 문자(예: "İ")가 있으면 인덱스가 원문과 어긋난다 → 원문 그대로 비교.
  if (h.length !== haystack.length || q.length !== query.length) {
    h = haystack;
    q = query;
  }
  const out: Match[] = [];
  let i = h.indexOf(q);
  while (i !== -1) {
    out.push([i, i + q.length]);
    i = h.indexOf(q, i + q.length);
  }
  return out;
}

/** 이전/다음 이동으로 범위를 벗어난 인덱스를 0..total-1로 순환. total이 0이면 -1. */
export function wrapIndex(index: number, total: number): number {
  return total > 0 ? ((index % total) + total) % total : -1;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/findInText.test.ts`
Expected: PASS (7 tests)

---

### Task 2: `domFind` — 읽기 모드 Range 수집과 하이라이트

**Files:**
- Create: `dashboard/src/lib/domFind.ts`
- Test: `dashboard/tests/domFind.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
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
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/domFind.test.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

```ts
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
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/domFind.test.ts`
Expected: PASS (4 tests)

---

### Task 3: `FindBar` 컴포넌트

**Files:**
- Create: `dashboard/src/components/FindBar.tsx`
- Test: `dashboard/tests/FindBar.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FindBar, type FindBarProps } from "../src/components/FindBar";

function setup(over: Partial<FindBarProps> = {}) {
  const props: FindBarProps = {
    query: "foo",
    onQueryChange: vi.fn(),
    current: 0,
    total: 3,
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    focusSignal: 1,
    ...over,
  };
  render(<FindBar {...props} />);
  return { props, input: screen.getByLabelText("문서 내 찾기") as HTMLInputElement };
}

describe("FindBar", () => {
  it("n/m을 보여준다", () => {
    setup({ current: 1, total: 3 });
    expect(screen.getByText("2/3")).toBeTruthy();
  });
  it("일치가 없으면 0/0과 aria-invalid", () => {
    const { input } = setup({ current: -1, total: 0 });
    expect(screen.getByText("0/0")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
  it("Enter는 다음, Shift+Enter는 이전", () => {
    const { props, input } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(props.onNext).toHaveBeenCalledTimes(1);
    expect(props.onPrev).toHaveBeenCalledTimes(1);
  });
  it("Esc는 닫고 바깥으로 전파하지 않는다 (편집 취소 방지)", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    const { props, input } = setup();
    fireEvent.keyDown(input, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
  it("열리면 입력에 포커스", () => {
    const { input } = setup();
    expect(document.activeElement).toBe(input);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/FindBar.test.tsx`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

```tsx
// FindBar — 문서 내 찾기 막대 (Cmd/Ctrl+F).
//
// 상태는 부모(InlineMarkdownEditor)가 갖고, 이 컴포넌트는 표시와 키 입력만 담당한다.
// Enter = 다음, Shift+Enter = 이전, Esc = 닫기. Esc는 전파를 막는다 —
// 편집 모드의 document Esc 핸들러가 편집을 취소해버리지 않도록.
import { useEffect, useRef } from "react";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";

export interface FindBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  /** 0-based 현재 항목. 일치가 없으면 -1. */
  current: number;
  total: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** 값이 바뀔 때마다 입력에 포커스 + 전체 선택 (Cmd+F 재입력). */
  focusSignal: number;
}

export function FindBar({ query, onQueryChange, current, total, onNext, onPrev, onClose, focusSignal }: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  const noMatch = query !== "" && total === 0;

  return (
    <div className="find-bar" role="search">
      <TextField
        ref={inputRef as React.Ref<HTMLInputElement>}
        label="문서 내 찾기"
        hideLabel
        className="input-base find-bar-input"
        placeholder="문서에서 찾기"
        value={query}
        aria-invalid={noMatch}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="find-bar-count" aria-live="polite">
        {total > 0 ? `${current + 1}/${total}` : "0/0"}
      </span>
      <Button variant="ghost" size="sm" aria-label="이전 결과" disabled={total === 0} onClick={onPrev}>
        ↑
      </Button>
      <Button variant="ghost" size="sm" aria-label="다음 결과" disabled={total === 0} onClick={onNext}>
        ↓
      </Button>
      <Button variant="ghost" size="sm" aria-label="찾기 닫기" onClick={onClose}>
        ✕
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/FindBar.test.tsx`
Expected: PASS (5 tests)

---

### Task 4: `FindBackdrop` — 편집 모드 강조 레이어

**Files:**
- Create: `dashboard/src/components/FindBackdrop.tsx`
- Test: `dashboard/tests/FindBackdrop.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FindBackdrop } from "../src/components/FindBackdrop";

describe("FindBackdrop", () => {
  it("일치 구간을 mark로 감싸고 현재 항목에 표시한다", () => {
    const { container } = render(
      <FindBackdrop text="foo bar foo" matches={[[0, 3], [8, 11]]} current={1} />,
    );
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[1].className).toContain("find-mark-current");
    expect(marks[0].className).not.toContain("find-mark-current");
  });
  it("원문 텍스트를 그대로 보존한다 (끝 줄바꿈 하나 추가)", () => {
    const { container } = render(<FindBackdrop text={"a\nb"} matches={[[2, 3]]} current={0} />);
    expect(container.firstElementChild!.textContent).toBe("a\nb\n");
  });
  it("스크린리더에서 숨긴다", () => {
    const { container } = render(<FindBackdrop text="x" matches={[]} current={-1} />);
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/FindBackdrop.test.tsx`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

```tsx
// FindBackdrop — 편집 모드 문서 내 찾기 강조 레이어.
//
// textarea 안의 글자에는 배경을 칠할 수 없고, WebKit은 포커스가 없는 textarea의
// 선택 영역을 그리지 않는다 (찾기 막대가 포커스를 가진 상태). 그래서 textarea 뒤에
// 같은 글꼴·패딩·줄바꿈 규칙을 가진 div를 깔고, 글자는 투명하게, 일치 구간만
// <mark> 배경으로 보이게 한다. 스크롤 위치는 부모가 textarea와 맞춘다.
import { forwardRef } from "react";
import type { Match } from "../lib/findInText";

export interface FindBackdropProps {
  text: string;
  matches: Match[];
  /** 0-based 현재 항목, 없으면 -1 */
  current: number;
  style?: React.CSSProperties;
}

export const FindBackdrop = forwardRef<HTMLDivElement, FindBackdropProps>(function FindBackdrop(
  { text, matches, current, style },
  ref,
) {
  const parts: React.ReactNode[] = [];
  let pos = 0;
  matches.forEach(([start, end], i) => {
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(
      <mark key={i} className={i === current ? "find-mark find-mark-current" : "find-mark"}>
        {text.slice(start, end)}
      </mark>,
    );
    pos = end;
  });
  // 끝 줄바꿈: textarea는 마지막 빈 줄도 높이를 갖는다 — 스크롤 높이를 맞춘다.
  parts.push(text.slice(pos) + "\n");

  return (
    <div ref={ref} aria-hidden="true" className="find-backdrop" style={style}>
      {parts}
    </div>
  );
});
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/FindBackdrop.test.tsx`
Expected: PASS (3 tests)

---

### Task 5: CSS 토큰과 스타일

**Files:**
- Modify: `dashboard/src/styles/globals.css`

토큰은 `--color-warning-bg`가 정의된 세 블록에 나란히 넣는다. 라이트 `:root`(118행 부근), 다크 `[data-color-mode="dark"]`(532행 부근), `html.dark`(622행 부근)이다. 다크 블록이 두 개인 이유는 globals.css 577행 주석에 있다.

- [ ] **Step 1: 라이트 토큰 추가** — `:root`의 `--color-warning-text: #854d0e;` 다음 줄

```css
  --color-find-match: rgba(250, 204, 21, 0.4);    /* 문서 내 찾기 — 일치 항목 */
  --color-find-current: rgba(249, 115, 22, 0.55); /* 문서 내 찾기 — 현재 항목 */
```

- [ ] **Step 2: 다크 토큰 추가** — `--color-warning-bg: rgba(133, 77, 14, 0.34);` 두 곳(532·622행 부근) 각각 다음 줄

```css
  --color-find-match: rgba(250, 204, 21, 0.28);
  --color-find-current: rgba(249, 115, 22, 0.5);
```

- [ ] **Step 3: 스타일 추가** — 파일 끝에

```css
/* ── 문서 내 찾기 (Cmd/Ctrl+F) — FindBar / FindBackdrop / domFind ── */
.find-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  margin-bottom: 8px;
  background: var(--color-canvas);
  border: 1px solid var(--color-hairline);
  border-radius: 8px;
}
.find-bar > label {
  flex: 1 1 auto;
  min-width: 0;
}
.find-bar-input[aria-invalid="true"] {
  border-bottom-color: var(--color-danger);
}
.find-bar-count {
  min-width: 44px;
  text-align: right;
  font-size: 12px;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
}
::highlight(raven-find) {
  background-color: var(--color-find-match);
}
::highlight(raven-find-current) {
  background-color: var(--color-find-current);
}
.find-backdrop .find-mark {
  background: var(--color-find-match);
  color: transparent;
  border-radius: 2px;
}
.find-backdrop .find-mark-current {
  background: var(--color-find-current);
}
```

- [ ] **Step 4: 빌드 확인**

Run: `npx vite build --logLevel error`
Expected: 오류 없음. 브라우저가 `::highlight`를 모르면 그 규칙만 무시되고 빌드는 깨지지 않는다.

---

### Task 6: `InlineMarkdownEditor`에 연결

**Files:**
- Modify: `dashboard/src/components/InlineMarkdownEditor.tsx`
- Test: `dashboard/tests/InlineMarkdownEditor.find.test.tsx`

- [ ] **Step 1: 실패하는 통합 테스트 작성**

```tsx
/* 문서 내 찾기 (Cmd/Ctrl+F) — InlineMarkdownEditor 통합 회귀 가드.
 *  1. Cmd+F가 브라우저 기본 동작을 막고 찾기 막대를 연다
 *  2. 읽기 모드에서 렌더된 본문의 일치 개수를 센다
 *  3. 편집 모드에서 textarea 원문 기준으로 세고, Enter/Shift+Enter로 순환한다
 *  4. 찾기 막대의 Esc가 편집을 취소하지 않는다
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { InlineMarkdownEditor } from "../src/components/InlineMarkdownEditor";

function renderEditor(content = "foo bar foo") {
  return render(
    <MemoryRouter>
      <InlineMarkdownEditor vault="v1" slug="content/hello" title="Hello" content={content} />
    </MemoryRouter>,
  );
}

const openFind = () => fireEvent.keyDown(document, { key: "f", metaKey: true });
const findInput = () => screen.getByLabelText("문서 내 찾기") as HTMLInputElement;

describe("InlineMarkdownEditor 문서 내 찾기", () => {
  it("Cmd+F가 기본 동작을 막고 막대를 연다", () => {
    renderEditor();
    expect(screen.queryByLabelText("문서 내 찾기")).toBeNull();
    const notPrevented = openFind();
    expect(notPrevented).toBe(false);
    expect(findInput()).toBeTruthy();
  });

  it("Ctrl+F도 연다", () => {
    renderEditor();
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    expect(findInput()).toBeTruthy();
  });

  it("읽기 모드: 렌더된 본문에서 센다", () => {
    renderEditor();
    openFind();
    fireEvent.change(findInput(), { target: { value: "foo" } });
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("편집 모드: 원문 기준으로 세고 순환한다", () => {
    const { container } = renderEditor();
    fireEvent.keyDown(document, { key: "e", metaKey: true }); // 편집 모드
    openFind();
    fireEvent.change(findInput(), { target: { value: "foo" } });
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.keyDown(findInput(), { key: "Enter" });
    expect(screen.getByText("2/2")).toBeTruthy();
    fireEvent.keyDown(findInput(), { key: "Enter", shiftKey: true });
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(container.querySelectorAll(".find-backdrop mark")).toHaveLength(2);
  });

  it("찾기 막대 Esc는 편집을 취소하지 않는다", () => {
    const { container } = renderEditor();
    fireEvent.keyDown(document, { key: "e", metaKey: true });
    openFind();
    fireEvent.keyDown(findInput(), { key: "Escape" });
    expect(screen.queryByLabelText("문서 내 찾기")).toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/InlineMarkdownEditor.find.test.tsx`
Expected: FAIL (`Unable to find a label with the text of: 문서 내 찾기`)

- [ ] **Step 3: import와 상태 추가**

29행 import 줄을 다음으로 바꾼다.

```tsx
 import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
```

`import { ShareButton } from "./ShareButton";` 아래에 추가한다.

```tsx
import { FindBar } from "./FindBar";
import { FindBackdrop } from "./FindBackdrop";
import { findMatches, wrapIndex } from "../lib/findInText";
import { applyFindHighlights, clearFindHighlights, collectTextRanges, scrollRangeIntoView } from "../lib/domFind";
```

`const containerRef = useRef<HTMLDivElement>(null);`(153행 부근) 바로 아래에 추가한다.

```tsx
   // 문서 내 찾기 (Cmd/Ctrl+F) — 읽기 모드는 렌더된 DOM, 편집 모드는 textarea 원문 기준.
   const [findOpen, setFindOpen] = useState(false);
   const [findQuery, setFindQuery] = useState("");
   const [findIndex, setFindIndex] = useState(0);
   const [findFocusSignal, setFindFocusSignal] = useState(0);
   const [viewMatchCount, setViewMatchCount] = useState(0);
   const viewBodyRef = useRef<HTMLDivElement>(null);
   const backdropRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 4: 단축키 추가** — 기존 `// Cmd+E / Ctrl+E → mode toggle` effect의 `onKey` 맨 앞에 넣는다(`if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e")` 앞).

```tsx
       if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
         // WKWebView에는 찾기 막대가 없다 — 웹뷰 기본 동작을 막고 자체 막대를 연다.
         e.preventDefault();
         setFindOpen(true);
         setFindFocusSignal((n) => n + 1);
         return;
       }
```

같은 effect 위 주석 블록(파일 상단 UX 목록)의 `Cmd+S (edit mode) → 저장` 줄 아래에 `  *   - Cmd+F / Ctrl+F → 문서 내 찾기 (FindBar)`를 추가한다.

- [ ] **Step 5: 계산값과 effect 추가** — `const previewSource = preprocessWikilinks(draft, vault);` 바로 아래(return 앞)

```tsx
   const editMatches = useMemo(
     () => (findOpen && mode === "edit" ? findMatches(draft, findQuery) : []),
     [findOpen, mode, draft, findQuery],
   );
   const findTotal = mode === "edit" ? editMatches.length : viewMatchCount;
   const findCurrent = wrapIndex(findIndex, findTotal);

   // 읽기 모드: 렌더된 본문에서 Range 수집 → Highlight API로 강조 + 현재 항목 스크롤.
   useEffect(() => {
     const root = viewBodyRef.current;
     if (!findOpen || mode !== "view" || !root) {
       clearFindHighlights();
       return;
     }
     const ranges = collectTextRanges(root, findQuery);
     setViewMatchCount(ranges.length);
     const cur = wrapIndex(findIndex, ranges.length);
     applyFindHighlights(ranges, cur);
     if (cur >= 0) scrollRangeIntoView(ranges[cur]);
     return () => clearFindHighlights();
   }, [findOpen, mode, findQuery, findIndex, displayContent]);

   // 편집 모드: 현재 mark가 textarea 가운데 오도록 스크롤하고 backdrop을 맞춘다.
   // draft는 deps에서 뺀다 — 타이핑할 때마다 스크롤이 튀면 안 된다.
   useLayoutEffect(() => {
     if (!findOpen || mode !== "edit") return;
     const ta = textareaRef.current;
     const bd = backdropRef.current;
     const mark = bd?.querySelector<HTMLElement>(".find-mark-current");
     if (ta && mark) ta.scrollTop = Math.max(0, mark.offsetTop - ta.clientHeight / 2);
     if (ta && bd) bd.scrollTop = ta.scrollTop;
     // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [findOpen, mode, findQuery, findIndex]);
```

- [ ] **Step 6: 찾기 막대 렌더** — `{/* Body: view vs edit */}` 아래 `<div className="inline-md-body">` 바로 안쪽 첫 자식으로

```tsx
         {findOpen && (
           <FindBar
             query={findQuery}
             onQueryChange={(q) => {
               setFindQuery(q);
               setFindIndex(0);
             }}
             current={findCurrent}
             total={findTotal}
             onNext={() => setFindIndex((i) => i + 1)}
             onPrev={() => setFindIndex((i) => i - 1)}
             onClose={() => setFindOpen(false)}
             focusSignal={findFocusSignal}
           />
         )}
```

- [ ] **Step 7: 읽기 모드 본문을 ref로 감싼다** — view 분기의 `<MDEditor.Markdown source={displayContent ?? ""} … />`를 다음으로 바꾼다.

```tsx
           <div ref={viewBodyRef}>
             <MDEditor.Markdown
               source={displayContent ?? ""}
               style={{
                 backgroundColor: "transparent",
                 color: "var(--color-body)",
               }}
             />
           </div>
```

- [ ] **Step 8: 편집 모드 textarea에 backdrop 연결**

`export function InlineMarkdownEditor(` 위(모듈 레벨)에 textarea와 backdrop이 함께 쓰는 글자 배치 스타일을 추가한다.

```tsx
 // textarea와 FindBackdrop이 글자 위치를 1:1로 맞추기 위해 공유하는 배치 스타일.
 const SOURCE_TEXT_STYLE: React.CSSProperties = {
   padding: "16px 20px",
   fontSize: 14,
   lineHeight: 1.65,
   fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
   whiteSpace: "pre-wrap",
   wordBreak: "break-word",
   tabSize: 2,
 };
```

`{/* Source textarea */}`부터 textarea의 닫는 `/>`까지를 다음으로 바꾼다. textarea가 grid 칸에서 wrapper div 안으로 들어가므로 `display: "block"`을 준다.

```tsx
               {/* Source textarea (+ 문서 내 찾기 backdrop) */}
               <div style={{ position: "relative", minWidth: 0 }}>
                 {findOpen && (
                   <FindBackdrop
                     ref={backdropRef}
                     text={draft}
                     matches={editMatches}
                     current={findCurrent}
                     style={{
                       ...SOURCE_TEXT_STYLE,
                       position: "absolute",
                       inset: 0,
                       overflow: "hidden",
                       color: "transparent",
                       background: "var(--color-canvas)",
                       borderRight: showPreview ? "1px solid transparent" : "none",
                       pointerEvents: "none",
                     }}
                   />
                 )}
                 <textarea
                   ref={textareaRef}
                   value={draft}
                   onChange={(e) => setDraft(e.target.value)}
                   onScroll={(e) => {
                     if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop;
                   }}
                   disabled={busy}
                   spellCheck={false}
                   style={{
                     ...SOURCE_TEXT_STYLE,
                     position: "relative",
                     display: "block",
                     width: "100%",
                     minHeight: 400,
                     maxHeight: "70vh",
                     color: "var(--color-ink)",
                     background: findOpen ? "transparent" : "var(--color-canvas)",
                     border: 0,
                     borderRight: showPreview ? "1px solid var(--color-hairline)" : "none",
                     outline: "none",
                     resize: "vertical",
                   }}
                 />
               </div>
```

- [ ] **Step 9: 통과 확인**

Run: `npx vitest run tests/InlineMarkdownEditor.find.test.tsx tests/PageEdit.draft-recovery.test.tsx tests/PageEdit.precondition.test.tsx`
Expected: PASS. 기존 편집기 테스트 두 파일도 깨지지 않아야 한다.

---

### Task 7: 전체 검증, 문서, commit 승인

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-in-page-find-design.md` (편집 모드 방식을 backdrop으로 바꾼 것과 상태 위치 반영)
- Modify: `_meta/changelog-v0.7.182.md` (섹션 추가, `_meta/` 쓰기는 사용자 승인 대상)

- [ ] **Step 1: 전체 테스트와 타입 검사**

Run: `npx vitest run && npx tsc -b`
Expected: 모든 테스트 PASS, 타입 오류 0

- [ ] **Step 2: spec 정정** — "결정 사항" 2번을 다음으로 바꾸고, "구성 요소"의 `useDomFind.ts`/`useTextareaFind.ts`/`PageView.tsx` 항목을 실제 파일(`domFind.ts`, `FindBackdrop.tsx`, `InlineMarkdownEditor.tsx`)로 고친다.

```markdown
2. **편집 모드**는 textarea 뒤에 같은 글꼴·패딩·줄바꿈의 backdrop(`FindBackdrop`)을 깔고 일치 구간을 `<mark>`로 칠한다. WebKit은 포커스가 없는 textarea의 선택 영역을 그리지 않아서, 찾기 막대가 포커스를 가진 동안 `setSelectionRange`가 보이지 않기 때문이다. 현재 항목은 mark의 `offsetTop`으로 textarea를 스크롤한다.
```

4번은 이렇게 고친다. "보기/편집 모드를 가진 `InlineMarkdownEditor`가 단축키를 가로챈다. 이 컴포넌트를 쓰는 화면(PageView, HomePage)에서만 동작하고, 다른 화면은 기본 동작을 그대로 둔다."

- [ ] **Step 3: changelog** — `_meta/changelog-v0.7.182.md` 끝에 append

```markdown
## 문서 내 찾기 (Cmd/Ctrl+F)

데스크톱 앱 웹뷰(WKWebView)에는 찾기 막대가 없어 Cmd+F가 아무 반응도 없었다. 문서 화면에 자체 찾기 막대를 붙였다.

- 읽기 모드: CSS Custom Highlight API로 렌더된 본문을 칠한다 (`dashboard/src/lib/domFind.ts`). DOM을 바꾸지 않는다.
- 편집 모드: textarea 뒤 backdrop에 `<mark>`로 칠한다 (`FindBackdrop.tsx`). WebKit이 포커스 없는 textarea 선택을 그리지 않아서다.
- Enter/Shift+Enter 이동, Esc 닫기 — Esc는 전파를 막아 편집 취소와 겹치지 않는다.
- 한계: 텍스트 노드 경계를 넘는 일치(굵게 표시를 사이에 둔 구절)는 읽기 모드에서 찾지 않는다.
- 테스트: `findInText` / `domFind` / `FindBar` / `FindBackdrop` / `InlineMarkdownEditor.find`.
```

- [ ] **Step 4: 데스크톱 앱 수동 확인** — `npm run desktop:dev`로 다음을 확인한다.
  - 읽기 모드: 강조가 보이고, 현재 항목은 다른 색이며, 화면 밖 항목으로 스크롤된다.
  - 편집 모드: mark가 글자와 정확히 겹친다(긴 줄 줄바꿈, 한글 포함). textarea를 스크롤해도 mark가 따라온다.
  - 다크 모드 색.
  - Cmd+E와 Cmd+S 단축키가 그대로 동작한다.

- [ ] **Step 5: 사용자에게 commit 승인 요청** — 승인이 나면 다음을 실행한다.

```bash
git add dashboard/src/lib/findInText.ts dashboard/src/lib/domFind.ts \
  dashboard/src/components/FindBar.tsx dashboard/src/components/FindBackdrop.tsx \
  dashboard/src/components/InlineMarkdownEditor.tsx dashboard/src/styles/globals.css \
  dashboard/tests/findInText.test.ts dashboard/tests/domFind.test.ts \
  dashboard/tests/FindBar.test.tsx dashboard/tests/FindBackdrop.test.tsx \
  dashboard/tests/InlineMarkdownEditor.find.test.tsx \
  docs/superpowers/specs/2026-10-02-in-page-find-design.md _meta/changelog-v0.7.182.md
git commit -m "feat(dashboard): 문서 내 찾기 (Cmd/Ctrl+F) — 읽기·편집 모드"
```

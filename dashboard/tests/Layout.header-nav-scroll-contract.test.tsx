/* Issue #9 — header/nav의 무효 sticky 제거 계약 + dropdown stacking 회귀 가드.
 *
 * 왜 이 파일이 있는가
 * ───────────────────
 * Layout.tsx의 header/nav는 `position: sticky; top: …`를 달고 있었지만,
 * 실제 vertical scrollport는 header/nav의 *sibling*인 `.page-content`
 * (overflow-y-auto)다. header/nav의 조상은 main(overflow-hidden, 스크롤 없음)
 * 뿐이므로 header/nav는 어떤 scroll container의 descendant도 아니다.
 * → sticky가 offset될 대상 자체가 없다 = 무효(inert).
 *
 * 이 파일은 *실제 <Layout/>를 마운트한 실제 DOM*에서 두 축을 검증한다.
 * CSS 문자열을 복사해 자기 자신을 검증하지 않는다:
 *   1. topology — header/nav가 실제 scrollport(.page-content) 밖에 있다.
 *      이 사실이 "sticky가 무효"라는 판단의 근거이며, 제거가 안전한 이유다.
 *   2. inline style — 실제 element.style에서 sticky/top이 사라졌다.
 *      (jsdom은 inline style 선언을 그대로 반영하므로 element.style로 읽는다.)
 *   3. z-index — "더보기" dropdown이 page content 위로 뜨는 근거는 남는다.
 *
 * 대조군: `.find-bar`(globals.css)의 sticky는 *실제 scrollport 안*에 있으므로
 * 유효하다 — Issue #9는 그 선언을 건드리지 않는다. 이 파일이 그 경계를 고정한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import css from "../src/styles/globals.css?raw";

vi.mock("../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...actual,
    fetchVaults: vi.fn(async () => [
      { name: "test", path: "/tmp/test", mode: "personal", owner: "user", default: true },
    ]),
    fetchTree: vi.fn(async () => ({ type: "dir", path: "", children: [] })),
    fetchRawList: vi.fn(async () => ({ items: [] })),
    fetchDraftsList: vi.fn(async () => ({ items: [] })),
  };
});

import { Layout } from "../src/components/Layout";

async function renderLayout() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Layout />
    </MemoryRouter>
  );
  await screen.findByRole("complementary", {}, { timeout: 2000 });
}

const header = () => document.querySelector(".app-header") as HTMLElement;
const nav = () => document.querySelector(".global-section-nav") as HTMLElement;
const pageContent = () => document.querySelector(".page-content") as HTMLElement;

function isAncestorOf(ancestor: Element | null, node: Element | null): boolean {
  for (let n = node?.parentElement ?? null; n; n = n.parentElement) {
    if (n === ancestor) return true;
  }
  return false;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("scroll topology — header/nav는 실제 scrollport의 descendant가 아니다", () => {
  it("실제 scroll container는 .page-content 하나이고 header/nav를 포함하지 않는다", async () => {
    await renderLayout();

    const pc = pageContent();
    expect(pc, ".page-content(scrollport)가 없다").not.toBeNull();
    expect(pc.className).toContain("overflow-y-auto");

    // header/nav는 scrollport의 *sibling*이다 — 즉 그 안에서 스크롤되지 않는다.
    expect(isAncestorOf(pc, header()), "header가 scrollport 안에 있다").toBe(false);
    expect(isAncestorOf(pc, nav()), "nav가 scrollport 안에 있다").toBe(false);

    // 셋 다 같은 flex column(main)의 자식이다.
    const main = document.querySelector("main");
    expect(main).not.toBeNull();
    expect(header().parentElement).toBe(main);
    expect(nav().parentElement).toBe(main);
    expect(pc.parentElement).toBe(main);

    // main은 overflow-hidden — 자체 스크롤이 없으므로 sticky의 offset 대상이 못 된다.
    expect(main!.className).toContain("overflow-hidden");
  });
});

describe("무효 sticky 제거 — header/nav는 sticky/top을 선언하지 않는다", () => {
  it("header는 sticky도 top도 없다 (z-index는 유지)", async () => {
    await renderLayout();
    const h = header();
    expect(h.style.position, "header가 여전히 sticky").not.toBe("sticky");
    expect(h.style.top, "header가 여전히 top offset을 선언").toBe("");
    // dropdown/layering 의도는 남는다 — z-index는 명시적으로 유지.
    expect(h.style.zIndex).toBe("50");
  });

  it("nav는 sticky도 top도 없다 (z-index는 유지)", async () => {
    await renderLayout();
    const n = nav();
    expect(n.style.position, "nav가 여전히 sticky").not.toBe("sticky");
    expect(n.style.top, "nav가 여전히 top offset을 선언").toBe("");
    expect(n.style.zIndex).toBe("49");
  });

  it("sticky 대신 relative로 z-index의 의도를 표현한다 (positioned = z-index 유효)", async () => {
    await renderLayout();
    // z-index는 positioned element(또는 flex item)에서만 의미가 있다.
    // sticky를 지우면서 z-index만 남기면 의도가 흐려진다 → relative로 고정한다.
    expect(header().style.position).toBe("relative");
    expect(nav().style.position).toBe("relative");
  });
});

describe("dropdown stacking — '더보기' panel이 page content 위로 뜬다", () => {
  it("panel은 nav 안에 있고 nav는 non-auto z-index를 갖는다", async () => {
    await renderLayout();

    const trigger = screen.getByRole("button", { name: /더보기/ });
    await act(async () => {
      fireEvent.click(trigger);
    });

    const panel = document.querySelector(".section-nav-more-panel") as HTMLElement | null;
    expect(panel, "더보기 panel이 열리지 않았다").not.toBeNull();

    // panel은 nav의 stacking context 안에 산다.
    expect(isAncestorOf(nav(), panel!)).toBe(true);

    // nav가 양수 z-index를 가지므로, DOM 순서상 뒤에 오는 .page-content보다 위에 그려진다.
    const navZ = Number(nav().style.zIndex);
    expect(Number.isFinite(navZ)).toBe(true);
    expect(navZ).toBeGreaterThan(0);

    // page-content는 z-index를 선언하지 않는다 → nav가 위.
    expect(pageContent().style.zIndex).toBe("");
  });

  it("panel을 열고 닫아도 nav의 stacking 선언이 변하지 않는다", async () => {
    await renderLayout();
    const before = nav().getAttribute("style");

    const trigger = screen.getByRole("button", { name: /더보기/ });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await act(async () => {
      fireEvent.click(trigger);
    });

    expect(document.querySelector(".section-nav-more-panel")).toBeNull();
    expect(nav().getAttribute("style")).toBe(before);
  });
});

describe("대조군 — 유효한 sticky는 보존된다", () => {
  it(".find-bar sticky는 그대로 남아 있다 (실제 scrollport 안의 정당한 sticky)", () => {
    // 이 테스트가 깨지면 Issue #9가 무관한 sticky까지 지운 것이다.
    expect(css).toMatch(/\.find-bar\s*\{[^}]*position:\s*sticky/);
  });
});

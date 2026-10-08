/* Issue #6 — 사이드바 drawer DOM behavior 회귀 가드.
 *
 * 이 파일은 *실제* <Layout/>을 마운트하고 *실제* jsdom DOM을 검사한다.
 * (이전 `Layout.desktop-drawer.test.ts`는 테스트 파일 안에 CSS 문자열을 복사해
 *  두고 자기 복사본을 검사하는 tautology였다 — production이 어떻게 변해도 초록.
 *  그 파일은 삭제했다.)
 *
 * CSS 표시 여부(hamburger가 desktop에서 display:none인가)는 jsdom이 미디어 쿼리를
 * 평가하지 못하므로 여기서 검증하지 않는다. 그 축은 실제 shipped stylesheet를
 * 파싱하는 `Layout.responsive-contract.test.ts`가 소유한다. 이 파일은 JS/JSX가
 * 주장하는 계약을 검증한다:
 *
 *   desktop (>744px) : drawer state가 sidebar/backdrop/aria-expanded를 바꾸지 않는다.
 *   mobile  (≤744px) : hamburger open → backdrop/×/Escape close, aria-expanded 동기화.
 *   compact nav      : 390 이하에서만 compact, 같은 구간 내 resize는 state를 안 바꾼다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// 실제 Layout이 마운트하는 fetch를 결정적으로 만든다 (네트워크/타이밍 비의존).
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
import { DRAWER_MQ, COMPACT_NAV_MQ } from "../src/lib/useMediaQuery";

// ── 제어 가능한 matchMedia (breakpoint crossing 시뮬레이션) ──────────────
type Listener = (event: MediaQueryListEvent) => void;

interface FakeMql {
  matches: boolean;
  listeners: Set<Listener>;
}

const mqls = new Map<string, FakeMql>();

function fakeMql(query: string): FakeMql {
  let entry = mqls.get(query);
  if (!entry) {
    entry = { matches: false, listeners: new Set() };
    mqls.set(query, entry);
  }
  return entry;
}

function installMatchMedia(): void {
  window.matchMedia = ((query: string) => {
    const entry = fakeMql(query);
    return {
      get matches() {
        return entry.matches;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: Listener) => entry.listeners.add(cb),
      removeEventListener: (_type: string, cb: Listener) => entry.listeners.delete(cb),
      addListener: (cb: Listener) => entry.listeners.add(cb),
      removeListener: (cb: Listener) => entry.listeners.delete(cb),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

/**
 * breakpoint crossing — 구독 중인 훅에 change 이벤트를 전달한다.
 * async act로 감싸 store 통지로 인한 re-render와 그에 딸린 마이크로태스크를
 * 모두 flush한다 (act 경고 없이 실제 DOM 상태를 관찰하기 위함).
 */
async function crossBreakpoint(query: string, matches: boolean): Promise<void> {
  const entry = fakeMql(query);
  entry.matches = matches;
  await act(async () => {
    entry.listeners.forEach((cb) => cb({ matches, media: query } as MediaQueryListEvent));
  });
}

/** 인터랙션 후 파생 state update까지 flush (act 경고 방지). */
async function interact(run: () => void): Promise<void> {
  await act(async () => {
    run();
  });
}

function setDesktop(): void {
  fakeMql(DRAWER_MQ).matches = false;
  fakeMql(COMPACT_NAV_MQ).matches = false;
}

function setMobile(): void {
  fakeMql(DRAWER_MQ).matches = true;
  fakeMql(COMPACT_NAV_MQ).matches = false;
}

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Layout />
    </MemoryRouter>
  );
}

const aside = () => document.querySelector("#primary-sidebar") as HTMLElement;
const backdrop = () => document.querySelector(".sidebar-backdrop");
const hamburger = () => screen.getByRole("button", { name: "메뉴 열기" });

beforeEach(() => {
  mqls.clear();
  installMatchMedia();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("desktop (>744px) — sidebar in-flow, drawer state 무해", () => {
  it("초기 상태: sidebar가 DOM에 상시 존재하고 open 클래스가 없다", async () => {
    setDesktop();
    renderLayout();

    const el = await screen.findByRole("complementary", {}, { timeout: 2000 });
    expect(el.id).toBe("primary-sidebar");
    expect(el.classList.contains("sidebar-offcanvas")).toBe(true);
    expect(el.classList.contains("sidebar-offcanvas-open")).toBe(false);
    expect(backdrop()).toBeNull();
  });

  it("desktop에서는 resize handle이 렌더된다 (in-flow sidebar의 표식)", async () => {
    setDesktop();
    renderLayout();
    await screen.findByRole("complementary", {}, { timeout: 2000 });
    expect(document.querySelector(".sidebar-resize-handle")).not.toBeNull();
  });

  it("hamburger 클릭해도 desktop sidebar/backdrop/aria-expanded가 변하지 않는다 (no-op 제거)", async () => {
    setDesktop();
    renderLayout();
    await screen.findByRole("complementary", {}, { timeout: 2000 });

    const btn = hamburger();
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    await interact(() => fireEvent.click(btn));

    // open state는 mobile drawer에만 의미가 있다 → desktop에서는 무해해야 한다.
    expect(aside().classList.contains("sidebar-offcanvas-open")).toBe(false);
    expect(backdrop()).toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("mobile (≤744px) — off-canvas drawer semantics", () => {
  it("초기 상태: closed (open 클래스 없음, aria-expanded=false, backdrop 없음)", async () => {
    setMobile();
    renderLayout();
    await screen.findByRole("complementary", {}, { timeout: 2000 });

    expect(aside().classList.contains("sidebar-offcanvas-open")).toBe(false);
    expect(hamburger().getAttribute("aria-expanded")).toBe("false");
    expect(backdrop()).toBeNull();
    // mobile에서는 resize handle이 없다 (drawer는 고정 폭).
    expect(document.querySelector(".sidebar-resize-handle")).toBeNull();
  });

  it("hamburger로 open → aria-expanded=true, backdrop 표시", async () => {
    setMobile();
    renderLayout();
    await screen.findByRole("complementary", {}, { timeout: 2000 });

    await interact(() => fireEvent.click(hamburger()));

    expect(aside().classList.contains("sidebar-offcanvas-open")).toBe(true);
    expect(hamburger().getAttribute("aria-expanded")).toBe("true");
    expect(backdrop()).not.toBeNull();
  });

  it("backdrop 클릭으로 닫힌다", async () => {
    setMobile();
    renderLayout();
    await screen.findByRole("complementary", {}, { timeout: 2000 });

    await interact(() => fireEvent.click(hamburger()));
    expect(backdrop()).not.toBeNull();

    await interact(() => fireEvent.click(backdrop() as Element));

    expect(aside().classList.contains("sidebar-offcanvas-open")).toBe(false);
    expect(hamburger().getAttribute("aria-expanded")).toBe("false");
    expect(backdrop()).toBeNull();
  });

  it("Escape로 닫힌다", async () => {
    setMobile();
    renderLayout();
    await screen.findByRole("complementary", {}, { timeout: 2000 });

    await interact(() => fireEvent.click(hamburger()));
    expect(aside().classList.contains("sidebar-offcanvas-open")).toBe(true);

    await interact(() => fireEvent.keyDown(document, { key: "Escape" }));

    expect(aside().classList.contains("sidebar-offcanvas-open")).toBe(false);
    expect(hamburger().getAttribute("aria-expanded")).toBe("false");
  });

  it("× (사이드바 닫기)로 닫힌다", async () => {
    setMobile();
    renderLayout();
    await screen.findByRole("complementary", {}, { timeout: 2000 });

    await interact(() => fireEvent.click(hamburger()));
    await interact(() => fireEvent.click(screen.getByRole("button", { name: "사이드바 닫기" })));

    expect(aside().classList.contains("sidebar-offcanvas-open")).toBe(false);
    expect(hamburger().getAttribute("aria-expanded")).toBe("false");
    expect(backdrop()).toBeNull();
  });

  it("drawer를 연 채 desktop으로 넓히면 sidebar/backdrop이 화면을 덮지 않는다", async () => {
    setMobile();
    renderLayout();
    await screen.findByRole("complementary", {}, { timeout: 2000 });

    await interact(() => fireEvent.click(hamburger()));
    expect(backdrop()).not.toBeNull();

    // 창을 넓혀 744px 경계를 넘긴다 (resize 이벤트가 아니라 breakpoint crossing).
    await crossBreakpoint(DRAWER_MQ, false);

    expect(aside().classList.contains("sidebar-offcanvas-open")).toBe(false);
    expect(backdrop()).toBeNull();
  });
});

describe("compact nav — 390 경계와 resize 무관성", () => {
  // compact 여부는 *화면에 보이는 라벨 텍스트*로 판정한다. 접힌 탭도 aria-label이
  // 남아 접근성 이름은 같으므로 role-name 질의로는 두 모드를 구분할 수 없다.
  const navLabel = (name: string): string => {
    const link = document.querySelector(`.global-section-nav a[href="/${name}"]`);
    if (!link) throw new Error(`nav link for ${name} not found`);
    return (link.textContent ?? "").trim();
  };

  it("390 초과: 섹션 라벨이 텍스트로 보인다", async () => {
    setMobile();
    fakeMql(COMPACT_NAV_MQ).matches = false;
    renderLayout();
    await screen.findByRole("complementary", {}, { timeout: 2000 });

    expect(navLabel("search")).toContain("검색");
    expect(navLabel("graph")).toContain("그래프");
  });

  it("390 이하: 비활성 탭 라벨이 접히고 활성 탭만 남는다", async () => {
    setMobile();
    fakeMql(COMPACT_NAV_MQ).matches = true;
    renderLayout();
    await screen.findByRole("complementary", {}, { timeout: 2000 });

    // 활성 탭(홈)은 라벨 유지, 비활성 탭은 라벨이 사라진다.
    expect(navLabel("")).toContain("홈");
    expect(navLabel("search")).not.toContain("검색");
    // 접혀도 접근성 이름은 aria-label로 남는다.
    expect(document.querySelector('.global-section-nav a[href="/search"]')?.getAttribute("aria-label")).toBe("검색");
  });

  it("390 경계를 넘으면 compact가 켜지고 되돌리면 꺼진다", async () => {
    setMobile();
    renderLayout();
    await screen.findByRole("complementary", {}, { timeout: 2000 });

    expect(navLabel("search")).toContain("검색");

    await crossBreakpoint(COMPACT_NAV_MQ, true);
    expect(navLabel("search")).not.toContain("검색");

    await crossBreakpoint(COMPACT_NAV_MQ, false);
    expect(navLabel("search")).toContain("검색");
  });

  it("Layout은 raw resize listener를 등록하지 않는다 (구간 내 resize는 rerender 없음)", async () => {
    setMobile();
    const addSpy = vi.spyOn(window, "addEventListener");
    renderLayout();
    await screen.findByRole("complementary", {}, { timeout: 2000 });

    const resizeRegistrations = addSpy.mock.calls.filter(([type]) => type === "resize");
    expect(resizeRegistrations).toHaveLength(0);

    // resize 이벤트를 쏴도 DOM이 변하지 않는다 (state update 경로가 없다).
    const before = aside().className;
    await interact(() => fireEvent(window, new Event("resize")));
    expect(aside().className).toBe(before);
  });
});

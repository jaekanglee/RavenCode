/* Issue #8 — Sidebar resize separator를 keyboard-operable splitter로.
 *
 * 실제 <Sidebar/>를 마운트해 *실제 separator DOM과 상호작용*을 검사한다
 * (소스 문자열 grep ❌, 가짜 fixture 자기검증 ❌).
 *
 * 고정한 계약 (SOT: Sidebar.tsx 상단 상수):
 *   - separator는 keyboard focus 가능 (tabIndex=0).
 *   - aria-valuemin/max/now가 실제 width state와 동기화된다.
 *   - ArrowLeft/Right = 1 step 이동, Home/End = MIN/MAX.
 *   - pointer drag와 keyboard가 *같은* clamp 범위를 쓴다 (MIN- step / MAX+step 불가).
 *   - keyboard resize도 pointer와 같은 localStorage key에 저장되고 재마운트 시 복원된다.
 *   - drag 중에는 React state를 commit하지 않는다 (aside DOM 직접 반영) → aria-valuenow 불변.
 *   - mobile(≤744px) drawer에는 separator가 없다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "../src/components/Sidebar";
import { DRAWER_MQ } from "../src/lib/useMediaQuery";
import type { VaultMeta } from "../src/types";
import css from "../src/styles/globals.css?raw";

// ── shipped contract (Sidebar.tsx 상단 SOT와 같은 값) ───────────────────
const WIDTH_KEY = "raven.sidebar.width";
const MIN = 200;
const MAX = 480;
const DEFAULT = 288;
const STEP = 16;

const VAULTS: VaultMeta[] = [
  { name: "test", path: "/tmp/test", mode: "personal", owner: "user", default: true },
];

// ── 제어 가능한 matchMedia (desktop/mobile 전환) ───────────────────────
const mqlMatches = new Map<string, boolean>();
const mqlListeners = new Map<string, Set<() => void>>();

function installMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    get matches() {
      return mqlMatches.get(query) ?? false;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => {
      if (!mqlListeners.has(query)) mqlListeners.set(query, new Set());
      mqlListeners.get(query)!.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      mqlListeners.get(query)?.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** breakpoint crossing — 구독 중인 훅에 change 이벤트를 전달한다. */
async function crossBreakpoint(query: string, matches: boolean): Promise<void> {
  mqlMatches.set(query, matches);
  await act(async () => {
    for (const listener of mqlListeners.get(query) ?? []) listener();
  });
}

function setDesktop(): void {
  mqlMatches.set(DRAWER_MQ, false);
}
function setMobile(): void {
  mqlMatches.set(DRAWER_MQ, true);
}

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar
        vaults={VAULTS}
        trees={{}}
        rawItems={{}}
        activeVault="test"
        activeSlug={null}
        onSelectVault={() => {}}
        onRefresh={() => {}}
        open={true}
        onClose={() => {}}
      />
    </MemoryRouter>
  );
}

/** 실제 separator DOM. */
const handle = (): HTMLElement => {
  const found = document.querySelector(".sidebar-resize-handle");
  if (!found) throw new Error("resize separator not found");
  return found as HTMLElement;
};

const valuenow = (): number => Number(handle().getAttribute("aria-valuenow"));
const asideWidthStyle = (): string =>
  (document.querySelector("#primary-sidebar") as HTMLElement).style.width;
const storedWidth = (): string | null => localStorage.getItem(WIDTH_KEY);

/** async act로 감싼 키 입력 (파생 re-render flush). */
async function press(key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(handle(), { key });
  });
}

beforeEach(() => {
  mqlMatches.clear();
  mqlListeners.clear();
  installMatchMedia();
  localStorage.clear();
  setDesktop();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("semantics — separator가 keyboard focus 가능하고 ARIA 값을 노출한다", () => {
  it("role=separator · vertical · tabIndex=0 · aria-valuemin/max/now", () => {
    renderSidebar();
    const el = handle();

    expect(el.getAttribute("role")).toBe("separator");
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
    expect(el.tabIndex).toBe(0);
    expect(Number(el.getAttribute("aria-valuemin"))).toBe(MIN);
    expect(Number(el.getAttribute("aria-valuemax"))).toBe(MAX);
    expect(valuenow()).toBe(DEFAULT);
    expect(el.getAttribute("aria-label")).toBeTruthy();
  });

  it("aria-valuenow는 저장된 width를 복원한 값과 같다", () => {
    localStorage.setItem(WIDTH_KEY, "320");
    renderSidebar();
    expect(valuenow()).toBe(320);
  });
});

describe("Arrow — keyboard resize와 동기화", () => {
  it("ArrowRight: width + step, aria-valuenow·DOM·localStorage 동기화", async () => {
    renderSidebar();
    await press("ArrowRight");

    expect(valuenow()).toBe(DEFAULT + STEP);
    expect(asideWidthStyle()).toBe(`${DEFAULT + STEP}px`);
    expect(storedWidth()).toBe(String(DEFAULT + STEP));
  });

  it("ArrowLeft: width - step", async () => {
    renderSidebar();
    await press("ArrowLeft");

    expect(valuenow()).toBe(DEFAULT - STEP);
    expect(asideWidthStyle()).toBe(`${DEFAULT - STEP}px`);
    expect(storedWidth()).toBe(String(DEFAULT - STEP));
  });

  it("연속 키 입력이 누적된다 (ArrowRight ×2 → +2 step)", async () => {
    renderSidebar();
    await press("ArrowRight");
    await press("ArrowRight");

    expect(valuenow()).toBe(DEFAULT + 2 * STEP);
    expect(storedWidth()).toBe(String(DEFAULT + 2 * STEP));
  });
});

describe("Boundary — MIN/MAX를 넘지 않는다 (pointer와 같은 clamp)", () => {
  it("MIN에서 ArrowLeft를 눌러도 MIN 유지 (MIN - step 불가)", async () => {
    localStorage.setItem(WIDTH_KEY, String(MIN));
    renderSidebar();
    expect(valuenow()).toBe(MIN);

    await press("ArrowLeft");

    expect(valuenow()).toBe(MIN);
    expect(storedWidth()).toBe(String(MIN));
  });

  it("MAX에서 ArrowRight를 눌러도 MAX 유지 (MAX + step 불가)", async () => {
    localStorage.setItem(WIDTH_KEY, String(MAX));
    renderSidebar();
    expect(valuenow()).toBe(MAX);

    await press("ArrowRight");

    expect(valuenow()).toBe(MAX);
    expect(storedWidth()).toBe(String(MAX));
  });

  it("MAX 근처에서 큰 이동도 MAX로 clamp된다", async () => {
    localStorage.setItem(WIDTH_KEY, String(MAX - 4));
    renderSidebar();

    await press("ArrowRight");

    expect(valuenow()).toBe(MAX);
  });
});

describe("Home / End", () => {
  it("Home → MIN", async () => {
    renderSidebar();
    await press("Home");

    expect(valuenow()).toBe(MIN);
    expect(asideWidthStyle()).toBe(`${MIN}px`);
    expect(storedWidth()).toBe(String(MIN));
  });

  it("End → MAX", async () => {
    renderSidebar();
    await press("End");

    expect(valuenow()).toBe(MAX);
    expect(asideWidthStyle()).toBe(`${MAX}px`);
    expect(storedWidth()).toBe(String(MAX));
  });
});

describe("Persistence — keyboard resize도 재마운트 후 복원된다", () => {
  it("keyboard resize → unmount → remount → 동일 width + aria-valuenow", async () => {
    const first = renderSidebar();
    await press("End");
    const expected = valuenow();
    expect(expected).toBe(MAX);

    first.unmount();
    renderSidebar();

    expect(valuenow()).toBe(expected);
    expect(storedWidth()).toBe(String(expected));
  });
});

describe("Pointer 회귀 — drag 최적화와 clamp가 유지된다", () => {
  it("drag 중에는 state를 commit하지 않고 DOM만 바꾼다 (aria-valuenow 불변)", async () => {
    renderSidebar();
    const el = handle();
    // jsdom은 pointer capture API를 구현하지 않는다 — 브라우저 API를 대체한다.
    (el as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    (el as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};

    await act(async () => {
      fireEvent.pointerDown(el, { clientX: 300, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { clientX: 400, pointerId: 1 });
    });

    // DOM은 즉시 반영 (성능 최적화 유지) …
    expect(asideWidthStyle()).toBe(`${DEFAULT + 100}px`);
    // … 하지만 React state는 아직 commit되지 않았다.
    expect(valuenow()).toBe(DEFAULT);

    await act(async () => {
      fireEvent.pointerUp(document, { clientX: 400, pointerId: 1 });
    });

    // 종료 시 1회 commit → state/localStorage 동기화
    expect(valuenow()).toBe(DEFAULT + 100);
    expect(storedWidth()).toBe(String(DEFAULT + 100));
  });

  it("drag가 MIN/MAX 밖으로 나가도 clamp된다", async () => {
    renderSidebar();
    const el = handle();
    (el as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    (el as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};

    await act(async () => {
      fireEvent.pointerDown(el, { clientX: 300, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { clientX: 5000, pointerId: 1 });
    });
    expect(asideWidthStyle()).toBe(`${MAX}px`);

    await act(async () => {
      fireEvent.pointerUp(document, { clientX: 5000, pointerId: 1 });
    });
    expect(valuenow()).toBe(MAX);
  });
});

describe("Double-click — 기본값 reset 유지", () => {
  it("더블클릭하면 DEFAULT로 돌아가고 저장된다", async () => {
    localStorage.setItem(WIDTH_KEY, "400");
    renderSidebar();
    expect(valuenow()).toBe(400);

    await act(async () => {
      fireEvent.doubleClick(handle());
    });

    expect(valuenow()).toBe(DEFAULT);
    expect(asideWidthStyle()).toBe(`${DEFAULT}px`);
    expect(storedWidth()).toBe(String(DEFAULT));
  });
});

describe("Mobile — drawer에는 separator가 없다", () => {
  it("≤744px에서 resize handle이 렌더되지 않는다", () => {
    setMobile();
    renderSidebar();

    expect(document.querySelector(".sidebar-resize-handle")).toBeNull();
  });

  it("desktop으로 돌아오면 다시 렌더된다 (mobile 계약이 desktop을 오염시키지 않는다)", async () => {
    setMobile();
    renderSidebar();
    expect(document.querySelector(".sidebar-resize-handle")).toBeNull();

    // 실제 breakpoint crossing — resize 이벤트가 아니라 matchMedia change.
    await crossBreakpoint(DRAWER_MQ, false);
    expect(handle()).toBeTruthy();

    // 다시 mobile로 넘어가면 사라진다.
    await crossBreakpoint(DRAWER_MQ, true);
    expect(document.querySelector(".sidebar-resize-handle")).toBeNull();
  });
});

describe("SOT — clamp 범위가 pointer와 keyboard에서 동일하다", () => {
  it("aria-valuemin/max가 실제 clamp 경계와 일치한다 (MIN-step/MAX+step 불가)", async () => {
    renderSidebar();
    const el = handle();
    const min = Number(el.getAttribute("aria-valuemin"));
    const max = Number(el.getAttribute("aria-valuemax"));

    // MIN까지 내려간 뒤 한 번 더 눌러도 MIN 아래로 못 간다.
    await press("Home");
    await press("ArrowLeft");
    expect(valuenow()).toBe(min);

    // MAX까지 올린 뒤 한 번 더 눌러도 MAX 위로 못 간다.
    await press("End");
    await press("ArrowRight");
    expect(valuenow()).toBe(max);
  });
});

describe("focus 표시 — 실제 shipped CSS에 keyboard focus 스타일이 있다", () => {
  it("globals.css가 .sidebar-resize-handle:focus-visible을 정의한다", () => {
    // tab으로 포커스가 가도 시각 표시가 없으면 keyboard 사용자는 splitter를
    // 찾을 수 없다 — CSS를 실제 stylesheet에서 확인한다.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).toMatch(/\.sidebar-resize-handle:focus-visible\s*\{/);
  });
});

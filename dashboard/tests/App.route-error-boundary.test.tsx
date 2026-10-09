/* Issue #1 A-1 — 라우트 렌더 오류·lazy 청크 로딩 실패가 앱 전체를 빈 화면으로 만들지 않는다.
 *
 * ErrorBoundary가 없으면 하위 라우트의 throw가 루트까지 올라가 React가 #root를 비운다.
 * 데스크톱 셸의 RECOVER_IF_BLANK_JS는 #root가 비면 location.reload()를 하므로,
 * 번들이 깨진 상태에서는 포커스마다 reload → crash → blank가 반복될 수 있다.
 *
 * 실제 App(라우트 표 + Layout)을 렌더하고, 라우트 모듈만 mock해서 오류를 주입한다.
 *   - GardenPage: 렌더 오류(render 모드) 또는 청크 로딩 실패(import 모드)
 *   - HomePage: 정상 화면 표식
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const ctl = vi.hoisted(() => ({
  /** "ok" | "render" (렌더 중 throw) | "import" (모듈 로딩 reject) */
  garden: "ok" as "ok" | "render" | "import",
  gardenImports: 0,
  gardenRenders: 0,
}));

// App의 lazy 로더는 import(...).then((m) => ({ default: m.GardenPage })) 이다.
// export getter에서 throw하면 로더 promise가 브라우저의 청크 실패 오류로 reject된다
// (vi.mock factory 자체의 throw는 vitest가 자기 메시지로 감싸 버려 쓰지 않는다).
// getter는 로더가 돌 때마다 평가되므로 gardenImports = 로딩 시도 횟수.
vi.mock("../src/routes/GardenPage", () => {
  const GardenPage = () => {
    ctl.gardenRenders += 1;
    if (ctl.garden === "render") throw new Error("boom in GardenPage");
    return <div>GARDEN-PAGE-OK</div>;
  };
  return {
    get GardenPage() {
      ctl.gardenImports += 1;
      if (ctl.garden === "import") {
        throw new TypeError("Failed to fetch dynamically imported module: /assets/GardenPage-abc123.js");
      }
      return GardenPage;
    },
  };
});

vi.mock("../src/routes/HomePage", () => ({
  HomePage: () => <div>HOME-PAGE-OK</div>,
}));

const realFetch = window.fetch;

beforeEach(() => {
  vi.resetModules();
  ctl.garden = "ok";
  ctl.gardenImports = 0;
  ctl.gardenRenders = 0;
  window.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/\/api\/vaults(\?|$)/.test(url)) {
      return new Response(
        JSON.stringify({ vaults: [{ name: "alpha", path: "/v/alpha", mode: "personal", owner: "u", default: true }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  // React는 boundary가 잡은 오류도 console.error로 보고한다 — 테스트 출력만 조용히.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  window.fetch = realFetch;
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

async function renderAppAt(path: string) {
  window.history.pushState({}, "", path);
  const { default: App } = await import("../src/App");
  return render(<App />);
}

/** Layout이 살아 있는가 — 사이드바 vault 셀렉터 + 헤더 nav. */
async function expectShellAlive() {
  await waitFor(() => expect(screen.getByRole("combobox", { name: "보관소 선택" })).toBeTruthy());
  expect(screen.getAllByRole("link", { name: /홈/ }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("link", { name: /검색/ }).length).toBeGreaterThan(0);
}

const navLink = (label: RegExp) => screen.getAllByRole("link", { name: label })[0];

describe("App — 라우트 ErrorBoundary (Issue #1 A-1)", () => {
  it("라우트 렌더 오류: 복구 UI를 보여 주고 사이드바·헤더는 유지한다", async () => {
    ctl.garden = "render";
    await renderAppAt("/garden");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("이 화면을 표시하지 못했습니다");
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    // 새로고침 버튼은 청크 실패에만 — 렌더 오류는 새로고침으로 고쳐지지 않는다
    expect(screen.queryByRole("button", { name: "앱 다시 불러오기" })).toBeNull();
    await expectShellAlive();
  });

  it("오류 화면에서 정상 라우트로 이동하면 오류 상태가 풀린다", async () => {
    ctl.garden = "render";
    await renderAppAt("/garden");
    await screen.findByRole("alert");
    fireEvent.click(navLink(/홈/));
    expect(await screen.findByText("HOME-PAGE-OK")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("오류가 난 라우트로 다시 돌아오면 새로 렌더를 시도한다 (오류 상태가 남지 않음)", async () => {
    ctl.garden = "render";
    await renderAppAt("/garden");
    await screen.findByRole("alert");
    fireEvent.click(navLink(/홈/));
    await screen.findByText("HOME-PAGE-OK");
    ctl.garden = "ok";
    fireEvent.click(navLink(/정원/));
    expect(await screen.findByText("GARDEN-PAGE-OK")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("다시 시도: 원인이 해소되면 같은 화면이 정상 복구된다", async () => {
    ctl.garden = "render";
    await renderAppAt("/garden");
    await screen.findByRole("alert");
    ctl.garden = "ok";
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("GARDEN-PAGE-OK")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lazy 청크 로딩 실패: 로딩 실패 안내 + 사이드바·헤더 유지", async () => {
    ctl.garden = "import";
    await renderAppAt("/garden");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("화면 파일을 불러오지 못했습니다");
    // Chrome은 실패한 모듈 URL을 다시 요청하지 않으므로(실측) 브라우저에서는 사용자가 누르는 새로고침을 함께 둔다
    expect(screen.getByRole("button", { name: "앱 다시 불러오기" })).toBeTruthy();
    expect(alert.textContent).not.toContain("다시 실행");
    await expectShellAlive();
  });

  it("lazy 청크 로딩 실패 후 다시 시도: 모듈을 다시 불러와 복구한다", async () => {
    ctl.garden = "import";
    await renderAppAt("/garden");
    await screen.findByRole("alert");
    expect(ctl.gardenImports).toBe(1);
    ctl.garden = "ok";
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("GARDEN-PAGE-OK")).toBeTruthy();
    expect(ctl.gardenImports).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("계속 실패해도 재시도는 클릭당 1회뿐 — 자동 반복·자동 새로고침 없음", async () => {
    ctl.garden = "import";
    await renderAppAt("/garden");
    await screen.findByRole("alert");
    expect(ctl.gardenImports).toBe(1);
    // BrowserRouter가 렌더 때 window.location을 읽으므로, 첫 렌더 뒤에 reload만 감시한다
    const realLocation = window.location;
    const reload = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, reload } });
    try {
      for (let i = 0; i < 3; i++) {
        fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
        await waitFor(() => expect(ctl.gardenImports).toBe(i + 2));
        await screen.findByRole("alert");
      }
      // 사용자가 누르지 않으면 더 이상 시도하지 않는다
      await new Promise((r) => setTimeout(r, 200));
      expect(ctl.gardenImports).toBe(4);
      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toBeTruthy();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: realLocation });
    }
  });

  it("데스크톱(Tauri) 청크 실패: 복구되지 않는 버튼 없이 앱 재실행을 안내한다", async () => {
    // WKWebView는 실패한 모듈 URL을 location.reload() 뒤에도 같은 프로세스 안에서 기억한다
    // (PR #33 Tauri 실측) — 새로고침 버튼은 눌러도 같은 오류로 돌아온다.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      ctl.garden = "import";
      await renderAppAt("/garden");
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("화면 파일을 불러오지 못했습니다");
      expect(alert.textContent).toContain("앱을 종료한 뒤 다시 실행하세요");
      expect(screen.queryByRole("button", { name: "앱 다시 불러오기" })).toBeNull();
      // 같은 모듈 재요청조차 나가지 않으므로(WKWebView 실측) "다시 시도"도 두지 않는다
      expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
      await expectShellAlive();
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it("데스크톱(Tauri) 렌더 오류: 기존 안내 그대로 (재실행 안내는 청크 실패에만)", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      ctl.garden = "render";
      await renderAppAt("/garden");
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("이 화면을 표시하지 못했습니다");
      expect(alert.textContent).not.toContain("다시 실행");
      expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it("렌더 오류가 계속되어도 렌더 시도가 폭주하지 않는다", async () => {
    ctl.garden = "render";
    await renderAppAt("/garden");
    await screen.findByRole("alert");
    await new Promise((r) => setTimeout(r, 100));
    const before = ctl.gardenRenders;
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await screen.findByRole("alert");
    await new Promise((r) => setTimeout(r, 100));
    // React는 오류 시 한 번 더 렌더를 재시도하고, StrictMode/dev는 이중 렌더한다 — 상한만 본다
    expect(ctl.gardenRenders - before).toBeGreaterThan(0);
    expect(ctl.gardenRenders - before).toBeLessThanOrEqual(4);
  });

  it("정상 라우트는 기존대로 렌더된다 (회귀 없음)", async () => {
    await renderAppAt("/");
    expect(await screen.findByText("HOME-PAGE-OK")).toBeTruthy();
    fireEvent.click(navLink(/정원/));
    expect(await screen.findByText("GARDEN-PAGE-OK")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    await expectShellAlive();
  });
});

describe("AppErrorBoundary — Layout 자체가 터져도 #root를 비우지 않는다", () => {
  it("최상위 오류는 전체 화면 복구 UI로 대체된다", async () => {
    const { AppErrorBoundary } = await import("../src/components/RouteErrorBoundary");
    const Boom = () => {
      throw new Error("layout boom");
    };
    const { container } = render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(container.hasChildNodes()).toBe(true);
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });
});

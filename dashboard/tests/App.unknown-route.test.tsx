/* Issue #1 A-5 — 미등록 경로가 빈 화면이 되지 않는다.
 *
 * Tauri는 없는 경로도 index.html로 돌려주므로(asset fallback, 런타임 확인) 새로고침·직접 이동은
 * 앱까지 온다. 그런데 라우트 표에 catch-all이 없으면 <Routes>가 아무것도 그리지 않아 #root가 비고,
 * 셸의 blank 복구(blank_recovery.js)가 그것을 고장으로 보고 reload 3회 뒤 "앱을 다시 실행" 차단
 * 안내로 끝난다 (격리 Tauri 실측: /no/such/route).
 *
 * 실제 App(라우트 표 + Layout)을 렌더하고 라우트 모듈만 표식으로 mock한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { useLocation, useParams } from "react-router-dom";
import RECOVERY_SRC from "../../desktop/src-tauri/src/blank_recovery.js?raw";

vi.mock("../src/routes/HomePage", () => ({
  HomePage: () => <div>HOME-PAGE-OK</div>,
}));

vi.mock("../src/routes/PageView", () => ({
  PageView: () => {
    const params = useParams();
    const loc = useLocation();
    return (
      <div data-testid="page-view">
        {`PAGE ${params.vault}|${params["*"]}|${loc.search}|${loc.hash}`}
      </div>
    );
  },
}));

const realFetch = window.fetch;

beforeEach(() => {
  vi.resetModules();
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
});

afterEach(() => {
  cleanup();
  window.fetch = realFetch;
  vi.restoreAllMocks();
  document.getElementById("root")?.remove();
  window.history.pushState({}, "", "/");
});

/** index.html처럼 #root 안에 앱을 그린다 — 셸의 blank 판정은 #root의 자식 유무만 본다. */
async function renderAppAt(path: string) {
  window.history.pushState({}, "", path);
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  const { default: App } = await import("../src/App");
  render(<App />, { container: root });
  return root;
}

async function expectShellAlive() {
  await waitFor(() => expect(screen.getByRole("combobox", { name: "보관소 선택" })).toBeTruthy());
  expect(screen.getAllByRole("link", { name: /홈/ }).length).toBeGreaterThan(0);
}

const NOT_FOUND = "페이지를 찾을 수 없습니다";

describe("App — 미등록 경로 (Issue #1 A-5)", () => {
  it("미등록 경로: 빈 화면 대신 페이지 없음 안내를 Layout 안에 보여 준다", async () => {
    const root = await renderAppAt("/no/such/route");
    expect(await screen.findByText(NOT_FOUND)).toBeTruthy();
    expect(screen.getByText(/\/no\/such\/route/)).toBeTruthy();
    await expectShellAlive();
    expect(root.hasChildNodes()).toBe(true);
  });

  it("vault 없는 /page 처럼 파라미터가 빠진 경로도 페이지 없음 안내", async () => {
    await renderAppAt("/page");
    expect(await screen.findByText(NOT_FOUND)).toBeTruthy();
    expect(screen.queryByTestId("page-view")).toBeNull();
  });

  it("한글 미등록 경로는 디코드해서 보여 준다", async () => {
    await renderAppAt(`/${encodeURIComponent("없는 화면")}/x`);
    expect(await screen.findByText(NOT_FOUND)).toBeTruthy();
    expect(screen.getByText(/\/없는 화면\/x/)).toBeTruthy();
  });

  it("홈으로 가기: 문서를 다시 불러오지 않고 / 로 이동한다", async () => {
    await renderAppAt("/no/such/route");
    await screen.findByText(NOT_FOUND);
    fireEvent.click(screen.getByRole("button", { name: "홈으로 가기" }));
    expect(await screen.findByText("HOME-PAGE-OK")).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByText(NOT_FOUND)).toBeNull();
  });

  it("정상 경로 회귀: / 는 홈을 그리고 페이지 없음 안내가 없다", async () => {
    await renderAppAt("/");
    expect(await screen.findByText("HOME-PAGE-OK")).toBeTruthy();
    expect(screen.queryByText(NOT_FOUND)).toBeNull();
    await expectShellAlive();
  });

  it("중첩 한글 경로 회귀: /page/:vault/* 파라미터·query·hash 유지", async () => {
    await renderAppAt(`/page/v1/notes/${encodeURIComponent("한글 페이지")}?x=1#h`);
    const view = await screen.findByTestId("page-view");
    expect(view.textContent).toBe("PAGE v1|notes/한글 페이지|?x=1|#h");
    expect(screen.queryByText(NOT_FOUND)).toBeNull();
  });

  it("셸 blank 복구: 페이지 없음 화면은 blank로 판정되지 않는다 (reload·카운터 없음)", async () => {
    await renderAppAt("/no/such/route");
    await screen.findByText(NOT_FOUND);
    const recover = new Function(`${RECOVERY_SRC}\nreturn __ravenBlankRecovery;`)() as (env: object) => void;
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    const reload = vi.fn();
    for (let i = 0; i < 4; i++) {
      recover({ document, storage: () => storage, uptime: 60_000 + i * 15_000, reload });
    }
    expect(reload).not.toHaveBeenCalled();
    expect(mem.get("raven:blank-recovery")).toBeUndefined();
    expect(document.getElementById("raven-blank-recovery-notice")).toBeNull();
  });
});

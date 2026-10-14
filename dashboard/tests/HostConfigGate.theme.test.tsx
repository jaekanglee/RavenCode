/* Issue #32 잔여 — "오류 화면이 선택한 테마를 무시한다".
 *
 * 수정 전: 색 모드(`html.dark` 클래스 + `data-color-mode` 속성)를 설정하는 곳은
 * `Layout.tsx` 하나뿐이었다. 그런데 원격 호스트 설정이 깨졌을 때는 `HostConfigGate`가
 * Layout *대신* 그려지므로(요청을 보내는 화면을 그리지 않기 위해) 그 화면에는 테마가
 * 적용되지 않았다 — 다크 모드 사용자가 흰 화면을 보고, 버튼/텍스트가 라이트 토큰으로
 * 그려졌다.
 *
 * 이 테스트는 오류 화면이 저장된(또는 OS) 색 모드를 따르는지, 그리고 그 소유자가
 * `lib/theme` 한 곳인지 검증한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const A = "http://100.64.0.1:8765";

/** 원격 호스트를 골라 뒀는데 목록이 없음 → api-base가 이 탭의 요청을 거절한다. */
function breakHostConfig() {
  localStorage.removeItem("raven:hosts");
  localStorage.setItem("raven:active_host", "a");
}

function healthyHostConfig() {
  localStorage.setItem("raven:hosts", JSON.stringify([{ id: "local", name: "로컬", endpoint: "", isLocal: true }]));
  localStorage.setItem("raven:active_host", "local");
}

function root() {
  return window.document.documentElement;
}

function resetRoot() {
  root().classList.remove("dark");
  root().removeAttribute("data-color-mode");
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  resetRoot();
});

afterEach(() => {
  cleanup();
  resetRoot();
});

async function renderGate() {
  const { HostConfigGate } = await import("../src/components/HostConfigGate");
  return render(
    <HostConfigGate reload={() => {}}>
      <div data-testid="app">앱</div>
    </HostConfigGate>,
  );
}

describe("HostConfigGate — 오류 화면도 저장된 테마를 따른다 (Issue #32 잔여)", () => {
  it("저장된 다크 테마가 오류 화면에 적용된다", async () => {
    breakHostConfig();
    localStorage.setItem("theme", "dark");

    await renderGate();

    // 게이트가 실제로 오류 화면을 그렸고 앱은 그리지 않았다.
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("app")).toBeNull();

    // 수정 전에는 여기가 실패했다 (Layout이 없으므로 테마가 적용되지 않았다).
    expect(root().classList.contains("dark")).toBe(true);
    expect(root().getAttribute("data-color-mode")).toBe("dark");
  });

  it("저장된 라이트 테마는 오류 화면을 라이트로 유지한다", async () => {
    breakHostConfig();
    localStorage.setItem("theme", "light");

    await renderGate();

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(root().classList.contains("dark")).toBe(false);
    expect(root().getAttribute("data-color-mode")).toBe("light");
  });

  it("저장된 값이 없으면 OS 설정(prefers-color-scheme)을 따른다", async () => {
    breakHostConfig();
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-color-scheme: dark"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      await renderGate();
      expect(root().getAttribute("data-color-mode")).toBe("dark");
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it("정상 설정에서는 앱을 그리고 테마 소유자는 Layout이다 (게이트가 덮어쓰지 않는다)", async () => {
    healthyHostConfig();
    localStorage.setItem("theme", "dark");
    // Layout이 아직 적용하지 않은 상태를 가정한다.
    expect(root().classList.contains("dark")).toBe(false);

    await renderGate();

    expect(screen.getByTestId("app")).toBeTruthy();
    // 정상 경로에서 게이트는 색 모드를 쓰지 않는다 — Layout의 몫이다.
    expect(root().classList.contains("dark")).toBe(false);
  });
});

describe("lib/theme — 색 모드 적용의 단일 소유자", () => {
  it("applyColorMode는 클래스와 속성을 함께 맞춘다", async () => {
    const theme = await import("../src/lib/theme");
    theme.applyColorMode("dark");
    expect(root().classList.contains("dark")).toBe(true);
    expect(root().getAttribute("data-color-mode")).toBe("dark");
    theme.applyColorMode("light");
    expect(root().classList.contains("dark")).toBe(false);
    expect(root().getAttribute("data-color-mode")).toBe("light");
  });

  it("저장 키는 boot-theme.js와 같은 'theme'이다", async () => {
    const theme = await import("../src/lib/theme");
    theme.persistColorMode("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(theme.readStoredColorMode()).toBe("dark");
  });
});

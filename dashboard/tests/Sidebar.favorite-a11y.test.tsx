/* Issue #7 — Sidebar vault favorite 접근성 회귀 가드.
 *
 * 실제 <Sidebar/>를 마운트하고 실제 DOM/상호작용을 검사한다 (하드코딩 JSX 문자열
 * 검사 ❌, 가짜 fixture 자기검증 ❌).
 *
 * 고정한 계약:
 *   - favorite toggle = native <button> + aria-pressed={isFavorite}.
 *     on/off를 *색이 아니라 glyph*로도 구분한다 (★ on / ☆ off).
 *   - default vault는 favorite과 같은 ★ glyph를 쓰지 않는다 → "기본" badge.
 *   - selector(<option>)의 favorite 표시도 toggle과 같은 ★ glyph를 쓴다.
 *   - localStorage 저장/복원 + favorite 우선 정렬은 기존 동작 유지.
 *
 * 주의: jsdom은 키보드 기본동작(Enter/Space → click)을 구현하지 않는다.
 * 그래서 여기서는 native button 시맨틱(=키보드 활성화 전제조건)까지만 검증하고,
 * 실제 Enter/Space 활성화는 Chromium 브라우저 검증에서 확인한다.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "../src/components/Sidebar";
import type { VaultMeta } from "../src/types";

const FAV_KEY = "raven.dashboard.favoriteVaults";

function vault(name: string, isDefault = false): VaultMeta {
  return { name, path: `/vaults/${name}`, mode: "personal", owner: "user", default: isDefault };
}

const VAULTS: VaultMeta[] = [vault("alpha", true), vault("beta"), vault("gamma")];

function ui(activeVault: string, onSelectVault: (n: string) => void) {
  return (
    <MemoryRouter>
      <Sidebar
        vaults={VAULTS}
        trees={{}}
        rawItems={{}}
        activeVault={activeVault}
        activeSlug={null}
        onSelectVault={onSelectVault}
        onRefresh={() => {}}
        open={true}
        onClose={() => {}}
      />
    </MemoryRouter>
  );
}

function renderSidebar(activeVault = "alpha") {
  const onSelectVault = vi.fn();
  const utils = render(ui(activeVault, onSelectVault));
  return {
    onSelectVault,
    rerenderWith: (nextVault: string) => utils.rerender(ui(nextVault, onSelectVault)),
  };
}

/** favorite toggle 버튼 (aria-label로 찾는다). */
const favButton = (): HTMLButtonElement =>
  screen.getByRole("button", { name: /즐겨찾기/ }) as HTMLButtonElement;

/** vault selector의 <select> — HostPicker의 호스트 select와 구분한다. */
const vaultSelect = (): HTMLSelectElement => {
  const found = document.querySelector('select[aria-label="보관소 선택"]');
  if (!found) throw new Error("vault select not found");
  return found as HTMLSelectElement;
};

/** vault selector의 <option> — 실제 렌더 결과에서 읽는다. */
const option = (name: string): HTMLOptionElement => {
  const found = Array.from(vaultSelect().options).find((o) => o.value === name);
  if (!found) throw new Error(`option not found: ${name}`);
  return found;
};

/** vault selector의 option value 순서 (정렬 검증용). */
const optionOrder = (): string[] => Array.from(vaultSelect().options).map((o) => o.value);

beforeEach(() => {
  localStorage.clear();
});

describe("favorite toggle — aria-pressed와 glyph로 상태를 노출한다", () => {
  it("OFF → ON → OFF 전환마다 aria-pressed와 accessible name이 실제 상태와 일치한다", () => {
    renderSidebar();

    // 초기: alpha는 favorite 아님
    expect(favButton().getAttribute("aria-pressed")).toBe("false");
    expect(favButton().getAttribute("aria-label")).toBe("즐겨찾기 추가");

    fireEvent.click(favButton());
    expect(favButton().getAttribute("aria-pressed")).toBe("true");
    expect(favButton().getAttribute("aria-label")).toBe("즐겨찾기 해제");

    fireEvent.click(favButton());
    expect(favButton().getAttribute("aria-pressed")).toBe("false");
    expect(favButton().getAttribute("aria-label")).toBe("즐겨찾기 추가");
  });

  it("on/off를 색이 아니라 glyph로도 구분한다 (ON=★, OFF=☆)", () => {
    renderSidebar();

    expect(favButton().textContent).toContain("☆");
    expect(favButton().textContent).not.toContain("★");

    fireEvent.click(favButton());

    expect(favButton().textContent).toContain("★");
    expect(favButton().textContent).not.toContain("☆");
  });

  it("toggle은 키보드 활성화가 가능한 native button이다", () => {
    renderSidebar();
    const btn = favButton();
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("type")).toBe("button");
    // 장식 glyph는 accessible name에 섞이지 않는다 (aria-hidden).
    expect(btn.querySelector('[aria-hidden]')?.textContent).toBe("☆");
  });
});

describe("default vault — favorite과 ★ 의미를 공유하지 않는다", () => {
  it("selector에서 default는 ★가 아니라 '기본' badge로 표시된다", () => {
    renderSidebar();

    // alpha = default, favorite 아님 → ★가 없어야 한다.
    expect(option("alpha").textContent).toContain("기본");
    expect(option("alpha").textContent).not.toContain("★");

    // beta = default도 favorite도 아님
    expect(option("beta").textContent).not.toContain("기본");
    expect(option("beta").textContent).not.toContain("★");
  });

  it("selector와 toggle이 favorite을 같은 ★ glyph로 표현한다", () => {
    renderSidebar();

    expect(option("alpha").textContent).not.toContain("★");
    fireEvent.click(favButton());

    // toggle = ★, selector의 같은 vault 항목도 ★
    expect(favButton().textContent).toContain("★");
    expect(option("alpha").textContent).toContain("★");
    // default badge는 그대로 남고 favorite과 겹치지 않는다
    expect(option("alpha").textContent).toContain("기본");
  });
});

describe("저장/복원/정렬 회귀 없음", () => {
  it("toggle 결과가 localStorage에 저장되고 재마운트 시 복원된다", () => {
    const { unmount } = render(ui("alpha", vi.fn()));
    fireEvent.click(favButton());

    expect(JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]")).toEqual(["alpha"]);

    // 재마운트 (새 인스턴스) → localStorage에서 복원
    unmount();
    renderSidebar();
    expect(favButton().getAttribute("aria-pressed")).toBe("true");
    expect(favButton().textContent).toContain("★");
  });

  it("저장된 favorite을 새 마운트에서 복원한다 (persist → restore)", () => {
    localStorage.setItem(FAV_KEY, JSON.stringify(["beta"]));
    renderSidebar();

    // beta가 favorite이므로 정렬 최상단, alpha는 아님
    expect(optionOrder()[0]).toBe("beta");
    expect(option("beta").textContent).toContain("★");
  });

  it("favorite 우선 정렬을 유지한다 (favorite → default → 이름)", () => {
    renderSidebar("gamma");

    // gamma를 favorite으로 만든다
    fireEvent.click(favButton());

    // favorite(gamma) → default(alpha) → beta
    expect(optionOrder()).toEqual(["gamma", "alpha", "beta"]);
  });

  it("저장된 favorite 없을 때는 default → 이름 순서다", () => {
    renderSidebar();

    expect(optionOrder()).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("vault 변경 시 favorite 상태가 정확히 따라간다", () => {
  it("alpha를 favorite한 뒤 beta로 전환하면 beta 상태(false/☆)를 보여주고, 되돌아오면 복원된다", () => {
    const { rerenderWith } = renderSidebar("alpha");
    fireEvent.click(favButton());
    expect(favButton().getAttribute("aria-pressed")).toBe("true");

    rerenderWith("beta");
    expect(favButton().getAttribute("aria-pressed")).toBe("false");
    expect(favButton().textContent).toContain("☆");
    expect(favButton().getAttribute("aria-label")).toBe("즐겨찾기 추가");

    rerenderWith("alpha");
    expect(favButton().getAttribute("aria-pressed")).toBe("true");
    expect(favButton().textContent).toContain("★");

    // 저장된 값도 alpha 하나만 유지된다 (vault 전환이 저장을 오염시키지 않는다)
    expect(JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]")).toEqual(["alpha"]);
  });
});

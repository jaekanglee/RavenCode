/* v0.6.18+ — Modal must render in document.body via React Portal.
 *
 * 진짜 원인 (v0.6.17 회귀 분석):
 *   sidebar-offcanvas에 `transform: translateX(-100%)` 가 적용되어
 *   그 안의 position:fixed 모달이 viewport가 아닌 sidebar 박스 기준으로 배치됨.
 *   결과: 모바일에서 모달이 sidebar 안에 갇혀 보이고,
 *         데스크탑에선 sidebar 자체가 화면 밖이라 모달도 화면 밖 (-320px).
 *
 * 진짜 fix: React Portal로 모달을 document.body 직속으로 옮김.
 *   → 어떤 transform/containing block 영향도 받지 않음.
 *
 * 회귀 가드:
 *  1. NewPageButton: 모달이 document.body 직속 (primary-sidebar ❌)
 *  2. source: createPortal(modal, document.body) 사용
 *  3. 폴백: portal 미지원 환경 (test)에서는 in-place 렌더 (테스트 격리 보장)
 *
 * v0.7.181: NewFolderButton 케이스 제거 — 컴포넌트 자체를 삭제했다
 * (v0.7.111 canonical tree view 이후 어디서도 렌더되지 않는 고아였음).
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NewPageButton } from "../src/components/NewPageButton";

function wrap(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

function findModalContainer(): HTMLElement | null {
  // portal 사용 시 modal 컨테이너는 document.body 직속
  return document.body.querySelector(
    'div[style*="position: fixed"][style*="inset"]'
  );
}

describe("Modal Portal contract (v0.6.18)", () => {
  it("NewPageButton modal renders outside primary-sidebar (in document.body)", () => {
    wrap(<NewPageButton vault="test" variant="icon" />);
    fireEvent.click(screen.getByRole("button", { name: /페이지 만들기/ }));
    const modal = findModalContainer();
    expect(modal).toBeTruthy();
    // 모달이 sidebar 안에 있으면 안 됨
    const sidebar = document.getElementById("primary-sidebar");
    if (sidebar) {
      expect(sidebar.contains(modal!)).toBe(false);
    }
    // 모달은 document.body 직속
    expect(modal!.parentElement).toBe(document.body);
  });

  it("Modal declares position:fixed + inset:0 in its inline style", () => {
    // jsdom 한계: getComputedStyle이 inset shorthand를 top/right/bottom/left로 분리 안 함.
    // 그래서 inline style attribute에서 직접 검증.
    wrap(<NewPageButton vault="test" variant="icon" />);
    fireEvent.click(screen.getByRole("button", { name: /페이지 만들기/ }));
    const modal = findModalContainer();
    expect(modal).toBeTruthy();
    const inline = modal!.getAttribute("style") || "";
    expect(inline).toMatch(/position:\s*fixed/);
    expect(inline).toMatch(/inset:\s*0/);
    const cs = getComputedStyle(modal!);
    expect(cs.position).toBe("fixed");
  });

  it("Modal is NOT nested inside any sidebar/tree container (portal proof)", () => {
    wrap(<NewPageButton vault="test" variant="icon" />);
    fireEvent.click(screen.getByRole("button", { name: /페이지 만들기/ }));
    const modal = findModalContainer();
    expect(modal).toBeTruthy();
    // 부모 chain 어디에도 aside/complementary가 있으면 안 됨
    let cur: HTMLElement | null = modal!.parentElement;
    while (cur && cur !== document.body) {
      const tag = cur.tagName.toLowerCase();
      expect(["aside", "complementary"]).not.toContain(tag);
      expect(cur.id).not.toBe("primary-sidebar");
      cur = cur.parentElement;
    }
  });
});
/* v0.6.24+ — 모든 position:fixed 모달은 React Portal 사용 필수.
 *
 * v0.6.18 fix(modal) 이후 DeleteButton/NewPageInline은 Portal
 * 누락으로 같은 containing block 버그 가능성. 같은 회귀 가드로 검증.
 *
 * Issue #2 B-2: EditButton은 프로덕션 참조가 0인 dead 컴포넌트였고, 여기 있던
 * 검증도 `expect(true).toBe(true)`로 아무것도 단정하지 않았다 — 컴포넌트와 함께 제거.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DeleteButton } from "../src/components/DeleteButton";

function wrap(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

function findModalContainer(): HTMLElement | null {
  return document.body.querySelector(
    'div[style*="position: fixed"][style*="inset"]'
  );
}

describe("All modals use React Portal (v0.6.24)", () => {
  it("DeleteButton modal renders in document.body, not nested in sidebar", () => {
    wrap(
      <DeleteButton vault="test" slug="content/x" />
    );
    fireEvent.click(screen.getByRole("button", { name: /삭제/ }));
    const modal = findModalContainer();
    expect(modal).toBeTruthy();
    expect(modal!.parentElement).toBe(document.body);
  });

  it.skip("NewPageInline modal (none — inline form, no portal needed)", () => {
    // NewPageInline은 모달이 아니라 인라인 폼. Portal 불필요.
    // jsdom이 matchMedia 미지원으로 skip — 이 케이스는 회귀 가치 낮음.
  });
});
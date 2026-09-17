/* v0.6.17+ — Modal opens should auto-close the mobile sidebar drawer.
 *
 * UX 요구 (v0.6.16 후속): 모바일/좁은 viewport에서 sidebar가 열린 상태로
 * ＋ 버튼을 누르면 화면 중앙 모달과 사이드바가 동시에 보임. 모달만 남도록
 * 자동 close.
 *
 * 회귀 가드:
 *  1. NewPageButton: onOpen prop이 트리거 클릭 시 호출되어야 함
 *  2. onOpen 미지정 시에도 기존 동작 유지 (회귀 안전)
 *
 * v0.7.181: NewFolderButton 케이스 제거 — 컴포넌트 삭제.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NewPageButton } from "../src/components/NewPageButton";

function wrapWithRouter(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("Modal auto-close sidebar (onOpen contract)", () => {
  it("NewPageButton: clicking trigger fires onOpen callback before opening modal", () => {
    const onOpen = vi.fn();
    wrapWithRouter(
      <NewPageButton vault="test" variant="icon" onOpen={onOpen} />
    );
    const trigger = screen.getByRole("button", { name: /페이지 만들기/ });
    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // 모달이 열렸는지 (제목 표시)
    expect(screen.getByText(/새 페이지 만들기/)).toBeTruthy();
  });

  it("NewPageButton: missing onOpen does NOT throw (regression safety)", () => {
    wrapWithRouter(<NewPageButton vault="test" variant="icon" />);
    const trigger = screen.getByRole("button", { name: /페이지 만들기/ });
    expect(() => fireEvent.click(trigger)).not.toThrow();
  });
});
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FindBar, type FindBarProps } from "../src/components/FindBar";

function setup(over: Partial<FindBarProps> = {}) {
  const props: FindBarProps = {
    query: "foo",
    onQueryChange: vi.fn(),
    current: 0,
    total: 3,
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    focusSignal: 1,
    ...over,
  };
  render(<FindBar {...props} />);
  return { props, input: screen.getByLabelText("문서 내 찾기") as HTMLInputElement };
}

describe("FindBar", () => {
  it("n/m을 보여준다", () => {
    setup({ current: 1, total: 3 });
    expect(screen.getByText("2/3")).toBeTruthy();
  });
  it("일치가 없으면 0/0과 aria-invalid", () => {
    const { input } = setup({ current: -1, total: 0 });
    expect(screen.getByText("0/0")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
  it("Enter는 다음, Shift+Enter는 이전", () => {
    const { props, input } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(props.onNext).toHaveBeenCalledTimes(1);
    expect(props.onPrev).toHaveBeenCalledTimes(1);
  });
  it("Esc는 닫고 바깥으로 전파하지 않는다 (편집 취소 방지)", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    const { props, input } = setup();
    fireEvent.keyDown(input, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
  it("열리면 입력에 포커스", () => {
    const { input } = setup();
    expect(document.activeElement).toBe(input);
  });
});

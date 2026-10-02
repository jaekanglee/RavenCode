import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FindBackdrop } from "../src/components/FindBackdrop";

describe("FindBackdrop", () => {
  it("일치 구간을 mark로 감싸고 현재 항목에 표시한다", () => {
    const { container } = render(
      <FindBackdrop text="foo bar foo" matches={[[0, 3], [8, 11]]} current={1} />,
    );
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[1].className).toContain("find-mark-current");
    expect(marks[0].className).not.toContain("find-mark-current");
  });
  it("원문 텍스트를 그대로 보존한다 (끝 줄바꿈 하나 추가)", () => {
    const { container } = render(<FindBackdrop text={"a\nb"} matches={[[2, 3]]} current={0} />);
    expect(container.firstElementChild!.textContent).toBe("a\nb\n");
  });
  it("스크린리더에서 숨긴다", () => {
    const { container } = render(<FindBackdrop text="x" matches={[]} current={-1} />);
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });
});

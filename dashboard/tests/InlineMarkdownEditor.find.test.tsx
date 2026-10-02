/* 문서 내 찾기 (Cmd/Ctrl+F) — InlineMarkdownEditor 통합 회귀 가드.
 *  1. Cmd+F가 브라우저 기본 동작을 막고 찾기 막대를 연다
 *  2. 읽기 모드에서 렌더된 본문의 일치 개수를 센다
 *  3. 편집 모드에서 textarea 원문 기준으로 세고, Enter/Shift+Enter로 순환한다
 *  4. 찾기 막대의 Esc가 편집을 취소하지 않는다
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { InlineMarkdownEditor } from "../src/components/InlineMarkdownEditor";

function renderEditor(content = "foo bar foo") {
  return render(
    <MemoryRouter>
      <InlineMarkdownEditor vault="v1" slug="content/hello" title="Hello" content={content} />
    </MemoryRouter>,
  );
}

const openFind = () => fireEvent.keyDown(document, { key: "f", metaKey: true });
const findInput = () => screen.getByLabelText("문서 내 찾기") as HTMLInputElement;

describe("InlineMarkdownEditor 문서 내 찾기", () => {
  it("Cmd+F가 기본 동작을 막고 막대를 연다", () => {
    renderEditor();
    expect(screen.queryByLabelText("문서 내 찾기")).toBeNull();
    const notPrevented = openFind();
    expect(notPrevented).toBe(false);
    expect(findInput()).toBeTruthy();
  });

  it("Ctrl+F도 연다", () => {
    renderEditor();
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    expect(findInput()).toBeTruthy();
  });

  it("읽기 모드: 렌더된 본문에서 센다", () => {
    renderEditor();
    openFind();
    fireEvent.change(findInput(), { target: { value: "foo" } });
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("편집 모드: 원문 기준으로 세고 순환한다", () => {
    const { container } = renderEditor();
    fireEvent.keyDown(document, { key: "e", metaKey: true }); // 편집 모드
    openFind();
    fireEvent.change(findInput(), { target: { value: "foo" } });
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.keyDown(findInput(), { key: "Enter" });
    expect(screen.getByText("2/2")).toBeTruthy();
    fireEvent.keyDown(findInput(), { key: "Enter", shiftKey: true });
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(container.querySelectorAll(".find-backdrop mark")).toHaveLength(2);
  });

  it("찾기 막대 Esc는 편집을 취소하지 않는다", () => {
    const { container } = renderEditor();
    fireEvent.keyDown(document, { key: "e", metaKey: true });
    openFind();
    fireEvent.keyDown(findInput(), { key: "Escape" });
    expect(screen.queryByLabelText("문서 내 찾기")).toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("찾기 막대 없이 textarea의 Esc는 여전히 편집을 취소한다", () => {
    const { container } = renderEditor();
    fireEvent.keyDown(document, { key: "e", metaKey: true });
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    fireEvent.keyDown(textarea!, { key: "Escape" });
    expect(container.querySelector("textarea")).toBeNull();
  });
});

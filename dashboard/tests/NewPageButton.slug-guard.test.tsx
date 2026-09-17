/* v0.7.181 — NewPageButton 제출 전 slug 유효성 (defense-in-depth layer 2).
 *
 * 배경: 사이드바 canonical 그룹 "＋"가 `__canonical/issue`를 프리필하던 버그
 * (Sidebar.new-page-target.test.tsx)의 2차 방어선. 프리필을 고쳐도 사용자가
 * 직접 입력하거나 다른 호출부가 생기면 같은 쓰레기 경로가 API로 나간다.
 * raven/core/slug.py의 거부 규칙(빈 segment, '..', ':', 절대경로, '~')을
 * 클라이언트에서 먼저 잡아, 400 + 영문 detail 대신 한국어 안내를 보여준다.
 *
 * 회귀 가드:
 *  1. 폴더까지만 적힌 경로(trailing slash) 거부 — 파일명 없음
 *  2. __canonical 세그먼트 거부 — UI 내부 sentinel
 *  3. '..' / ':' / 절대경로 / '~' 거부 (백엔드 규칙 미러)
 *  4. 정상 경로는 통과
 *  5. DOM: 저장 클릭 시 API 호출 전에 한국어 에러가 뜬다
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NewPageButton, validatePageSlug } from "../src/components/NewPageButton";

describe("validatePageSlug", () => {
  it("폴더까지만 적힌 경로는 파일명이 없다고 거부", () => {
    expect(validatePageSlug("content/issues/")).toMatch(/파일명/);
  });

  it("빈 segment(a//b)도 같은 이유로 거부", () => {
    expect(validatePageSlug("content//foo")).toMatch(/파일명/);
  });

  it("__canonical 세그먼트는 내부 그룹 이름이라 거부", () => {
    expect(validatePageSlug("__canonical/issue")).toMatch(/__canonical/);
    expect(validatePageSlug("content/__canonical/issue")).toMatch(/__canonical/);
  });

  it("'..' / ':' / 절대경로 / '~' 는 백엔드 규칙대로 거부", () => {
    expect(validatePageSlug("content/../etc/passwd")).toBeTruthy();
    expect(validatePageSlug("C:/content/foo")).toBeTruthy();
    expect(validatePageSlug("/content/foo")).toBeTruthy();
    expect(validatePageSlug("~/content/foo")).toBeTruthy();
  });

  it("정상 경로는 통과 (null)", () => {
    expect(validatePageSlug("content/issues/2026-09-10-foo")).toBeNull();
    expect(validatePageSlug("content/flat")).toBeNull();
    expect(validatePageSlug("foo")).toBeNull();
  });
});

describe("NewPageButton 저장 가드 (DOM)", () => {
  it("폴더까지만 입력하고 저장하면 API 대신 한국어 에러를 보여준다", async () => {
    render(
      <MemoryRouter>
        <NewPageButton vault="test" variant="icon" initialSlug="content/issues/" />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: /페이지 만들기/ }));

    const pathInput = (await waitFor(() => screen.getByLabelText(/^경로/))) as HTMLInputElement;
    expect(pathInput.value).toBe("content/issues/");
    fireEvent.change(screen.getByLabelText(/^제목/), { target: { value: "테스트 제목" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    // 경로 필드 helper 문구에도 "파일명"이 들어 있어 정확한 문장으로 확인.
    const err = await screen.findByText("경로 마지막에 파일명을 입력해 주세요.");
    expect(err).toBeTruthy();
    // API로 나갔다면 'create failed' 류 영문 메시지가 떴을 것.
    expect(document.body.textContent).not.toContain("create failed");
  });
});

import { describe, expect, it } from "vitest";
import { findMatches, wrapIndex } from "../src/lib/findInText";

describe("findMatches", () => {
  it("빈 검색어는 일치 없음", () => {
    expect(findMatches("abc", "")).toEqual([]);
  });
  it("대소문자를 구분하지 않는다", () => {
    expect(findMatches("Foo foo FOO", "foo")).toEqual([[0, 3], [4, 7], [8, 11]]);
  });
  it("겹치는 일치는 세지 않는다 (브라우저 찾기와 동일)", () => {
    expect(findMatches("aaa", "aa")).toEqual([[0, 2]]);
  });
  it("한글과 줄바꿈", () => {
    expect(findMatches("백업\n백업 기능", "백업")).toEqual([[0, 2], [3, 5]]);
  });
  it("소문자화로 길이가 바뀌는 문자가 있으면 원문 그대로 비교한다", () => {
    // "İ".toLowerCase()는 2글자 → 인덱스가 밀리지 않아야 한다
    expect(findMatches("İx x", "x")).toEqual([[1, 2], [3, 4]]);
  });
});

describe("wrapIndex", () => {
  it("total 0이면 -1", () => expect(wrapIndex(3, 0)).toBe(-1));
  it("앞뒤로 순환한다", () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
  });
});

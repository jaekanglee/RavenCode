/* P1 회귀 가드 — 전역 탭은 5개 이하이고, 320/390/744/1024/1440에서 레일이 잘리지 않는다.
 *  1. 상시 노출 레일 = 탐색 4개 + 더보기 1개 (운영 도구는 하위)
 *  2. 320/390에서는 비활성 탭이 아이콘만 남아 폭을 먹지 않는다
 *  3. 더보기 안의 경로에 있으면 더보기 트리거가 활성으로 보인다
 */
import { describe, expect, it } from "vitest";
import {
  MORE_NAV,
  PRIMARY_NAV,
  SECTION_NAV_MAX,
  isMoreNavActive,
  planSectionNav,
} from "../src/components/Layout";

const BREAKPOINTS = [320, 390, 744, 1024, 1440];

describe("전역 섹션 nav 정보구조", () => {
  it("상시 노출 레일은 5칸을 넘지 않는다", () => {
    for (const width of BREAKPOINTS) {
      const plan = planSectionNav(width);
      expect(plan.railItems).toBeLessThanOrEqual(SECTION_NAV_MAX);
      expect(plan.primary.length + 1).toBe(plan.railItems);
    }
  });

  it("정원·린트·관리·워크스페이스는 더보기 하위로 내려간다", () => {
    const primaryPaths = PRIMARY_NAV.map((t) => t.to);
    expect(primaryPaths).toEqual(["/", "/search", "/graph", "/log"]);
    expect(MORE_NAV.map((t) => t.to)).toEqual([
      "/garden",
      "/lint",
      "/workspace",
      "/vault/manage",
    ]);
    for (const entry of MORE_NAV) {
      expect(primaryPaths).not.toContain(entry.to);
    }
  });

  it("좁은 폭에서만 compact(아이콘 위주)로 접힌다", () => {
    expect(planSectionNav(320).compact).toBe(true);
    expect(planSectionNav(390).compact).toBe(true);
    expect(planSectionNav(744).compact).toBe(false);
    expect(planSectionNav(1024).compact).toBe(false);
    expect(planSectionNav(1440).compact).toBe(false);
  });

  it("더보기 하위 경로에서 트리거가 활성으로 표시된다", () => {
    expect(isMoreNavActive("/lint")).toBe(true);
    expect(isMoreNavActive("/vault/manage/rename")).toBe(true);
    expect(isMoreNavActive("/graph")).toBe(false);
    expect(isMoreNavActive("/")).toBe(false);
  });

  it("탐색 탭 매치는 서로 겹치지 않는다", () => {
    for (const entry of PRIMARY_NAV) {
      const matched = [...PRIMARY_NAV, ...MORE_NAV].filter((other) => other.match(entry.to));
      expect(matched.map((m) => m.to)).toEqual([entry.to]);
    }
  });
});

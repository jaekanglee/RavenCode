import { describe, it, expect, vi } from "vitest";
import {
  buildLinkStyle,
  computeCommunityLabels,
  computeLayeredAxis,
  computeTimelineGrid,
  computeTimelineLayout,
  createLabelMetricsCache,
  createLabelOccupancyGrid,
  isIndexPage,
  isWithinViewport,
  mixHex,
  resolveDisplayLabel,
  resolveTypePalette,
  seedForceNodes,
  TYPE_COLOR_FALLBACK,
} from "./render";
import type { GraphNode } from "../../types";

/** 고정폭 mock: 문자 1개 = 6px. measureText 호출 횟수를 세어 캐시 동작을 검증한다. */
function makeCountingCtx(charWidth = 6) {
  const measureText = vi.fn((text: string) => ({ width: text.length * charWidth }));
  return { ctx: { measureText } as unknown as CanvasRenderingContext2D, measureText };
}

function node(partial: Partial<GraphNode> & { id: string }): GraphNode {
  return { title: partial.id, slug: partial.id, ...partial } as GraphNode;
}

describe("resolveDisplayLabel — 프레임당 measureText 제거 (A4)", () => {
  it("같은 (라벨, 폭) 조합을 반복 호출하면 measureText는 첫 호출에서만 실행된다", () => {
    const { ctx, measureText } = makeCountingCtx();
    const cache = createLabelMetricsCache();
    const first = resolveDisplayLabel(ctx, cache, "매우매우매우긴제목입니다", 30);
    const callsAfterFirst = measureText.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    for (let i = 0; i < 50; i += 1) {
      expect(resolveDisplayLabel(ctx, cache, "매우매우매우긴제목입니다", 30)).toBe(first);
    }
    expect(measureText.mock.calls.length).toBe(callsAfterFirst);
  });

  it("폭 안에 들어가는 라벨은 그대로, 넘치는 라벨은 말줄임표로 잘린다", () => {
    const { ctx } = makeCountingCtx();
    const cache = createLabelMetricsCache();
    expect(resolveDisplayLabel(ctx, cache, "짧은제목", 100)).toBe("짧은제목");
    const truncated = resolveDisplayLabel(ctx, cache, "abcdefghijklmnopqrstuvwxyz", 50);
    expect(truncated.endsWith("…")).toBe(true);
    expect(ctx.measureText(truncated).width).toBeLessThanOrEqual(50);
  });

  it("폭이 달라지면 캐시를 재사용하지 않고 새로 계산한다", () => {
    const { ctx, measureText } = makeCountingCtx();
    const cache = createLabelMetricsCache();
    resolveDisplayLabel(ctx, cache, "abcdefghij", 30);
    const afterNarrow = measureText.mock.calls.length;
    resolveDisplayLabel(ctx, cache, "abcdefghij", 12);
    expect(measureText.mock.calls.length).toBeGreaterThan(afterNarrow);
  });
});

describe("createLabelOccupancyGrid — 라벨 충돌 회피 (B1)", () => {
  it("먼저 자리를 잡은 라벨과 겹치는 라벨은 거절된다", () => {
    const grid = createLabelOccupancyGrid(10);
    expect(grid.tryOccupy(0, 0, 40, 12)).toBe(true);
    expect(grid.tryOccupy(8, 2, 40, 12)).toBe(false);
  });

  it("충분히 떨어진 라벨은 모두 허용된다", () => {
    const grid = createLabelOccupancyGrid(10);
    expect(grid.tryOccupy(0, 0, 20, 12)).toBe(true);
    expect(grid.tryOccupy(400, 400, 20, 12)).toBe(true);
  });

  it("reset 후에는 같은 자리를 다시 쓸 수 있다", () => {
    const grid = createLabelOccupancyGrid(10);
    expect(grid.tryOccupy(0, 0, 20, 12)).toBe(true);
    expect(grid.tryOccupy(0, 0, 20, 12)).toBe(false);
    grid.reset();
    expect(grid.tryOccupy(0, 0, 20, 12)).toBe(true);
  });
});

describe("isWithinViewport — 뷰포트 컬링 (B1)", () => {
  const bounds = { x0: 0, y0: 0, x1: 100, y1: 100 };

  it("화면 안 노드는 그린다", () => {
    expect(isWithinViewport(50, 50, 5, bounds)).toBe(true);
  });

  it("화면 밖으로 완전히 벗어난 노드는 버린다", () => {
    expect(isWithinViewport(-500, 50, 5, bounds)).toBe(false);
    expect(isWithinViewport(50, 900, 5, bounds)).toBe(false);
  });

  it("경계에 반쯤 걸친 노드는 반지름만큼 여유를 두고 살린다", () => {
    expect(isWithinViewport(-4, 50, 6, bounds)).toBe(true);
    expect(isWithinViewport(104, 50, 6, bounds)).toBe(true);
  });
});

describe("computeTimelineLayout — O(n^2) find 제거 (A5)", () => {
  const nodes = [
    node({ id: "old", type: "concept", created: "2026-01-01" }),
    node({ id: "mid", type: "project", created: "2026-06-01" }),
    node({ id: "new", type: "concept", created: "2026-12-01" }),
  ];

  it("시간 순서대로 x가 증가하고 타입별로 y가 갈린다", () => {
    const coords = computeTimelineLayout(nodes);
    expect(Object.keys(coords).sort()).toEqual(["mid", "new", "old"]);
    expect(coords.old.x).toBeLessThan(coords.mid.x);
    expect(coords.mid.x).toBeLessThan(coords.new.x);
    expect(coords.old.y).not.toBe(coords.mid.y);
  });

  it("같은 결과를 결정론적으로 반환한다", () => {
    expect(computeTimelineLayout(nodes)).toEqual(computeTimelineLayout(nodes));
  });

  it("같은 날짜에 몰린 노드는 좌우로 흩어 놓는다", () => {
    const sameDay = [
      node({ id: "a", type: "concept", created: "2026-05-05" }),
      node({ id: "b", type: "concept", created: "2026-05-05" }),
      node({ id: "c", type: "concept", created: "2026-05-05" }),
    ];
    const coords = computeTimelineLayout(sameDay);
    const xs = new Set([coords.a.x, coords.b.x, coords.c.x]);
    expect(xs.size).toBe(3);
  });

  it("노드 2000개도 전부 좌표를 받는다", () => {
    const many = Array.from({ length: 2000 }, (_unused, i) =>
      node({ id: `n${i}`, type: "concept", created: "2026-03-03" })
    );
    expect(Object.keys(computeTimelineLayout(many))).toHaveLength(2000);
  });
});

describe("computeTimelineGrid — 프레임당 격자 재생성 제거 (A4)", () => {
  const spread = [
    node({ id: "a", created: "2025-01-01" }),
    node({ id: "b", created: "2026-12-31" }),
  ];

  it("연 단위로 벌어진 범위는 5등분 날짜 눈금을 만든다", () => {
    const grid = computeTimelineGrid(spread);
    expect(grid).toHaveLength(5);
    expect(grid[0].x).toBeLessThan(grid[4].x);
    expect(grid[0].label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("눈금 x는 타임라인 좌표축 범위 안에 있다", () => {
    for (const point of computeTimelineGrid(spread)) {
      expect(point.x).toBeGreaterThanOrEqual(-460);
      expect(point.x).toBeLessThanOrEqual(460);
    }
  });

  it("빈 입력에는 눈금이 없다", () => {
    expect(computeTimelineGrid([])).toEqual([]);
  });

  it("같은 입력에 같은 격자를 돌려준다", () => {
    expect(computeTimelineGrid(spread)).toEqual(computeTimelineGrid(spread));
  });
});

describe("computeLayeredAxis — 레이어 축 1회 계산 (A4)", () => {
  it("존재하는 layer 값만 오름차순 중복 없이 모은다", () => {
    const axis = computeLayeredAxis([
      node({ id: "a", layer: 2 }),
      node({ id: "b", layer: 0 }),
      node({ id: "c", layer: 2 }),
      node({ id: "d", layer: 1.4 }),
    ]);
    expect(axis).toEqual([0, 1, 2]);
  });

  it("layer가 없으면 빈 축이다", () => {
    expect(computeLayeredAxis([node({ id: "a" })])).toEqual([]);
  });
});

describe("computeCommunityLabels — 프레임당 키워드 분석 제거 (A4)", () => {
  it("커뮤니티별로 대표 키워드가 붙은 라벨을 1회 계산한다", () => {
    const nodes = [
      node({ id: "1", title: "Raven 그래프 렌더러", community: 0, importance: 0.9 }),
      node({ id: "2", title: "Raven 그래프 캐시", community: 0, importance: 0.2 }),
      node({ id: "3", title: "모바일 오프라인", community: 1, importance: 0.5 }),
    ];
    const labels = computeCommunityLabels(nodes);
    expect(labels.get(0)).toContain("Community 0");
    expect(labels.get(0)?.toLowerCase()).toContain("raven");
    expect(labels.get(1)).toContain("Community 1");
  });

  it("빈 입력에도 안전하다", () => {
    expect(computeCommunityLabels([]).size).toBe(0);
  });
});

describe("buildLinkStyle — 링크 색 사전 계산 (A4)", () => {
  it("의미 관계는 관계색 + 유효한 rgba 알파 변형을 갖는다", () => {
    const style = buildLinkStyle({ source: "a", target: "b", relation_type: "uses" });
    expect(style.base).toBe("#3b82f6");
    expect(style.normal).toBe("rgba(59, 130, 246, 0.6)");
    expect(style.faded).toBe("rgba(59, 130, 246, 0.13)");
  });

  it("broken dependency는 빨강으로 고정된다", () => {
    const style = buildLinkStyle({ source: "a", target: "b", broken_dependency: true });
    expect(style.base).toBe("#ef4444");
    expect(style.normal).toBe("#ef4444");
    expect(style.faded).toBe("#ef4444");
  });

  it("일반 wikilink는 테마 색을 쓰라고 null을 돌려준다", () => {
    expect(buildLinkStyle({ source: "a", target: "b" }).base).toBeNull();
  });
});

describe("resolveTypePalette — 색 토큰화 (B2)", () => {
  it("CSS 변수가 있으면 변수 값을 쓴다", () => {
    const palette = resolveTypePalette((name) =>
      name === "--graph-type-concept" ? "#123456" : ""
    );
    expect(palette.concept).toBe("#123456");
  });

  it("CSS 변수가 비어 있으면 하드코딩 fallback으로 떨어진다", () => {
    const palette = resolveTypePalette(() => "");
    expect(palette.concept).toBe(TYPE_COLOR_FALLBACK.concept);
    expect(palette.issue).toBe(TYPE_COLOR_FALLBACK.issue);
  });

  it("9종 문서 타입 전부에 색이 있다", () => {
    const palette = resolveTypePalette(() => "");
    for (const type of ["concept", "person", "tool", "comparison", "project", "rule", "query", "journal", "issue"]) {
      expect(palette[type]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("seedForceNodes", () => {
  const scale = 2;
  const noRandom = () => 0.5;

  it("사용자가 저장한 노드(pinned)만 고정하고 나머지는 시뮬레이션에 맡긴다", () => {
    const seeded = seedForceNodes(
      [
        { id: "a", title: "A", x: 10, y: -5, pinned: true },
        { id: "b", title: "B", x: 3, y: 4 },
      ],
      new Map(),
      scale,
      noRandom
    );
    expect(seeded[0]).toMatchObject({ x: 20, y: -10, fx: 20, fy: -10 });
    expect(seeded[1]).toMatchObject({ x: 6, y: 8 });
    expect(seeded[1].fx).toBeUndefined();
    expect(seeded[1].fy).toBeUndefined();
  });

  it("서버 좌표가 그대로인 노드는 직전 프레임 위치를 이어받는다 (필터·재조회)", () => {
    const previous = new Map([["a", { x: 100, y: 200, __srcX: 1, __srcY: 1 }]]);
    const [node] = seedForceNodes([{ id: "a", title: "A", x: 1, y: 1 }], previous, scale, noRandom);
    expect(node).toMatchObject({ x: 100, y: 200 });
    expect(node.fx).toBeUndefined();
  });

  it("서버 좌표가 바뀐 노드(리셋 등)는 새 서버 좌표에서 다시 출발한다", () => {
    const previous = new Map([["a", { x: 100, y: 200, fx: 100, fy: 200, __srcX: 50, __srcY: 100 }]]);
    const [node] = seedForceNodes([{ id: "a", title: "A", x: 3, y: 4 }], previous, scale, noRandom);
    expect(node).toMatchObject({ x: 6, y: 8 });
    expect(node.fx).toBeUndefined();
  });

  it("고정 여부는 서버 pinned만 따른다 — 직전 프레임의 fx/fy는 이어받지 않는다", () => {
    const previous = new Map([["a", { x: 100, y: 200, fx: 100, fy: 200, __srcX: 1, __srcY: 1 }]]);
    const [node] = seedForceNodes([{ id: "a", title: "A", x: 1, y: 1 }], previous, scale, noRandom);
    expect(node.fx).toBeUndefined();
    const [pinned] = seedForceNodes(
      [{ id: "a", title: "A", x: 1, y: 1, pinned: true }],
      previous,
      scale,
      noRandom
    );
    expect(pinned).toMatchObject({ x: 2, y: 2, fx: 2, fy: 2 });
  });

  it("좌표가 없는 노드는 원점 근처에 뿌린다", () => {
    const [node] = seedForceNodes([{ id: "c", title: "C" }], new Map(), scale, () => 1);
    expect(node.x).toBe(8);
    expect(node.y).toBe(8);
    expect(node.fx).toBeUndefined();
  });
});

describe("isIndexPage", () => {
  it("index_builder가 만드는 목차 페이지만 목차로 본다", () => {
    expect(isIndexPage("content/index")).toBe(true);
    expect(isIndexPage("content/_index/journal")).toBe(true);
    expect(isIndexPage("content/journal/2026-09-08-회의")).toBe(false);
    expect(isIndexPage("content/__canonical/issue")).toBe(false);
    expect(isIndexPage("content/indexing-guide")).toBe(false);
  });
});

describe("mixHex", () => {
  it("두 색을 비율대로 섞고, 형식이 다르면 원래 색을 돌려준다", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#22c55e", "#64748b", 0)).toBe("#22c55e");
    expect(mixHex("#22c55e", "#64748b", 1)).toBe("#64748b");
    expect(mixHex("rgba(1,2,3,0.5)", "#64748b", 0.5)).toBe("rgba(1,2,3,0.5)");
  });
});

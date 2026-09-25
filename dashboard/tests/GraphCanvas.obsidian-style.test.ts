import { describe, it, expect } from "vitest";
import {
  computeFocusDepthMap,
  computeLayeredLayout,
  nodeColor,
  nodeOpacity,
  nodeSize,
} from "../src/components/GraphCanvas";

/**
 * v0.6.11 Graph B — Obsidian-style 신경망 그래프 회귀 가드.
 *
 * 검증 범위:
 *   - Patch 1: nodeSize — 연결 수 제곱근에 비례하는 작은 점
 *   - Patch 1: nodeColor는 SCHEMA 8종 + 확장에 매핑, 미인식은 default
 *   - Patch 2: (overlay는 React Flow 마운트 필요 — 헬퍼만 정적 검증)
 *
 * React Flow 마운트 자체는 ResizeObserver 의존으로 jsdom에서 어렵기 때문에
 * 핵심 결정 로직만 정적으로 검증한다.
 */
describe("GraphCanvas v0.6.11 Obsidian-style", () => {
  describe("nodeSize (Patch 1 — small dots)", () => {
    // 살아 있는 force 물리 도입과 함께 Obsidian식 작은 점으로 재조정.
    //   - normal: 3 + sqrt(w)*1.6   (leaf 4.6, w=4 → 6.2, w=9 → 7.8, w=24 → 10.8)
    //   - dense:  2.5 + sqrt(w)*1.3
    // 이전 log2 공식(leaf 14, hub 36)은 점이 버튼처럼 커서 링크 거미줄만 도드라졌다.
    it("weight=0 → 4.6 (orphan, dots size never zero)", () => {
      expect(nodeSize(0)).toBeCloseTo(4.6, 5);
    });

    it("weight=1 → 4.6 (가장 작은 정상 사이즈)", () => {
      expect(nodeSize(1)).toBeCloseTo(4.6, 5);
    });

    it("weight=4 → 6.2 (중간 크기 점)", () => {
      expect(nodeSize(4)).toBeCloseTo(6.2, 5);
    });

    it("weight=9 → 7.8 (허브)", () => {
      expect(nodeSize(9)).toBeCloseTo(7.8, 5);
    });

    it("weight=24 → 10.84 (가장 큰 hub)", () => {
      expect(nodeSize(24)).toBeCloseTo(10.84, 1);
    });

    it("undefined → weight=1과 동일한 fallback", () => {
      expect(nodeSize(undefined)).toBeCloseTo(4.6, 5);
    });

    it("음수 → weight=1로 clamp", () => {
      expect(nodeSize(-3)).toBeCloseTo(4.6, 5);
    });

    it("dense 모드는 normal보다 작음", () => {
      expect(nodeSize(9, "dense")).toBeCloseTo(6.4, 5);
      expect(nodeSize(9, "dense")).toBeLessThan(nodeSize(9, "normal"));
    });

    it("dense hub cap — weight=24도 30px 이하 (사용자: '두껍다')", () => {
      expect(nodeSize(24, "dense")).toBeLessThanOrEqual(30);
    });

    it("허브는 leaf보다 확연히 크지만 버튼처럼 커지지 않는다", () => {
      expect(nodeSize(24) / nodeSize(1)).toBeGreaterThan(2);
      expect(nodeSize(24)).toBeLessThanOrEqual(12);
    });
  });

  describe("nodeColor (Patch 1 — type color mapping)", () => {
    it("SCHEMA 9종 mapping은 고유 hex 색상", () => {
      expect(nodeColor("concept")).toBe("#22c55e");
      expect(nodeColor("person")).toBe("#ec4899");
      expect(nodeColor("tool")).toBe("#6b7280");
      expect(nodeColor("comparison")).toBe("#ef4444");
      expect(nodeColor("project")).toBe("#f97316");
      expect(nodeColor("rule")).toBe("#6366f1");
      expect(nodeColor("query")).toBe("#eab308");
      expect(nodeColor("journal")).toBe("#06b6d4");
      expect(nodeColor("issue")).toBe("#a855f7");
    });

    it("legacy/non-schema type은 default gray (#9ca3af)", () => {
      expect(nodeColor("decision")).toBe("#9ca3af");
      expect(nodeColor("manual")).toBe("#9ca3af");
      expect(nodeColor("pattern")).toBe("#9ca3af");
      expect(nodeColor("insight")).toBe("#9ca3af");
    });

    it("미인식 type은 default gray (#9ca3af)", () => {
      expect(nodeColor("unknown-xyz")).toBe("#9ca3af");
      expect(nodeColor("")).toBe("#9ca3af");
      expect(nodeColor(undefined)).toBe("#9ca3af");
    });
  });

  describe("Post-MVP analytics visual mapping", () => {
    it("freshness는 opacity로 0.32~1.0 범위에 매핑된다", () => {
      expect(nodeOpacity(undefined)).toBe(1);
      expect(nodeOpacity(1)).toBeCloseTo(1, 5);
      expect(nodeOpacity(0)).toBeCloseTo(0.32, 5);
      expect(nodeOpacity(0.5)).toBeCloseTo(0.66, 5);
      expect(nodeOpacity(-1)).toBeCloseTo(0.32, 5);
      expect(nodeOpacity(2)).toBeCloseTo(1, 5);
    });

    it("layered 레이아웃은 낮은 layer를 더 왼쪽에 배치하고 같은 layer는 세로로 분산한다", () => {
      const coords = computeLayeredLayout([
        { id: "core", title: "Core", layer: 0, importance: 0.8 },
        { id: "api", title: "API", layer: 1, importance: 0.6 },
        { id: "dashboard", title: "Dashboard", layer: 2, importance: 0.4 },
        { id: "dashboard-2", title: "Dashboard 2", layer: 2, importance: 0.2 },
      ]);

      expect(coords["core"].x).toBeLessThan(coords["api"].x);
      expect(coords["api"].x).toBeLessThan(coords["dashboard"].x);
      expect(coords["dashboard"].x).toBeCloseTo(coords["dashboard-2"].x, 5);
      expect(coords["dashboard"].y).not.toBe(coords["dashboard-2"].y);
    });

    it("focus depth map is BFS-based and caps traversal depth", () => {
      const nodes = [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
        { id: "c", title: "C" },
        { id: "d", title: "D" },
      ];
      const edges = [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
        { source: "c", target: "d" },
      ];

      const depthMap = computeFocusDepthMap(nodes as any, edges as any, "b", 1);

      expect(depthMap.get("b")).toBe(0);
      expect(depthMap.get("a")).toBe(1);
      expect(depthMap.get("c")).toBe(1);
      expect(depthMap.get("d")).toBeUndefined();
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  computeFocusDepthMap,
  nodeColor,
  nodeOpacity,
  computeNodeAlpha,
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

describe("computeNodeAlpha — 포커스 중 물러난 노드도 보이게", () => {
  it("포커스 밖 노드는 최소 투명도 아래로 내려가지 않는다", () => {
    // 오래된 문서(freshness 0 → 0.32) + 포커스 밖 + 깊이 밖이 곱해져 0.065까지 내려가
    // 별자리 톤 위에서 사실상 사라졌다 ("80개인데 하나만 보인다").
    const dimmed = computeNodeAlpha({ fillOpacity: 0.32, dimmed: true, focusDepth: undefined, depthMapSize: 5 });
    expect(dimmed).toBeGreaterThanOrEqual(0.2);
  });

  it("포커스가 없으면 freshness 투명도를 그대로 쓴다", () => {
    expect(computeNodeAlpha({ fillOpacity: 0.66, dimmed: false, focusDepth: undefined, depthMapSize: 0 })).toBeCloseTo(0.66, 5);
  });

  it("깊이 안의 노드는 촌수가 멀수록 옅어지지만 물러난 노드보다는 진하다", () => {
    const near = computeNodeAlpha({ fillOpacity: 1, dimmed: false, focusDepth: 1, depthMapSize: 5 });
    const far = computeNodeAlpha({ fillOpacity: 1, dimmed: false, focusDepth: 3, depthMapSize: 5 });
    const out = computeNodeAlpha({ fillOpacity: 1, dimmed: true, focusDepth: undefined, depthMapSize: 5 });
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(out);
  });
});

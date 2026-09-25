import { describe, expect, it } from "vitest";
import {
  findClosestNodeHit,
  isStationaryClickGesture,
  shouldShowLabel,
} from "../src/components/GraphCanvas";

describe("GraphCanvas direct click hit detection", () => {
  it("picks the closest node within the padded hit radius", () => {
    const hit = findClosestNodeHit(
      [
        { id: "a", x: 100, y: 100, weight: 1 },
        { id: "b", x: 140, y: 100, weight: 8 },
      ],
      { x: 134, y: 100 },
      "normal"
    );

    expect(hit?.id).toBe("b");
  });

  it("matches the visual node circle instead of adding a large invisible halo", () => {
    // Node size at weight 1 is 4.6. With zero padding and multiplier=1,
    // hit detection should follow the actual drawn node radius exactly.
    const edgeHit = findClosestNodeHit(
      [{ id: "a", x: 100, y: 100, weight: 1 }],
      { x: 104.5, y: 100 },
      "normal",
      0,
      1
    );
    expect(edgeHit?.id).toBe("a");

    const justOutside = findClosestNodeHit(
      [{ id: "a", x: 100, y: 100, weight: 1 }],
      { x: 104.7, y: 100 },
      "normal",
      0,
      1
    );
    expect(justOutside).toBeNull();
  });

  it("does not make touch targets larger than the visible node circle", () => {
    const nodes = [{ id: "a", x: 100, y: 100, weight: 1 }];

    expect(findClosestNodeHit(nodes, { x: 104.5, y: 100 }, "normal", 0, 1, 0)?.id).toBe("a");
    expect(findClosestNodeHit(nodes, { x: 104.7, y: 100 }, "normal", 0, 1, 0)).toBeNull();
  });

  it("uses fx/fy when live force-graph nodes have no stable x/y yet", () => {
    const hit = findClosestNodeHit(
      [{ id: "a", fx: 280, fy: 140, weight: 1 }],
      { x: 280, y: 140 },
      "normal"
    );

    expect(hit?.id).toBe("a");
  });

  it("returns null when the pointer lands outside every node radius", () => {
    const hit = findClosestNodeHit(
      [{ id: "solo", x: 100, y: 100, weight: 1 }],
      { x: 180, y: 180 },
      "normal"
    );

    expect(hit).toBeNull();
  });

  it("uses a looser movement tolerance for touch than mouse", () => {
    expect(
      isStationaryClickGesture(
        { x: 100, y: 100 },
        { x: 108, y: 108 },
        "mouse"
      )
    ).toBe(false);

    expect(
      isStationaryClickGesture(
        { x: 100, y: 100 },
        { x: 108, y: 108 },
        "touch"
      )
    ).toBe(true);
  });

  describe("shouldShowLabel visibility rules", () => {
    it("respects zoom-out declutter (scale < 0.7) unless focused or highlighted", () => {
      const issueNode = { type: "issue", weight: 1 };
      const conceptNode = { type: "concept", weight: 9 };

      // At scale 0.6, no label is shown by default
      expect(shouldShowLabel(issueNode, 0.6, false, false, false)).toBe(false);
      expect(shouldShowLabel(conceptNode, 0.6, false, false, false)).toBe(false);

      // Unless focused or highlighted
      expect(shouldShowLabel(issueNode, 0.6, false, true, false)).toBe(true);
      expect(shouldShowLabel(conceptNode, 0.6, false, false, true)).toBe(true);
    });

    it("shows issue node labels when sufficiently zoomed in (scale > 1.0 or 1.15)", () => {
      const lowWeightIssue = { type: "issue", weight: 1 };

      // Normal mode: shows if scale > 1.0 (e.g., 1.1)
      expect(shouldShowLabel(lowWeightIssue, 0.8, false, false, false)).toBe(false);
      expect(shouldShowLabel(lowWeightIssue, 1.1, false, false, false)).toBe(true);

      // Dense mode: shows if scale > 1.15 (e.g., 1.2)
      expect(shouldShowLabel(lowWeightIssue, 1.1, true, false, false)).toBe(false);
      expect(shouldShowLabel(lowWeightIssue, 1.2, true, false, false)).toBe(true);
    });

    it("respects weight-based visibility for non-issue nodes", () => {
      const conceptNodeWeight3 = { type: "concept", weight: 3 };
      const conceptNodeWeight1 = { type: "concept", weight: 1 };
      const hubNodeWeight8 = { type: "concept", weight: 8 };

      // Normal mode:
      // Weight >= 8 shows at any zoom >= 0.7
      expect(shouldShowLabel(hubNodeWeight8, 0.8, false, false, false)).toBe(true);
      // Weight 3 shows only if scale > 1.0
      expect(shouldShowLabel(conceptNodeWeight3, 0.8, false, false, false)).toBe(false);
      expect(shouldShowLabel(conceptNodeWeight3, 1.1, false, false, false)).toBe(true);
      // Weight 1 never shows unless focused/highlighted
      expect(shouldShowLabel(conceptNodeWeight1, 1.5, false, false, false)).toBe(false);
    });

    it("shows every label once zoomed in close (Obsidian-style)", () => {
      const leaf = { type: "concept", weight: 1 };
      expect(shouldShowLabel(leaf, 2.4, false, false, false)).toBe(false);
      expect(shouldShowLabel(leaf, 2.5, false, false, false)).toBe(true);
      expect(shouldShowLabel(leaf, 2.5, true, false, false)).toBe(true);
    });
  });
});

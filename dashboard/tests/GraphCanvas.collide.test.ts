/* 그래프 노드 겹침 방지 — 충돌 힘(createCollideForce).
 *
 *  1) 겹친 두 노드는 반지름 합(+여백) 이상으로 벌어진다
 *  2) 고정 노드(fx/fy, 사용자가 드래그로 저장한 좌표)는 움직이지 않고 상대만 밀려난다
 *  3) 완전히 같은 좌표여도 NaN 없이 벌어진다
 */
import { describe, expect, it } from "vitest";
import { createCollideForce } from "../src/components/GraphCanvas";

type SimNode = { x: number; y: number; vx: number; vy: number; __collideR: number; fx?: number; fy?: number };

function simulate(nodes: SimNode[], ticks = 120) {
  const force = createCollideForce();
  force.initialize(nodes);
  for (let t = 0; t < ticks; t++) {
    force(1);
    for (const n of nodes) {
      if (n.fx != null) {
        n.x = n.fx;
        n.y = n.fy ?? n.y;
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.x += n.vx;
      n.y += n.vy;
      n.vx *= 0.7; // d3VelocityDecay(0.3)
      n.vy *= 0.7;
    }
  }
}

const dist = (a: SimNode, b: SimNode) => Math.hypot(a.x - b.x, a.y - b.y);
const node = (x: number, y: number, r = 5): SimNode => ({ x, y, vx: 0, vy: 0, __collideR: r });

describe("createCollideForce", () => {
  it("겹친 노드를 반지름 합 이상으로 벌린다", () => {
    const a = node(0, 0);
    const b = node(3, 0);
    const c = node(1, 2);
    simulate([a, b, c]);

    for (const [p, q] of [[a, b], [a, c], [b, c]] as const) {
      expect(dist(p, q)).toBeGreaterThanOrEqual(10 - 0.5);
    }
  });

  it("고정 노드는 그대로 두고 상대만 밀어낸다", () => {
    const pinned = { ...node(0, 0), fx: 0, fy: 0 };
    const free = node(2, 0);
    simulate([pinned, free]);

    expect(pinned.x).toBe(0);
    expect(pinned.y).toBe(0);
    expect(dist(pinned, free)).toBeGreaterThanOrEqual(10 - 0.5);
  });

  it("같은 좌표여도 NaN 없이 벌어진다", () => {
    const a = node(5, 5);
    const b = node(5, 5);
    simulate([a, b]);

    expect(Number.isFinite(a.x) && Number.isFinite(b.x)).toBe(true);
    expect(dist(a, b)).toBeGreaterThanOrEqual(10 - 0.5);
  });

  it("떨어진 노드는 건드리지 않는다", () => {
    const a = node(0, 0);
    const b = node(50, 0);
    simulate([a, b]);

    expect(a.x).toBe(0);
    expect(b.x).toBe(50);
  });
});

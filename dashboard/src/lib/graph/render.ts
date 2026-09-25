/**
 * dashboard/src/lib/graph/render.ts — 그래프 캔버스 렌더 보조 순수 함수.
 *
 * GraphCanvas의 페인트 루프에서 프레임마다 다시 계산되던 연산을 데이터 변경 시
 * 1회 계산으로 끌어내기 위한 모듈이다. 옮겨온 대상:
 *   - 라벨 절단: 노드마다 매 프레임 measureText 이진탐색 → (폰트, 폭, 라벨) 캐시
 *   - 링크 색: 링크마다 매 프레임 정규식 + 문자열 조립 → 데이터 변경 시 1회
 * 여기에 라벨 충돌 회피(격자 점유)와 뷰포트 컬링을 더한다.
 *
 * React/DOM/force-graph에 의존하지 않는 순수 함수 — 단위 테스트 대상.
 */
import type { GraphNode } from "../../types";

export interface LabelMetricsCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface LabelOccupancyGrid {
  /** 라벨 바운딩 박스(좌상단 x/y + 폭/높이)를 격자에 등록. 이미 점유된 칸과
   *  겹치면 false를 돌려주고 아무것도 등록하지 않는다. */
  tryOccupy(x: number, y: number, width: number, height: number): boolean;
  reset(): void;
}

export interface ViewportBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LinkStyle {
  /** 의미 관계/경고 색. null이면 호출자가 테마 색(--graph-edge)을 쓴다. */
  base: string | null;
  /** 포커스가 없을 때의 색 */
  normal: string;
  /** 다른 노드가 포커스된 동안 흐리게 물러난 색 */
  faded: string;
}

export interface LinkStyleInput {
  source: string;
  target: string;
  relation_type?: string | null;
  broken_dependency?: boolean;
}

/** SCHEMA 9종 문서 타입의 기본 색 — CSS 변수(--graph-type-*)가 없을 때만 쓰인다. */
export const TYPE_COLOR_FALLBACK: Record<string, string> = {
  concept: "#22c55e",
  person: "#ec4899",
  tool: "#6b7280",
  comparison: "#ef4444",
  project: "#f97316",
  rule: "#6366f1",
  query: "#eab308",
  journal: "#06b6d4",
  issue: "#a855f7",
};

export const RELATION_COLOR_FALLBACK: Record<string, string> = {
  uses: "#3b82f6",
  depends_on: "#ef4444",
  implements: "#a855f7",
  implemented_by: "#d946ef",
  related: "#14b8a6",
};

const BROKEN_DEPENDENCY_COLOR = "#ef4444";

/**
 * hex("#rrggbb") 또는 rgb()/rgba() 문자열의 알파만 바꿔 rgba()로 정규화한다.
 * hex에 알파 16진수를 이어 붙이는 방식은 rgba() 입력에서 무효 CSS가 되어
 * 캔버스가 직전 유효 색을 그대로 쓰는 버그를 만든다.
 */
export function withAlpha(color: string, alpha: number): string {
  const rgbaMatch = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbaMatch) {
    const [r, g, b] = rgbaMatch[1].split(",").map((part) => part.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const hexMatch = color.match(/^#([0-9a-fA-F]{6})$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

export function createLabelMetricsCache(): LabelMetricsCache {
  return new Map<string, string>();
}

/**
 * ctx.measureText 이진탐색으로 라벨을 폭에 맞춰 자른다 (캐시 미스일 때만).
 * GraphCanvas가 같은 이름으로 re-export한다 (기존 import 경로 보존).
 */
export function truncateLabel(ctx: CanvasRenderingContext2D, label: string, maxWidth: number): string {
  if (ctx.measureText(label).width <= maxWidth) return label;
  const ellipsis = "…";
  if (ctx.measureText(ellipsis).width > maxWidth) return "";
  let lo = 0;
  let hi = label.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(label.slice(0, mid) + ellipsis).width <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return label.slice(0, lo) + ellipsis;
}

/**
 * 절단된 표시 라벨을 돌려준다. 같은 (폰트, 폭, 라벨) 조합은 캐시에서 꺼내므로
 * measureText는 조합마다 한 번만 실행된다 — 노드 N개 × 프레임당 log(len)번
 * 측정하던 비용이 사라진다.
 */
export function resolveDisplayLabel(
  ctx: CanvasRenderingContext2D,
  cache: LabelMetricsCache,
  label: string,
  maxWidth: number
): string {
  const widthKey = Math.round(maxWidth);
  const key = `${ctx.font ?? ""}|${widthKey}|${label}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const resolved = truncateLabel(ctx, label, maxWidth);
  cache.set(key, resolved);
  return resolved;
}

/**
 * 라벨 바운딩 박스를 격자에 등록해 겹치는 라벨을 걸러낸다. 캔버스 좌표계에서
 * cellSize 단위로 칸을 나누고, 박스가 덮는 칸이 이미 점유돼 있으면 거절한다.
 */
export function createLabelOccupancyGrid(cellSize: number): LabelOccupancyGrid {
  const size = cellSize > 0 ? cellSize : 1;
  const occupied = new Set<string>();
  return {
    tryOccupy(x, y, width, height) {
      const cx0 = Math.floor(x / size);
      const cx1 = Math.floor((x + width) / size);
      const cy0 = Math.floor(y / size);
      const cy1 = Math.floor((y + height) / size);
      for (let cx = cx0; cx <= cx1; cx += 1) {
        for (let cy = cy0; cy <= cy1; cy += 1) {
          if (occupied.has(`${cx},${cy}`)) return false;
        }
      }
      for (let cx = cx0; cx <= cx1; cx += 1) {
        for (let cy = cy0; cy <= cy1; cy += 1) {
          occupied.add(`${cx},${cy}`);
        }
      }
      return true;
    },
    reset() {
      occupied.clear();
    },
  };
}

/** 노드가 현재 보이는 캔버스 영역에 (반지름만큼의 여유를 두고) 걸치는지. */
export function isWithinViewport(
  x: number,
  y: number,
  radius: number,
  bounds: ViewportBounds
): boolean {
  return (
    x + radius >= bounds.x0 &&
    x - radius <= bounds.x1 &&
    y + radius >= bounds.y0 &&
    y - radius <= bounds.y1
  );
}

/** 링크 색 3종을 미리 조립한다 — 페인트 루프는 문자열을 골라 쓰기만 한다. */
export function buildLinkStyle(link: LinkStyleInput): LinkStyle {
  if (link.broken_dependency) {
    return {
      base: BROKEN_DEPENDENCY_COLOR,
      normal: BROKEN_DEPENDENCY_COLOR,
      faded: BROKEN_DEPENDENCY_COLOR,
    };
  }
  const relationColor = link.relation_type
    ? RELATION_COLOR_FALLBACK[link.relation_type]
    : undefined;
  if (relationColor) {
    return {
      base: relationColor,
      normal: withAlpha(relationColor, 0.6),
      faded: withAlpha(relationColor, 0.13),
    };
  }
  return { base: null, normal: "", faded: "" };
}

/**
 * 문서 타입 색을 CSS 변수(--graph-type-<type>)에서 읽고, 비어 있으면
 * TYPE_COLOR_FALLBACK으로 떨어진다 (AGENTS.md §13.2 스타일 토큰화).
 */
export function resolveTypePalette(read: (name: string) => string): Record<string, string> {
  const palette: Record<string, string> = {};
  for (const type of Object.keys(TYPE_COLOR_FALLBACK)) {
    const value = (read(`--graph-type-${type}`) ?? "").trim();
    palette[type] = value || TYPE_COLOR_FALLBACK[type];
  }
  return palette;
}

export interface SeededForceNode extends GraphNode {
  x: number;
  y: number;
  fx?: number;
  fy?: number;
  /** 이 시작 좌표를 만든 서버 좌표 — 다음 재조회 때 "서버 좌표가 바뀌었나" 판단용 */
  __srcX?: number;
  __srcY?: number;
}

/**
 * force 레이아웃의 시작 좌표를 정한다. 사용자가 저장한 노드(서버 pinned)만 fx/fy로
 * 고정하고, 나머지는 서버 ForceAtlas 좌표를 출발점으로만 써서 d3 시뮬레이션이
 * 계속 움직이게 한다. 서버 좌표가 직전과 같은 노드는 직전 프레임 위치를 이어받아
 * 필터·재조회 때 레이아웃이 튀지 않고, 서버 좌표가 바뀐 노드(레이아웃 리셋 등)는
 * 새 좌표에서 다시 출발한다.
 */
export function seedForceNodes(
  nodes: GraphNode[],
  previous: Map<string, { x?: number; y?: number; __srcX?: number; __srcY?: number }>,
  scale: number,
  random: () => number = Math.random
): SeededForceNode[] {
  return nodes.map((n) => {
    const hasPos = typeof n.x === "number" && typeof n.y === "number";
    const src = { __srcX: n.x, __srcY: n.y };
    if (hasPos && n.pinned === true) {
      const x = (n.x as number) * scale;
      const y = (n.y as number) * scale;
      return { ...n, ...src, x, y, fx: x, fy: y };
    }
    const prev = previous.get(n.id);
    if (
      prev &&
      Number.isFinite(prev.x) &&
      Number.isFinite(prev.y) &&
      prev.__srcX === n.x &&
      prev.__srcY === n.y
    ) {
      return { ...n, ...src, x: prev.x as number, y: prev.y as number, fx: undefined, fy: undefined };
    }
    const x = hasPos ? (n.x as number) * scale : (random() - 0.5) * 16;
    const y = hasPos ? (n.y as number) * scale : (random() - 0.5) * 16;
    return { ...n, ...src, x, y, fx: undefined, fy: undefined };
  });
}

/**
 * index_builder가 자동 생성하는 목차 페이지(`content/index`, `content/_index/*`).
 * 같은 타입 문서 전부로 링크를 뻗어 그래프에 바큇살 모양을 만들므로, 선을 흐리고
 * 물리 장력을 약하게 준다. (서버 advice/lint도 같은 규칙으로 목차를 제외한다.)
 */
export function isIndexPage(slug: string): boolean {
  return slug === "content/index" || slug.startsWith("content/_index/");
}

/** 두 #rrggbb 색을 t(0=a, 1=b) 비율로 섞는다. 형식이 다르면 a를 그대로 돌려준다. */
export function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string) => {
    const m = hex.trim().replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  };
  const ca = parse(a);
  const cb = parse(b);
  if (!ca || !cb) return a;
  const mixed = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

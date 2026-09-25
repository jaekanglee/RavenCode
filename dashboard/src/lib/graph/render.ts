/**
 * dashboard/src/lib/graph/render.ts — 그래프 캔버스 렌더 보조 순수 함수.
 *
 * GraphCanvas의 페인트 루프에서 프레임마다 다시 계산되던 연산을 데이터 변경 시
 * 1회 계산으로 끌어내기 위한 모듈이다. 옮겨온 대상:
 *   - 라벨 절단: 노드마다 매 프레임 measureText 이진탐색 → (폰트, 폭, 라벨) 캐시
 *   - 링크 색: 링크마다 매 프레임 정규식 + 문자열 조립 → 데이터 변경 시 1회
 *   - 커뮤니티 라벨: 매 프레임 전 노드 제목 토크나이즈 + 빈도 정렬 → 1회
 *   - 타임라인 좌표/축 눈금: 매 프레임 Math.min(...times) 스프레드 → 1회
 *   - 타임라인 좌표 산출의 O(n^2) find → Map 조회
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

export interface TimelineGridPoint {
  x: number;
  label: string;
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

const TIMELINE_X_START = -450;
const TIMELINE_X_END = 450;

/** 타임라인 뷰에서 문서 타입별 가로 레인의 y 좌표. */
export const TIMELINE_TYPE_LANES: Record<string, number> = {
  concept: 150,
  project: 75,
  rule: 0,
  journal: -75,
  issue: -150,
};
const TIMELINE_TYPE_Y_OTHER = -220;

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

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  return Date.parse(value.trim().substring(0, 10)) || 0;
}

function nodeTimestamp(node: GraphNode, fallback: number): number {
  return parseTimestamp(node.created) || parseTimestamp(node.updated) || fallback;
}

function timelineRange(nodes: GraphNode[], now: number): { minTime: number; maxTime: number } {
  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const time = nodeTimestamp(node, now);
    if (time < minTime) minTime = time;
    if (time > maxTime) maxTime = time;
  }
  return { minTime, maxTime };
}

/**
 * 타임라인 뷰 좌표. 이전 구현은 nodes.forEach 안에서 nodeTimes.find()를 돌려
 * O(n^2)였다 — id → 시각을 Map으로 미리 만들어 O(n)으로 낮췄고, 출력은
 * 입력 순서에만 의존해 결정론을 유지한다.
 */
export function computeTimelineLayout(nodes: GraphNode[]): Record<string, { x: number; y: number }> {
  if (nodes.length === 0) return {};
  const now = Date.now();
  const timeById = new Map<string, number>();
  for (const node of nodes) {
    timeById.set(node.id, nodeTimestamp(node, now));
  }

  const { minTime, maxTime } = timelineRange(nodes, now);
  const timeSpan = maxTime - minTime || 1;
  const isShortRange = maxTime - minTime <= 24 * 60 * 60 * 1000;

  const groupKey = (time: number): string => {
    const d = new Date(time);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    return isShortRange ? `${day} H${d.getHours()}` : day;
  };

  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const key = groupKey(timeById.get(node.id) ?? now);
    const bucket = groups.get(key);
    if (bucket) bucket.push(node.id);
    else groups.set(key, [node.id]);
  }
  const groupIndexById = new Map<string, { index: number; count: number }>();
  for (const bucket of groups.values()) {
    bucket.forEach((id, index) => groupIndexById.set(id, { index, count: bucket.length }));
  }

  const typeIndices = new Map<string, number>();
  const coords: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    const time = timeById.get(node.id) ?? now;
    const baseX =
      TIMELINE_X_START + ((time - minTime) / timeSpan) * (TIMELINE_X_END - TIMELINE_X_START);

    const group = groupIndexById.get(node.id) ?? { index: 0, count: 1 };
    let adaptiveOffsetX = 0;
    if (group.count > 1) {
      const spacing = Math.max(12, Math.min(35, 120 / group.count));
      adaptiveOffsetX = (group.index - (group.count - 1) / 2) * spacing;
    }

    const type = node.type || "other";
    const typeIndex = typeIndices.get(type) ?? 0;
    typeIndices.set(type, typeIndex + 1);
    const baseY = TIMELINE_TYPE_LANES[type] ?? TIMELINE_TYPE_Y_OTHER;
    const offsetSign = typeIndex % 2 === 0 ? 1 : -1;

    coords[node.id] = {
      x: baseX + adaptiveOffsetX,
      y: baseY + offsetSign * (15 + (typeIndex % 3) * 10),
    };
  }
  return coords;
}

/**
 * 타임라인 축 눈금. 이전 구현은 onRenderFramePre 안에서 매 프레임
 * Math.min(...times) 스프레드로 범위를 구하고 격자를 다시 만들었다 —
 * 데이터가 바뀔 때 1회만 계산하도록 끌어냈다.
 */
export function computeTimelineGrid(nodes: GraphNode[]): TimelineGridPoint[] {
  if (nodes.length === 0) return [];
  const now = Date.now();
  const { minTime, maxTime } = timelineRange(nodes, now);
  const timeSpan = maxTime - minTime || 1;
  const toX = (time: number) =>
    TIMELINE_X_START + ((time - minTime) / timeSpan) * (TIMELINE_X_END - TIMELINE_X_START);

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const stepped = (step: number, format: (d: Date) => string): TimelineGridPoint[] => {
    const points: TimelineGridPoint[] = [];
    const start = Math.floor(minTime / step) * step;
    for (let time = start; time <= maxTime + step; time += step) {
      const x = toX(time);
      if (x < TIMELINE_X_START - 10 || x > TIMELINE_X_END + 10) continue;
      points.push({ x, label: format(new Date(time)) });
    }
    return points;
  };

  const span = maxTime - minTime;
  if (span <= 2 * HOUR) {
    return stepped(15 * 60 * 1000, (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`);
  }
  if (span <= DAY) {
    return stepped(2 * HOUR, (d) => `${d.getHours()}:00`);
  }
  if (span <= 7 * DAY) {
    return stepped(DAY, (d) => d.toISOString().split("T")[0].substring(5));
  }
  return Array.from({ length: 5 }, (_unused, index) => {
    const ratio = index / 4;
    return {
      x: TIMELINE_X_START + ratio * (TIMELINE_X_END - TIMELINE_X_START),
      label: new Date(minTime + ratio * timeSpan).toISOString().split("T")[0],
    };
  });
}

/** layered 뷰의 x축 눈금 = 실제로 존재하는 layer 값(정수 버킷) 오름차순. */
export function computeLayeredAxis(nodes: GraphNode[]): number[] {
  const layers = new Set<number>();
  for (const node of nodes) {
    if (typeof node.layer === "number" && Number.isFinite(node.layer)) {
      layers.add(Math.max(0, Math.round(node.layer)));
    }
  }
  return [...layers].sort((a, b) => a - b);
}

const COMMUNITY_LABEL_STOPWORDS = new Set([
  "and", "the", "with", "for", "from", "main", "core", "impl", "test", "helper",
  "util", "utils", "config",
  "이", "그", "저", "및", "등", "을", "를", "의", "에", "과", "와", "한", "로", "으로", "에서",
]);

const WORD_PATTERN = /[a-zA-Z가-힣0-9]{2,20}/g;

/**
 * 커뮤니티별 대표 라벨("Community 3 (Raven & 그래프)"). 이전 구현은
 * onRenderFramePre 안에서 매 프레임 전 노드 제목을 정규식 토크나이즈하고
 * 빈도 정렬까지 했다 — 데이터가 바뀔 때 1회만 계산하도록 끌어냈다.
 */
export function computeCommunityLabels(nodes: GraphNode[]): Map<number, string> {
  const byCommunity = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const community = node.community ?? 0;
    const bucket = byCommunity.get(community);
    if (bucket) bucket.push(node);
    else byCommunity.set(community, [node]);
  }

  const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  const labels = new Map<number, string>();

  for (const [community, members] of byCommunity) {
    let topNode = members[0];
    for (const node of members) {
      if ((node.importance ?? 0) > (topNode.importance ?? 0)) topNode = node;
    }

    const wordCounts = new Map<string, number>();
    for (const node of members) {
      const words = (node.title || "").toLowerCase().match(WORD_PATTERN) ?? [];
      for (const word of words) {
        if (COMMUNITY_LABEL_STOPWORDS.has(word)) continue;
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }
    const sortedWords = [...wordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([word]) => word);

    const topWords = (topNode.title || "").match(WORD_PATTERN) ?? [];
    const mainWord =
      topWords.find((word) => !COMMUNITY_LABEL_STOPWORDS.has(word.toLowerCase())) ??
      topNode.title ??
      "";
    const secondWord = sortedWords.find((word) => word !== mainWord.toLowerCase());

    let suffix = "";
    if (mainWord) {
      suffix = secondWord
        ? ` (${capitalize(mainWord)} & ${capitalize(secondWord)})`
        : ` (${capitalize(mainWord)})`;
    }
    labels.set(community, `Community ${community}${suffix}`);
  }

  return labels;
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

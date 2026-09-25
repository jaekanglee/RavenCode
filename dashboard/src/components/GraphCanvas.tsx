import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph from "force-graph";
import type { GraphNode, GraphEdge } from "../types";
import {
  buildLinkStyle,
  computeCommunityLabels,
  computeLayeredAxis,
  computeTimelineGrid,
  computeTimelineLayout,
  createLabelMetricsCache,
  createLabelOccupancyGrid,
  isIndexPage,
  mixHex,
  isWithinViewport,
  resolveDisplayLabel,
  resolveTypePalette,
  seedForceNodes,
  TIMELINE_TYPE_LANES,
  TYPE_COLOR_FALLBACK,
  withAlpha,
  type LabelMetricsCache,
  type LabelOccupancyGrid,
  type LinkStyle,
  type TimelineGridPoint,
  type ViewportBounds,
} from "../lib/graph/render";

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 중심 깊이/레이어 계산의 기준이 되는 노드 ID. */
  focusNodeId?: string | null;
  /** hover/click 시 선택 노드 메타를 상위 UI에 전달 */
  onNodeInspect?: (node: GraphNode) => void;
  /** single click — 데스크탑 전용 (페이지 이동) */
  onNodeClick?: (slug: string) => void;
  /** double click / double tap — 페이지 이동 */
  onNodeDoubleClick?: (slug: string) => void;
  /** 외부(인사이트 카드 등)에서 하이라이트 요청한 노드 ID */
  externalHighlightNodeId?: string | null;
  /** 현재 문서처럼 항상 강조해야 하는 노드 ID */
  persistentHighlightNodeId?: string | null;
  /** 외부에서 하이라이트 요청한 문서 타입 */
  externalHighlightType?: string | null;
  /** 전체화면 모달 요청 — 상위 컴포넌트가 모달을 열어 처리 */
  onFullscreen?: () => void;
  /** all-vault 등 고밀도 그래프에서는 기본 라벨/엣지를 낮춰 지도 시인성을 우선한다.
   * v0.7.144+: all-scope 모드 제거되어 더 이상 사용처 없음 — 보존 (재사용 가능). */
  density?: "normal" | "dense";
  /** "리셋" 버튼 클릭 시 호출 — 저장된 드래그 좌표를 버리고 서버 원본(ForceAtlas2) 배치로 되돌린다 */
  onResetLayout?: () => void;
  /** 캔버스 빈 공간 클릭 시 호출 */
  onBackgroundClick?: () => void;
  /** 그래프 캔버스의 용도 (기본형 vs 미니맵용) */
  variant?: "default" | "minimap";
  /** 그래프 시각화 레이아웃 모드 (기본 force-directed) */
  layoutMode?: GraphLayoutMode;
  /** B3: 선택 노드로부터 몇 촌까지 강조/유지할지. 기본 3촌. */
  focusDepthLimit?: number;
}

export type GraphLayoutMode = "force" | "concentric" | "domain" | "timeline" | "layered";

// SCHEMA 9종(v0.7.44+) — type별 노드 색상. 미분류/미인식 → default gray.
// AGENTS.md §13.2: 색은 CSS 변수(--graph-type-<type>)를 1차 소스로 쓰고, 변수가
// 정의되지 않은 환경(jsdom 테스트, 구 테마)에서만 TYPE_COLOR_FALLBACK으로 떨어진다.
// 모듈 스코프 변수인 이유: nodeColor()를 Sidebar.tsx가 직접 import해 쓰고 있어
// 호출 계약(type -> color 문자열)을 바꾸지 않고 토큰화하려면 공유 상태가 필요하다.
let activeTypePalette: Record<string, string> = { ...TYPE_COLOR_FALLBACK };
const DEFAULT_COLOR = "#9ca3af";

/** 테마가 확정된 뒤(컨테이너 computed style) 타입 팔레트를 CSS 변수로 갱신한다. */
export function syncTypePalette(read: (name: string) => string): void {
  activeTypePalette = resolveTypePalette(read);
}

export function nodeColor(type: string | undefined): string {
  if (!type) return DEFAULT_COLOR;
  return activeTypePalette[type] ?? DEFAULT_COLOR;
}

/**
 * v0.7.136: dense에서 multiplier 7 → 4, base 10 → 7. 이전 dense 노드는
 * weight=10에서 38px (큰 동그라미 빽빽), hub는 48px로 화면 점유 과다.
 * 사용자 보고: dense 모드 노드가 "두껍다".
 *   - normal: 8 + log2(1+w)*6  (leaf 14, w=10 → 27.93, w=24 → 36.20)
 *   - dense:  7 + log2(1+w)*4  (leaf 11, w=10 → 20.28, w=24 → 25.81)
 */
export function nodeSize(
  weight: number | undefined,
  density: "normal" | "dense" = "normal",
  importance?: number | null,
  totalNodes?: number
): number {
  // 연결 수의 제곱근에 비례하는 작은 점 (Obsidian식) — 허브만 눈에 띄게 커진다.
  const w = Math.max(weight ?? 1, 1);
  const multiplier = density === "dense" ? 1.3 : 1.6;
  const base = density === "dense" ? 2.5 : 3;
  const baseSize = base + Math.sqrt(w) * multiplier;

  if (typeof importance === "number" && typeof totalNodes === "number" && totalNodes > 0) {
    // PageRank 값은 평균 1.0/N 이다.
    // N * PageRank 를 하면 평균이 1.0이 된다.
    const relativeImportance = importance * totalNodes;
    const importanceFactor = Math.max(0.5, Math.min(relativeImportance, 4.0));
    return baseSize * (0.7 + Math.sqrt(importanceFactor) * 0.8);
  }
  return baseSize;
}

const TYPE_LABELS: Record<string, string> = {
  concept: "개념",
  person: "인물",
  tool: "도구",
  comparison: "비교",
  project: "프로젝트",
  rule: "규칙",
  query: "Q&A",
  journal: "일지",
  issue: "이슈",
};

// 관계별 색(RELATION_COLOR_FALLBACK)과 withAlpha는 lib/graph/render.ts로 옮겼다 —
// 링크 스타일을 데이터 변경 시 1회 조립(buildLinkStyle)하면서 페인트 루프에서
// 정규식/문자열 조립이 사라졌다.

const RELATION_DASHES: Record<string, number[]> = {
  uses: [],
  depends_on: [],
  implements: [6, 3],
  implemented_by: [2, 3],
  related: [4, 4],
};

const RELATION_LABELS: Record<string, string> = {
  uses: "Uses (사용함)",
  depends_on: "Depends on (의존함)",
  implements: "Implements (구현함)",
  implemented_by: "Implemented by (구현체)",
  related: "Related (연관)",
};

export function typeLabel(type: string | undefined): string {
  if (!type) return "";
  return TYPE_LABELS[type] ?? "";
}

export function nodeOpacity(freshness: number | null | undefined): number {
  if (typeof freshness !== "number" || Number.isNaN(freshness)) return 1;
  const normalized = Math.max(0, Math.min(freshness, 1));
  return 0.32 + normalized * 0.68;
}

/** B3: 이웃 깊이 슬라이더의 기본값/범위 — GraphPage가 같은 상수를 쓴다. */
export const DEFAULT_FOCUS_DEPTH = 3;
export const MIN_FOCUS_DEPTH = 1;
export const MAX_FOCUS_DEPTH = 6;

export function computeFocusDepthMap(
  nodes: GraphNode[],
  edges: GraphEdge[],
  focusNodeId?: string | null,
  maxDepth = DEFAULT_FOCUS_DEPTH
): Map<string, number> {
  const focusId = focusNodeId?.trim();
  if (!focusId) return new Map();
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (!nodeIds.has(focusId)) return new Map();

  const adjacency = new Map<string, Set<string>>();
  const addEdge = (source: string, target: string) => {
    if (!nodeIds.has(source) || !nodeIds.has(target)) return;
    if (!adjacency.has(source)) adjacency.set(source, new Set());
    if (!adjacency.has(target)) adjacency.set(target, new Set());
    adjacency.get(source)?.add(target);
    adjacency.get(target)?.add(source);
  };

  for (const edge of edges) {
    addEdge(String(edge.source), String(edge.target));
  }

  const depthMap = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [{ id: focusId, depth: 0 }];
  depthMap.set(focusId, 0);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) continue;
    const neighbors = adjacency.get(current.id);
    if (!neighbors) continue;
    for (const nextId of neighbors) {
      if (depthMap.has(nextId)) continue;
      const nextDepth = current.depth + 1;
      depthMap.set(nextId, nextDepth);
      queue.push({ id: nextId, depth: nextDepth });
    }
  }

  return depthMap;
}

export function computeLayeredLayout(nodes: GraphNode[]): Record<string, { x: number; y: number }> {
  const layers = new Map<number, GraphNode[]>();
  let minLayer = Number.POSITIVE_INFINITY;
  let maxLayer = Number.NEGATIVE_INFINITY;

  nodes.forEach((node) => {
    const layerValue = typeof node.layer === "number" && Number.isFinite(node.layer)
      ? node.layer
      : 0;
    const bucket = Math.max(0, Math.round(layerValue));
    minLayer = Math.min(minLayer, bucket);
    maxLayer = Math.max(maxLayer, bucket);
    const group = layers.get(bucket) ?? [];
    group.push(node);
    layers.set(bucket, group);
  });

  if (!Number.isFinite(minLayer) || !Number.isFinite(maxLayer)) {
    return {};
  }

  const xStart = -430;
  const xEnd = 430;
  const layerSpan = Math.max(1, maxLayer - minLayer);
  const layerCoords: Record<string, { x: number; y: number }> = {};

  [...layers.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([layer, group]) => {
      const ratio = (layer - minLayer) / layerSpan;
      const x = xStart + ratio * (xEnd - xStart);
      const sortedGroup = [...group].sort((a, b) => {
        const importanceDiff = (b.importance ?? 0) - (a.importance ?? 0);
        if (importanceDiff !== 0) return importanceDiff;
        return a.id.localeCompare(b.id);
      });
      const count = sortedGroup.length;
      const spacing = Math.min(90, Math.max(42, 340 / Math.max(1, count)));

      sortedGroup.forEach((node, idx) => {
        const offsetIndex = idx - (count - 1) / 2;
        const curvature = count > 1 ? Math.sin((idx / Math.max(1, count - 1)) * Math.PI) : 0;
        layerCoords[node.id] = {
          x,
          y: offsetIndex * spacing + curvature * 18,
        };
      });
    });

  return layerCoords;
}

const isJSDOM =
  typeof window !== "undefined" &&
  (window.navigator.userAgent.includes("jsdom") ||
    window.navigator.userAgent.includes("Node.js"));

// 서버 ForceAtlas 좌표 → 캔버스 좌표 배율. 아래 d3 힘의 평형 간격과 비슷하게 맞춰
// 두어야 첫 로드 때 레이아웃이 폭발/수축하지 않고 제자리에서 자리만 잡는다.
const GRAPH_SCALE_MULTIPLIER = 0.8;
const FORCE_GRAVITY = 0.03;
const FORCE_CHARGE = -200;
const FORCE_CHARGE_DISTANCE_MAX = 800;
const FORCE_LINK_DISTANCE = 40;
// d3 기본값(1/min(양 끝 연결 수))은 촘촘한 vault에서 링크 하나가 1/20 힘밖에 못 내
// 드래그해도 이웃이 안 따라오고 선만 늘어난다. Obsidian처럼 링크마다 같은 장력을 준다.
const FORCE_LINK_STRENGTH = 0.5;
// 목차 페이지 링크는 약하게 당긴다 — 목차 하나가 수십 개 문서를 한 점으로 끌어모아
// 바큇살 모양을 만드는 것을 막되, 목차에만 걸린 문서(저널 등)가 멀리 흩어지지 않을
// 만큼은 남긴다 (0.03은 흩어지고 0.5는 다시 뭉쳤다).
const FORCE_INDEX_LINK_STRENGTH = 0.2;
const LABEL_ALL_ZOOM = 2.5;
const SETTLED_FIT_DELAY_MS = 1500;
const HUB_TOP_RATIO = 0.04;
const HUB_MIN_DEGREE = 6;
// 허브가 아닌 점은 타입 색을 이 중립색 쪽으로 섞어 차분하게 둔다 (허브만 원색 + glow).
const NODE_MUTE_RATIO = 0.5;
const DIRECT_CLICK_PADDING_PX = 0;
const DIRECT_MOUSE_HIT_RADIUS_PX = 0;
const DIRECT_TOUCH_HIT_RADIUS_PX = 0;
const DIRECT_HIT_NODE_RADIUS_MULTIPLIER = 1;
const DIRECT_MOUSE_MOVE_TOLERANCE_PX = 8;
const DIRECT_TOUCH_MOVE_TOLERANCE_PX = 14;
const DOUBLE_CLICK_DELAY_MS = 200;

interface CanvasPoint {
  x: number;
  y: number;
}

interface HitTestNode {
  id: string;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
  weight?: number;
  importance?: number;
}

export function isStationaryClickGesture(
  start: CanvasPoint | null,
  end: CanvasPoint,
  pointerType: "mouse" | "touch"
): boolean {
  if (!start) return true;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const tolerance = pointerType === "touch"
    ? DIRECT_TOUCH_MOVE_TOLERANCE_PX
    : DIRECT_MOUSE_MOVE_TOLERANCE_PX;
  return Math.hypot(dx, dy) <= tolerance;
}

export function findClosestNodeHit<T extends HitTestNode>(
  nodes: T[],
  point: CanvasPoint,
  density: "normal" | "dense",
  padding = DIRECT_CLICK_PADDING_PX,
  scale = 1,
  minScreenRadius = DIRECT_MOUSE_HIT_RADIUS_PX
): T | null {
  let closest: T | null = null;
  let closestDistSq = Number.POSITIVE_INFINITY;

  const safeScale = typeof scale === "number" && scale > 0 ? scale : 1;
  const minCanvasRadius = Math.max(minScreenRadius, 0) / safeScale;

  for (const node of nodes) {
    const x = typeof node.x === "number" ? node.x : node.fx;
    const y = typeof node.y === "number" ? node.y : node.fy;
    if (typeof x !== "number" || typeof y !== "number") continue;
    const dx = point.x - x;
    const dy = point.y - y;
    const distSq = dx * dx + dy * dy;
    const visualRadius = nodeSize(node.weight, density, node.importance, nodes.length) * DIRECT_HIT_NODE_RADIUS_MULTIPLIER;
    const radius = Math.max(visualRadius + padding / safeScale, minCanvasRadius);
    if (distSq > radius * radius) continue;
    if (distSq < closestDistSq) {
      closest = node;
      closestDistSq = distSq;
    }
  }

  return closest;
}

export function shouldShowLabel(
  node: { type?: string; weight?: number },
  scale: number,
  isDense: boolean,
  isFocused: boolean,
  isHighlighted: boolean
): boolean {
  if (isFocused || isHighlighted) return true;
  if (scale < 0.7) return false;
  // 충분히 확대하면 모든 라벨을 보여준다 — 겹침은 라벨 점유 격자가 걸러낸다.
  if (scale >= LABEL_ALL_ZOOM) return true;

  const isIssue = node.type === "issue";
  if (isDense) {
    return (
      (scale > 1.15 && (node.weight ?? 0) >= 3) ||
      (isIssue && scale > 1.15)
    );
  } else {
    return (
      (scale > 1.0 && (node.weight ?? 0) >= 3) ||
      (node.weight ?? 0) >= 8 ||
      (isIssue && scale > 1.0)
    );
  }
}

// v0.7.134+ (v0.7.144에서 resolveVaultColor 헬퍼와 함께 VAULT_HALO_COLORS 제거 —
// all-scope 모드 제거되면서 vault 색 식별 코드 사용처 사라짐).
// hexToRgba는 보존 (다른 ring 효과 재사용 가능).
function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// rounded-rect 헬퍼 제거 — v0.7.139+: onRenderFramePre에서 그리던 vault halo 박스를
// 삭제하면서 호출처가 사라졌다. 향후 다른 캔버스 도형이 필요하면 재도입.



// Louvain community id별 구획 색 — 구조적 다양성 팔레트(AGENTS.md §13.2 예외).
// GraphCanvas onRenderFramePre의 domain 뷰 구획(원)과 대표 라벨에 쓰인다.
// CSS 변수 --graph-community-0..9가 있으면 그 값이 우선한다.
const COMMUNITY_COLOR_FALLBACK = [
  "#3b82f6", "#ef4444", "#a855f7", "#10b981", "#f59e0b",
  "#ec4899", "#14b8a6", "#6366f1", "#8b5cf6", "#f97316",
];
const GRAPH_LABEL_FONT = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const HUD_LABEL_FONT = GRAPH_LABEL_FONT;
const HUD_LABEL_BASE_SIZE = 17; // 더 크게 (14 -> 17)
const NODE_LABEL_BASE_SIZE = 11.4;

// 라벨 충돌 격자 한 칸의 크기(캔버스 좌표). 작을수록 촘촘하게 허용한다.
const LABEL_GRID_CELL_PX = 8;

const NODE_LABEL_MAX_WIDTH_PX = 90; // 화면 픽셀 기준 — fontSize와 동일하게 scale로 나눠 apparent 크기 고정.

// 라벨 절단 로직은 lib/graph/render.ts로 옮겼다 (프레임 캐시와 한 곳에 두기 위함).
// 기존 import 경로(components/GraphCanvas)를 쓰는 호출부/테스트를 위해 re-export.
export { truncateLabel } from "../lib/graph/render";

export function GraphCanvas({
  nodes,
  edges,
  focusNodeId,
  onNodeInspect,
  onNodeClick,
  onNodeDoubleClick,
  externalHighlightNodeId,
  persistentHighlightNodeId,
  externalHighlightType,
  onFullscreen,
  density = "normal",
  onResetLayout,
  onBackgroundClick,
  variant = "default",
  layoutMode = "force",
  focusDepthLimit = DEFAULT_FOCUS_DEPTH,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphInstanceRef = useRef<any>(null);
  const isDense = density === "dense";
  // v0.7.139+: fitView 트리거 추적. scope 전환(all ↔ current) 또는 첫 데이터 로드 시에만
  // 호출하기 위해 직전 isDense와 노드 수를 보관. 검색/필터로 nodes가 바뀌어도
  // 사용자의 pan/zoom 위치가 reset되지 않는다.
  const prevIsDenseRef = useRef<boolean | null>(null);
  const prevNodeCountRef = useRef<number>(0);
  // 첫 데이터 로드의 지연 zoomToFit이 사용자의 첫 클릭 뒤에 실행되면
  // detail 패널 리사이즈와 겹쳐 카메라를 다시 맞춘다. 예약 timer를 취소한다.
  const initialFitTimerRef = useRef<number | null>(null);
  const initialFitCancelledRef = useRef(false);
  const graphNodesRef = useRef<any[]>([]);
  // 직전 graphData가 force 배치였는지 — 다른 모드의 fx/fy를 드래그 고정으로 오인하지 않게 한다.
  const lastSeededModeRef = useRef<GraphLayoutMode | null>(null);
  const pressStartRef = useRef<{ point: CanvasPoint; pointerType: "mouse" | "touch" } | null>(null);
  const pendingClickRef = useRef<{ nodeId: string; timeoutId: number; startedAt: number } | null>(null);
  const clickHandlersRef = useRef({
    onNodeClick,
    onNodeDoubleClick,
    onBackgroundClick,
  });

  const [hoveredNode, setHoveredNodeState] = useState<any>(null);
  // v0.7.139+: 현재 zoom 배율 (force-graph의 zoom() 값). onZoom 콜백에서 갱신.
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  // v0.7.139+: hoveredNode를 ref로도 미러링. force-graph의 linkColor/linkWidth/
  // nodeCanvasObject는 effect 등록 시점의 클로저를 매 paint call에서 호출하므로,
  // 매번 최신 hover 상태를 보려면 ref가 필요. ref 덕분에 hoveredNode 변경 시
  // effect가 재실행되지 않아 — 캔버스가 pan/zoom 위치를 잃지 않고, 클릭이 무효화되지 않음.
  const hoveredNodeRef = useRef<any>(null);
  const setHoveredNode = (node: any) => {
    hoveredNodeRef.current = node;
    setHoveredNodeState(node);
  };

  // A4: 페인트 루프가 읽는 사전 계산 결과 — 데이터/레이아웃 변경 시 1회 갱신.
  const labelMetricsCacheRef = useRef<LabelMetricsCache>(createLabelMetricsCache());
  const labelGridRef = useRef<LabelOccupancyGrid>(createLabelOccupancyGrid(LABEL_GRID_CELL_PX));
  const viewportRef = useRef<ViewportBounds | null>(null);
  const communityLabelsRef = useRef<Map<number, string>>(new Map());
  const communityPaletteRef = useRef<string[]>(COMMUNITY_COLOR_FALLBACK);
  const timelineGridRef = useRef<TimelineGridPoint[]>([]);
  const layeredAxisRef = useRef<number[]>([]);
  // A3: 하이라이트 3종은 ref로 읽는다 — 클릭/호버가 데이터 동기화 effect를
  // 재실행하지 않게 해서 graphData() 재설정과 d3 리히트를 막는다.
  // 포커스 깊이 맵도 ref로 읽는다 — 깊이 슬라이더(B3)와 선택 변경이 데이터
  // 동기화 effect를 재실행하지 않고도 즉시 반영되어야 한다.
  const focusDepthMapRef = useRef<Map<string, number>>(new Map());
  const externalHighlightIdRef = useRef<string | null | undefined>(externalHighlightNodeId);
  const persistentHighlightIdRef = useRef<string | null | undefined>(persistentHighlightNodeId);
  const externalHighlightTypeRef = useRef<string | null | undefined>(externalHighlightType);

  /** 데이터를 다시 넣지 않고 다음 프레임만 다시 그리도록 force-graph에 알린다. */
  const requestRepaint = () => {
    const graph = graphInstanceRef.current;
    if (!graph || typeof graph.nodeRelSize !== "function") return;
    graph.nodeRelSize(graph.nodeRelSize());
  };

  const resolvedLabelColorRef = useRef<string>("rgba(148, 163, 184, 0.7)");
  const resolvedBgColorRef = useRef<string>("#0f172a");
  const resolvedNodeOutlineRef = useRef<string>("rgba(226, 232, 240, 0.28)");
  const resolvedEdgeColorRef = useRef<string>("rgba(148, 163, 184, 0.38)");
  const resolvedEdgeHighlightRef = useRef<string>("rgba(196, 181, 253, 0.94)");
  const resolvedEdgeFadedRef = useRef<string>("rgba(148, 163, 184, 0.04)");
  const resolvedEdgeIndexRef = useRef<string>("rgba(148, 163, 184, 0.05)");
  const resolvedNodeNeutralRef = useRef<string>("#64748b");
  const focusDepthMap = useMemo(
    () => computeFocusDepthMap(nodes, edges, focusNodeId, focusDepthLimit),
    [nodes, edges, focusNodeId, focusDepthLimit]
  );

  // concentric 뷰에서만 선택 노드가 좌표 재산출을 유발한다 (A3 deps 참조).
  const concentricCenterDep =
    layoutMode === "concentric"
      ? (externalHighlightNodeId ?? persistentHighlightNodeId ?? null)
      : null;

  // DOM Container 변경 및 테마 변경 시 Computed Style 캐싱
  useEffect(() => {
    if (isJSDOM || !containerRef.current) return;
    try {
      const style = window.getComputedStyle(containerRef.current);
      resolvedLabelColorRef.current = style.getPropertyValue("--graph-label-color").trim() || "rgba(148, 163, 184, 0.7)";
      resolvedBgColorRef.current = style.getPropertyValue("--graph-canvas-bg").trim() || "#0f172a";
      resolvedNodeOutlineRef.current = style.getPropertyValue("--graph-node-outline").trim() || "rgba(226, 232, 240, 0.28)";
      resolvedEdgeColorRef.current = style.getPropertyValue("--graph-edge").trim() || "rgba(148, 163, 184, 0.38)";
      resolvedEdgeHighlightRef.current = style.getPropertyValue("--graph-edge-highlight").trim() || "rgba(196, 181, 253, 0.94)";
      // 포커스 중 물러나는 엣지 색도 1회 조립 — 이전에는 링크마다 매 프레임
      // withAlpha(정규식)를 호출했다.
      resolvedEdgeFadedRef.current = withAlpha(resolvedEdgeColorRef.current, 0.06);
      resolvedEdgeIndexRef.current = withAlpha(resolvedEdgeColorRef.current, 0.04);
      resolvedNodeNeutralRef.current = style.getPropertyValue("--graph-node-neutral").trim() || "#64748b";
      // B2: 문서 타입 색과 커뮤니티 구획 색을 CSS 변수에서 해석 (없으면 fallback).
      const readVar = (name: string) => style.getPropertyValue(name);
      syncTypePalette(readVar);
      communityPaletteRef.current = COMMUNITY_COLOR_FALLBACK.map(
        (fallback, index) => readVar(`--graph-community-${index}`).trim() || fallback
      );
    } catch (e) {
      // fallback
    }
  }, [nodes]);

  useEffect(() => {
    clickHandlersRef.current = { onNodeClick, onNodeDoubleClick, onBackgroundClick };
  }, [onNodeClick, onNodeDoubleClick, onBackgroundClick]);

  useEffect(() => {
    return () => {
      if (pendingClickRef.current) {
        window.clearTimeout(pendingClickRef.current.timeoutId);
        pendingClickRef.current = null;
      }
    };
  }, []);

  // 1. 하이라이트 및 인접 관계 집합 계산 (ref 기반 — effect deps 안 들어감)
  const highlightNodesRef = useRef<Set<string>>(new Set());
  const highlightLinksRef = useRef<Set<string>>(new Set());

  // v0.7.144+: all-scope 제거 — vault centroids + 최상단 y ref 모두 불필요.
  // (참조하던 코드: vaultCentroidsRef, vaultTopYRef, drawVaultLabel)

  /** 포커스(선택/호버/타입 강조)가 걸린 상태인지 — 페인트 루프에서 ref로만 읽는다. */
  const isFocusActive = (): boolean =>
    !!(externalHighlightIdRef.current || externalHighlightTypeRef.current);

  const recomputeHighlights = (hover: any, extId: string | null | undefined, edgeList: typeof edges) => {
    const nodeSet = new Set<string>();
    const linkSet = new Set<string>();
    if (hover) {
      nodeSet.add(hover.id);
      edgeList.forEach((e) => {
        if (e.source === hover.id) nodeSet.add(e.target);
        if (e.target === hover.id) nodeSet.add(e.source);
      });
    }
    if (extId) {
      nodeSet.add(extId);
      edgeList.forEach((e) => {
        if (e.source === extId) nodeSet.add(e.target);
        if (e.target === extId) nodeSet.add(e.source);
      });
    }
    edgeList.forEach((e, idx) => {
      const id = `e${idx}`;
      if (hover && (e.source === hover.id || e.target === hover.id)) linkSet.add(id);
      if (extId && (e.source === extId || e.target === extId)) linkSet.add(id);
    });
    highlightNodesRef.current = nodeSet;
    highlightLinksRef.current = linkSet;
  };

  /**
   * A3: 하이라이트 전용 동기화. 노드 클릭/사이드바 호버는 여기서 ref와 하이라이트
   * 집합만 갱신하고 캔버스 재페인트를 요청한다 — 데이터 동기화 effect(graphData
   * 재설정 + d3 리히트 + accessor 재바인딩)를 건드리지 않는다.
   *
   * nodeRelSize를 현재 값으로 다시 넣는 것이 force-graph의 공식 재페인트 신호다
   * (해당 prop은 triggerUpdate:false + onChange:notifyRedraw로 선언돼 있어 데이터
   * 갱신 없이 다음 프레임만 다시 그린다).
   */
  useEffect(() => {
    focusDepthMapRef.current = focusDepthMap;
    requestRepaint();
  }, [focusDepthMap]);

  useEffect(() => {
    externalHighlightIdRef.current = externalHighlightNodeId;
    persistentHighlightIdRef.current = persistentHighlightNodeId;
    externalHighlightTypeRef.current = externalHighlightType;
    recomputeHighlights(hoveredNodeRef.current, externalHighlightNodeId, edges);
    requestRepaint();
  }, [externalHighlightNodeId, persistentHighlightNodeId, externalHighlightType, edges]);

  // (v0.7.139+: 이동 모드 토글 제거 — force-graph native pan/zoom이 항상 동작한다.
  // Space 단축키 핸들러도 함께 제거됨. dense 모드에서도 노드 탭 → 인사이트,
  // 더블탭 → 페이지 이동, 드래그 → 캔버스 팬으로 통일.)

  // 2. force-graph 인스턴스 초기 생성 (런타임 callable 우회를 위해 캐스팅 및 default export 감지 방어 적용)
  useEffect(() => {
    if (isJSDOM || !containerRef.current) return;

    const ForceGraphConstructor = typeof ForceGraph === "function"
      ? ForceGraph
      : (ForceGraph as any).default || ForceGraph;

    if (typeof ForceGraphConstructor !== "function") {
      console.error("ForceGraph is not a function! Check import:", ForceGraph);
      return;
    }

    const graph = (ForceGraphConstructor as any)()(containerRef.current);
    graphInstanceRef.current = graph;
    // 새 인스턴스는 카메라를 한 번도 맞춘 적이 없다 — 첫 데이터를 다시 "첫 로드"로 보게 한다.
    // (StrictMode dev 재마운트에서 ref만 살아남아 초기 맞춤이 영영 건너뛰어지던 문제)
    prevNodeCountRef.current = 0;

    // v0.7.149+: D3 center force를 제거하여 force-graph가 렌더 틱마다 중심을 (width/2, height/2)로
    // 강제 덮어쓰고 우측 하단으로 노드들을 끌어당기는 현상을 원천 차단.
    // charge 및 link 힘은 살려두어, 좌표가 고정되지 않은 신규 노드들이 겹치지 않고 흩어지도록 구성.
    graph.d3Force("center", null);
    // 살아 있는 물리 (Obsidian식): 원점으로 당기는 약한 중력 + 반발 + 링크 장력.
    // center force와 달리 중력은 노드마다 원점 쪽 속도만 더하므로 화면 쏠림이 없고,
    // 떨어진 섬들이 멀리 도망가지 않고 은하처럼 모인다.
    let gravityNodes: any[] = [];
    const gravity = Object.assign(
      (alpha: number) => {
        for (const n of gravityNodes) {
          n.vx -= n.x * FORCE_GRAVITY * alpha;
          n.vy -= n.y * FORCE_GRAVITY * alpha;
        }
      },
      { initialize: (ns: any[]) => { gravityNodes = ns; } }
    );
    graph.d3Force("gravity", gravity);
    // d3 link force는 연결 수가 적은 쪽 끝을 더 많이 움직여 운동량이 보존되지 않는다.
    // 링크 장력을 균일하게 올리면 그 치우침이 쌓여 그래프 전체가 한쪽으로 흘러가므로,
    // d3.forceCenter처럼 매 tick 무게중심을 원점으로 되돌린다 (고정 노드는 제외).
    let recenterNodes: any[] = [];
    const recenter = Object.assign(
      () => {
        if (recenterNodes.length === 0) return;
        let mx = 0;
        let my = 0;
        for (const n of recenterNodes) {
          mx += n.x;
          my += n.y;
        }
        mx /= recenterNodes.length;
        my /= recenterNodes.length;
        for (const n of recenterNodes) {
          if (n.fx != null) continue;
          n.x -= mx;
          n.y -= my;
        }
      },
      { initialize: (ns: any[]) => { recenterNodes = ns; } }
    );
    graph.d3Force("recenter", recenter);
    graph.d3Force("charge")?.strength(FORCE_CHARGE).distanceMax(FORCE_CHARGE_DISTANCE_MAX);
    graph
      .d3Force("link")
      ?.distance(FORCE_LINK_DISTANCE)
      .strength((l: any) => (l.__index ? FORCE_INDEX_LINK_STRENGTH : FORCE_LINK_STRENGTH));
    // 낮은 감쇠 = 드래그하면 이웃이 출렁이며 따라오는 관성. 몇 초에 걸쳐 가라앉는다.
    graph.d3VelocityDecay(0.3);
    graph.cooldownTime(8000);

    // 인터랙션 기본 설정
    graph.enableZoomInteraction(true);
    graph.enablePanInteraction(true);

    // v0.7.150+: ResizeObserver로 캔버스 크기 변화를 실시간 반영하여 우하단 쏠림 및 잘림 현상 방지
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          // Opening the detail panel changes the canvas width. Preserve the user's
          // camera when force-graph reconfigures its viewport; otherwise selection
          // unexpectedly zooms out and recenters the graph.
          const cameraCenter = graph.centerAt();
          const cameraZoom = graph.zoom();
          graph.width(width).height(height);
          graph.centerAt(cameraCenter.x, cameraCenter.y, 0);
          graph.zoom(cameraZoom, 0);
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      if (initialFitTimerRef.current !== null) {
        window.clearTimeout(initialFitTimerRef.current);
        initialFitTimerRef.current = null;
      }
      resizeObserver.disconnect();
      if (graphInstanceRef.current) {
        graphInstanceRef.current._destructor?.();
      }
    };
  }, []);

  // 3. Props 및 인터랙션 상태 변경 시 그래프 동기화
  useEffect(() => {
    if (isJSDOM) return;
    const graph = graphInstanceRef.current;
    if (!graph) return;

    // layoutMode에 따라 노드 배치 좌표를 실시간 산출
    let formattedNodes: any[] = [];

    if (layoutMode === "force") {
      // 저장된 노드만 고정하고 나머지는 살아 있는 시뮬레이션에 맡긴다 (Obsidian식).
      const previous = new Map<string, any>(
        lastSeededModeRef.current === "force"
          ? graphNodesRef.current.map((n) => [n.id, n])
          : []
      );
      formattedNodes = seedForceNodes(nodes, previous, GRAPH_SCALE_MULTIPLIER);
    } else if (layoutMode === "concentric") {
      // 1) Concentric View: 특정 노드(또는 중요도가 가장 높은 노드)를 중심으로 N촌 동심원 배치
      const centerId =
        externalHighlightNodeId && nodes.some(n => n.id === externalHighlightNodeId)
          ? externalHighlightNodeId
          : (persistentHighlightNodeId && nodes.some(n => n.id === persistentHighlightNodeId)
            ? persistentHighlightNodeId
            : (nodes.length > 0
              ? [...nodes].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0].id
              : ""));

      // Adjacency 빌드 (무방향)
      const adj: Record<string, string[]> = {};
      nodes.forEach(n => { adj[n.id] = []; });
      edges.forEach(e => {
        const u = typeof e.source === "object" ? (e.source as any).id : e.source;
        const v = typeof e.target === "object" ? (e.target as any).id : e.target;
        if (adj[u] && adj[v]) {
          if (!adj[u].includes(v)) adj[u].push(v);
          if (!adj[v].includes(u)) adj[v].push(u);
        }
      });

      // BFS 최단거리 계산
      const dists: Record<string, number> = {};
      nodes.forEach(n => { dists[n.id] = 999999; });

      if (centerId && adj[centerId]) {
        dists[centerId] = 0;
        const queue = [centerId];
        let head = 0;
        while (head < queue.length) {
          const u = queue[head++];
          const currentDist = dists[u];
          for (const v of adj[u]) {
            if (dists[v] === 999999) {
              dists[v] = currentDist + 1;
              queue.push(v);
            }
          }
        }
      }

      // 거리 그룹화
      const distanceGroups: Record<number, string[]> = {};
      nodes.forEach(n => {
        const d = dists[n.id];
        distanceGroups[d] ??= [];
        distanceGroups[d].push(n.id);
      });

      const nodeCoords: Record<string, { x: number; y: number }> = {};
      if (centerId) {
        nodeCoords[centerId] = { x: 0, y: 0 };
      }

      const sortedDistances = Object.keys(distanceGroups)
        .map(Number)
        .filter(d => d > 0 && d !== 999999)
        .sort((a, b) => a - b);

      sortedDistances.forEach((d) => {
        const group = distanceGroups[d];
        const count = group.length;
        const radius = d * 180;
        group.forEach((nodeId, idx) => {
          const theta = (2 * Math.PI * idx) / count;
          nodeCoords[nodeId] = {
            x: radius * Math.cos(theta),
            y: radius * Math.sin(theta),
          };
        });
      });

      const disconnected = distanceGroups[999999] || [];
      if (disconnected.length > 0) {
        const maxD = sortedDistances.length > 0 ? sortedDistances[sortedDistances.length - 1] : 0;
        const radius = (maxD + 1.2) * 190;
        disconnected.forEach((nodeId, idx) => {
          const theta = (2 * Math.PI * idx) / disconnected.length;
          nodeCoords[nodeId] = {
            x: radius * Math.cos(theta),
            y: radius * Math.sin(theta),
          };
        });
      }

      formattedNodes = nodes.map((n) => {
        const coord = nodeCoords[n.id] || { x: 0, y: 0 };
        return {
          ...n,
          x: coord.x,
          y: coord.y,
          fx: coord.x,
          fy: coord.y,
        };
      });
    } else if (layoutMode === "domain") {
      // 2) Domain View: Louvain community ID별 노드 분산 배치
      const communities: Record<number, string[]> = {};
      nodes.forEach((n) => {
        const c = n.community ?? 0;
        communities[c] ??= [];
        communities[c].push(n.id);
      });

      const communityIds = Object.keys(communities).map(Number).sort((a, b) => a - b);
      const K = communityIds.length;

      const centerCoords: Record<number, { x: number; y: number }> = {};
      if (K <= 1) {
        centerCoords[communityIds[0] ?? 0] = { x: 0, y: 0 };
      } else {
        const ringRadius = Math.max(300, K * 75);
        communityIds.forEach((cid, idx) => {
          const theta = (2 * Math.PI * idx) / K;
          centerCoords[cid] = {
            x: ringRadius * Math.cos(theta),
            y: ringRadius * Math.sin(theta),
          };
        });
      }

      const nodeCoords: Record<string, { x: number; y: number }> = {};
      communityIds.forEach((cid) => {
        const group = communities[cid];
        const count = group.length;
        const center = centerCoords[cid];
        const clusterRadius = 45 + Math.sqrt(count) * 15;

        group.forEach((nodeId, idx) => {
          if (count === 1) {
            nodeCoords[nodeId] = { x: center.x, y: center.y };
          } else {
            const theta = (2 * Math.PI * idx) / count;
            nodeCoords[nodeId] = {
              x: center.x + clusterRadius * Math.cos(theta),
              y: center.y + clusterRadius * Math.sin(theta),
            };
          }
        });
      });

      formattedNodes = nodes.map((n) => {
        const coord = nodeCoords[n.id] || { x: 0, y: 0 };
        return {
          ...n,
          x: coord.x,
          y: coord.y,
          fx: coord.x,
          fy: coord.y,
        };
      });
    } else if (layoutMode === "timeline") {
      // 3) Timeline View: 작성일/수정일 기준 가로 축 정렬 배치.
      // 좌표 산출은 lib/graph/render.ts의 computeTimelineLayout으로 옮겼다 —
      // 이전 구현은 nodes.forEach 안에서 nodeTimes.find()를 돌려 O(n^2)였다.
      const nodeCoords = computeTimelineLayout(nodes);
      formattedNodes = nodes.map((n) => {
        const coord = nodeCoords[n.id] || { x: 0, y: 0 };
        return {
          ...n,
          x: coord.x,
          y: coord.y,
          fx: coord.x,
          fy: coord.y,
        };
      });
    } else if (layoutMode === "layered") {
      // 4) Layered View: 분석된 layer 값을 가로축 깊이로 사용.
      // Concentric가 "선택 중심으로부터의 거리"라면, layered는
      // "그래프 전체에서 계산된 논리적 깊이"를 보여주는 별도 분석 뷰다.
      const nodeCoords = computeLayeredLayout(nodes);
      formattedNodes = nodes.map((n) => {
        const coord = nodeCoords[n.id] || { x: 0, y: 0 };
        return {
          ...n,
          x: coord.x,
          y: coord.y,
          fx: coord.x,
          fy: coord.y,
        };
      });
    }

    // 링크 스타일(색 3종/점선/화살표 길이)은 여기서 1회 조립해 링크 객체에 붙인다.
    // force-graph의 accessor는 매 프레임 링크마다 호출되므로, 여기서 미리 만들어
    // 두지 않으면 정규식과 문자열 조립이 프레임당 E번 반복된다.
    // 끝점이 노드 목록에 없는 edge가 하나라도 있으면 force-graph가 "node not found"로
    // 링크 전체를 버린다 (전체보기 모달에서 선이 사라지고 물리가 덩어리로 뭉침).
    // id(e<원래 인덱스>)는 하이라이트 계산과 맞물리므로 부여한 뒤에 거른다.
    const nodeIds = new Set(nodes.map((n) => n.id));
    const slugById = new Map(nodes.map((n) => [n.id, n.slug ?? n.id]));
    const formattedLinks = edges.map((e, idx) => {
      const relationType = e.relation_type;
      const arrowRelation =
        relationType === "uses" ||
        relationType === "depends_on" ||
        relationType === "implements" ||
        relationType === "implemented_by";
      return {
        ...e,
        id: `e${idx}`,
        source: e.source,
        target: e.target,
        __style: buildLinkStyle(e as never),
        __dash: relationType ? RELATION_DASHES[relationType] ?? [] : [],
        __arrowLength: arrowRelation ? 5.5 : 0,
        __index:
          isIndexPage(slugById.get(String(e.source)) ?? String(e.source)) ||
          isIndexPage(slugById.get(String(e.target)) ?? String(e.target)),
      };
    }).filter((l) => nodeIds.has(String(l.source)) && nodeIds.has(String(l.target)));

    // 별자리 대비: 목차 링크를 뺀 실제 연결 수로 허브(상위 ~4%)를 골라 은은하게 빛낸다.
    const degree = new Map<string, number>();
    for (const l of formattedLinks) {
      if (l.__index) continue;
      for (const end of [String(l.source), String(l.target)]) degree.set(end, (degree.get(end) ?? 0) + 1);
    }
    const sortedDegrees = [...degree.values()].sort((a, b) => b - a);
    const hubThreshold = Math.max(HUB_MIN_DEGREE, sortedDegrees[Math.floor(sortedDegrees.length * HUB_TOP_RATIO)] ?? 0);
    for (const n of formattedNodes) {
      n.__index = isIndexPage(n.slug ?? n.id);
      n.__hub = !n.__index && (degree.get(n.id) ?? 0) >= hubThreshold;
    }

    graph.graphData({ nodes: formattedNodes, links: formattedLinks });
    graphNodesRef.current = formattedNodes;
    lastSeededModeRef.current = layoutMode;

    // A4: 페인트 루프가 프레임마다 다시 계산하던 것들을 여기서 1회 계산한다.
    communityLabelsRef.current = layoutMode === "domain" ? computeCommunityLabels(nodes) : new Map();
    timelineGridRef.current = layoutMode === "timeline" ? computeTimelineGrid(nodes) : [];
    layeredAxisRef.current = layoutMode === "layered" ? computeLayeredAxis(nodes) : [];
    // 라벨 문자열 캐시는 노드 집합이 바뀌면 버린다 (제목 변경 반영).
    labelMetricsCacheRef.current = createLabelMetricsCache();

    // v0.7.144+: all-scope 제거 — vault별 최상단 y 계산 불필요.

    // v0.7.139+: 데이터 변경 시점에 highlight ref를 미리 계산. hover 중에는
    // setHoveredNode → ref 동기화만 하고 effect는 재실행되지 않아, 캔버스
    // pan/zoom 위치와 클릭 상태가 보존된다.
    recomputeHighlights(hoveredNodeRef.current, externalHighlightNodeId, edges);

    // force layout에서만 드래그를 열어 노드 위치를 직접 조정할 수 있게 한다.
    // force-graph native drag가 fx/fy와 simulation reheat를 직접 처리한다.
    graph.enableNodeDrag(layoutMode === "force");

    // 이벤트 리스너 바인딩
    graph
      .onNodeClick((node: any) => {
        if (node?.id) queueResolvedNodeClick(node.id);
      })
      .onBackgroundClick(() => {
        clickHandlersRef.current.onBackgroundClick?.();
      })
      .onNodeHover((node: any) => {
        if (node) {
          onNodeInspect?.(node as GraphNode);
          setHoveredNode(node);
        } else {
          setHoveredNode(null);
        }
        // 호버 인접 노드/링크 강조는 ref 기반이라 여기서 직접 갱신해야 한다.
        recomputeHighlights(node ?? null, externalHighlightIdRef.current, edges);
        requestRepaint();
      })
      .onNodeDragEnd((node: any) => {
        // Obsidian식: 놓으면 풀어서 전체가 다시 자리를 잡게 한다. 저장된 좌표로
        // 고정돼 있던 노드도 이번 세션에서는 풀린다 (저장 좌표 삭제는 "리셋").
        if (layoutMode !== "force") return;
        node.fx = undefined;
        node.fy = undefined;
      })
      // v0.7.139+: zoom 변경 시 배율 표시 갱신 (pinch / ctrl+wheel / programmatic).
      .onZoom(({ k }: { k: number }) => {
        setZoomLevel(k);
      });

    const queueResolvedNodeClick = (nodeId: string) => {
      if (initialFitTimerRef.current !== null) {
        window.clearTimeout(initialFitTimerRef.current);
        initialFitTimerRef.current = null;
      }
      initialFitCancelledRef.current = true;

      const pending = pendingClickRef.current;
      const now = window.performance?.now?.() ?? Date.now();
      if (pending && pending.nodeId === nodeId) {
        // force-graph's native onNodeClick and our direct mouseup detector can both fire for
        // the same physical click. Ignore near-simultaneous duplicates; treat later repeats as double-click.
        if (now - pending.startedAt < 80) return;
        window.clearTimeout(pending.timeoutId);
        pendingClickRef.current = null;
        clickHandlersRef.current.onNodeDoubleClick?.(nodeId);
        return;
      }

      if (pending) {
        window.clearTimeout(pending.timeoutId);
        pendingClickRef.current = null;
      }

      // Single click must give immediate visual feedback in GraphPage's detail panel.
      // We only keep a short pending window to upgrade a second same-node click to navigation.
      clickHandlersRef.current.onNodeClick?.(nodeId);
      pendingClickRef.current = {
        nodeId,
        startedAt: now,
        timeoutId: window.setTimeout(() => {
          if (pendingClickRef.current?.nodeId !== nodeId) return;
          pendingClickRef.current = null;
        }, DOUBLE_CLICK_DELAY_MS),
      };
    };

    const getScreenPoint = (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
      if (typeof graph.screen2canvasCoords === "function") {
        return graph.screen2canvasCoords(screenX, screenY);
      }
      return graph.screen2GraphCoords(screenX, screenY);
    };

    const runDirectHitDetection = (clientX: number, clientY: number, pointerType: "mouse" | "touch") => {
      const start = pressStartRef.current;
      if (!isStationaryClickGesture(start?.point ?? null, { x: clientX, y: clientY }, pointerType)) {
        pressStartRef.current = null;
        return;
      }

      const canvasPoint = getScreenPoint(clientX, clientY);
      if (!canvasPoint) {
        pressStartRef.current = null;
        return;
      }

      const currentScale = graph?.zoom() ?? 1;
      const liveNodes = Array.isArray(graph.graphData?.().nodes)
        ? graph.graphData().nodes
        : graphNodesRef.current;
      const hitNode = findClosestNodeHit(
        liveNodes,
        canvasPoint,
        isDense ? "dense" : "normal",
        DIRECT_CLICK_PADDING_PX,
        currentScale,
        pointerType === "touch" ? DIRECT_TOUCH_HIT_RADIUS_PX : DIRECT_MOUSE_HIT_RADIUS_PX
      );

      pressStartRef.current = null;
      if (!hitNode) {
        clickHandlersRef.current.onBackgroundClick?.();
        return;
      }
      queueResolvedNodeClick(hitNode.id);
    };

    const handleMouseDown = (ev: MouseEvent) => {
      pressStartRef.current = {
        point: { x: ev.clientX, y: ev.clientY },
        pointerType: "mouse",
      };
    };

    const handleTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) {
        pressStartRef.current = null;
        return;
      }
      const touch = ev.touches[0];
      pressStartRef.current = {
        point: { x: touch.clientX, y: touch.clientY },
        pointerType: "touch",
      };
    };

    const handleMouseUp = (ev: MouseEvent) => {
      runDirectHitDetection(ev.clientX, ev.clientY, "mouse");
    };

    const handleTouchEnd = (ev: TouchEvent) => {
      if (ev.changedTouches.length !== 1) {
        pressStartRef.current = null;
        return;
      }
      const touch = ev.changedTouches[0];
      runDirectHitDetection(touch.clientX, touch.clientY, "touch");
    };

    const handleTouchCancel = () => {
      pressStartRef.current = null;
    };

    const container = containerRef.current;
    container?.addEventListener("mousedown", handleMouseDown, { passive: true });
    container?.addEventListener("touchstart", handleTouchStart, { passive: true });
    container?.addEventListener("mouseup", handleMouseUp, { passive: true });
    container?.addEventListener("touchend", handleTouchEnd, { passive: true });
    container?.addEventListener("touchcancel", handleTouchCancel, { passive: true });

    // 엣지 스타일 정의
    const crossVaultEdgeIds = new Set<string>();
    if (isDense) {
      edges.forEach((edge, idx) => {
        const srcVault = String(edge.source).split(":", 1)[0];
        const tgtVault = String(edge.target).split(":", 1)[0];
        if (srcVault !== tgtVault) {
          crossVaultEdgeIds.add(`e${idx}`);
        }
      });
    }

    graph
      .linkColor((link: any) => {
        // 색 문자열은 formattedLinks 생성 시 buildLinkStyle로 미리 조립해둔다
        // (이전 구현은 링크마다 매 프레임 정규식 매칭 + 문자열 조립을 했다).
        const style = link.__style as LinkStyle | undefined;
        const isHighlighted = highlightLinksRef.current.has(link.id);
        const hasFocusActive = isFocusActive() || !!hoveredNodeRef.current;

        if (style?.base) {
          if (isHighlighted) return style.base;
          return hasFocusActive ? style.faded : style.normal;
        }

        if (isHighlighted) return resolvedEdgeHighlightRef.current;
        if (link.__index) return resolvedEdgeIndexRef.current;
        return hasFocusActive ? resolvedEdgeFadedRef.current : resolvedEdgeColorRef.current;
      })
      .linkWidth((link: any) => {
        const isHighlighted = highlightLinksRef.current.has(link.id) || link.broken_dependency;
        const isSemantic = !!link.relation_type;
        // 선은 점(별) 사이의 희미한 흔적 — 강조된 선만 또렷하게.
        const baseWidth = link.__index ? 0.5 : isSemantic ? 1 : 0.6;
        return isHighlighted ? baseWidth + 1.15 : baseWidth;
      })
      .linkLineDash((link: any) => link.__dash ?? [])
      .linkDirectionalArrowLength((link: any) => link.__arrowLength ?? 0)
      .linkDirectionalArrowRelPos(1.0)
      .linkDirectionalArrowColor((link: any) => {
        const style = link.__style as LinkStyle | undefined;
        if (!style?.base) return resolvedEdgeHighlightRef.current;
        const isHighlighted = highlightLinksRef.current.has(link.id);
        if (isHighlighted) return style.base;
        const hasFocusActive = isFocusActive() || !!hoveredNodeRef.current;
        return hasFocusActive ? style.faded : style.normal;
      })
      .linkCurvature(0.035)
      // Remove animated particles: they made selected paths feel busy/tacky rather than clean.
      .linkDirectionalParticles(0)
      .linkDirectionalParticleWidth(0)
      .linkDirectionalParticleSpeed(0.016)
      .nodeLabel((node: any) => {
        const typeLabelStr = typeLabel(node.type);
        const typeBadge = typeLabelStr
          ? `<span style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(255, 255, 255, 0.15); margin-left: 6px;">${typeLabelStr}</span>`
          : "";
        return `
          <div style="
            padding: 6px 10px; 
            background: rgba(15, 23, 42, 0.95); 
            border: 1px solid rgba(255, 255, 255, 0.12); 
            border-radius: 4px; 
            color: #fff; 
            font-size: 12px;
            pointer-events: none;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
          ">
            <strong>${node.title || node.id}</strong>${typeBadge}
            <div style="font-size: 10px; color: #94a3b8; margin-top: 2px;">${node.id}</div>
          </div>
        `;
      })
      .linkLabel((link: any) => {
        if (!link.relation_type) return "";
        const relLabel = RELATION_LABELS[link.relation_type] || link.relation_type;
        
        const getTitle = (nodeOrId: any) => {
          if (typeof nodeOrId === "object" && nodeOrId !== null) {
            return nodeOrId.title || nodeOrId.id;
          }
          const found = graphNodesRef.current.find(n => n.id === nodeOrId);
          return found ? (found.title || found.id) : nodeOrId;
        };
        const sourceTitle = getTitle(link.source);
        const targetTitle = getTitle(link.target);
        
        const evidenceList = Array.isArray(link.evidence)
          ? link.evidence
          : (link.evidence ? [link.evidence] : []);
        const evidenceHtml = evidenceList.length > 0
          ? `<div style="margin-top: 4px; font-size: 11px; opacity: 0.85;"><strong>근거:</strong> ${evidenceList.join(', ')}</div>`
          : "";
        const reasonHtml = link.reason
          ? `<div style="margin-top: 4px; font-size: 11px; opacity: 0.85;"><strong>이유:</strong> ${link.reason}</div>`
          : "";
          
        return `
          <div style="
            padding: 8px 12px; 
            background: rgba(15, 23, 42, 0.95); 
            border: 1px solid rgba(255, 255, 255, 0.15); 
            border-radius: 6px; 
            color: #fff; 
            font-size: 12px; 
            max-width: 280px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
            pointer-events: none;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
          ">
            <div style="font-weight: 600; color: #818cf8; margin-bottom: 4px;">
              ${relLabel}
            </div>
            <div style="display: flex; align-items: center; gap: 4px; margin-bottom: 4px;">
              <span style="color: #cbd5e1; font-weight: 500;">${sourceTitle}</span>
              <span style="color: #64748b;">➔</span>
              <span style="color: #cbd5e1; font-weight: 500;">${targetTitle}</span>
            </div>
            ${evidenceHtml}
            ${reasonHtml}
          </div>
        `;
      });

    // 노드 스타일 커스텀 렌더링 (Obsidian 퀄리티 재현)
    // v0.7.144+: all-scope 모드 제거 — vault ring (resolveVaultColor 사용) 코드 삭제.
    // vault 외곽선 ring은 single vault에서 모든 노드가 같은 vault이라 무의미.
    graph.nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (!node || node.x === undefined || node.y === undefined) return;
      const scale = globalScale || 1;
      const size = nodeSize(node.weight, isDense ? "dense" : "normal", node.importance, nodes.length);
      // B3: 깊이 맵은 ref에서 읽는다. formattedNodes에 박아둔 __focusDepth를 쓰면
      // 깊이 슬라이더를 움직여도 다음 데이터 갱신까지 옛 값이 남는다.
      const depthMap = focusDepthMapRef.current;
      const focusDepth = depthMap.get(node.id);
      const depthMultiplier =
        typeof focusDepth === "number"
          ? Math.max(0.68, 1 - focusDepth * 0.12)
          : (depthMap.size > 0 ? 0.88 : 1);
      const renderedSize = size * depthMultiplier;
      // B1 뷰포트 컬링: 화면 밖 노드는 페인트하지 않는다. 라벨이 화면 안으로
      // 흘러 들어올 수 있으므로 여유를 둔다. (히트 판정은 shadow canvas와
      // findClosestNodeHit이 별도로 담당하므로 영향 없다.)
      const viewport = viewportRef.current;
      if (viewport && !isWithinViewport(node.x, node.y, renderedSize + 80, viewport)) return;
      // v0.7.139+: ref로 최신 hover state를 매 paint call에서 읽는다 (effect 재실행 없음).
      const currentHover = hoveredNodeRef.current;
      const isHovered = currentHover && currentHover.id === node.id;
      const isHighlighted = highlightNodesRef.current.has(node.id);
      // A3: props 대신 ref로 읽는다 — 하이라이트가 바뀌어도 이 effect가 재실행되지 않는다.
      const isPersistent = persistentHighlightIdRef.current === node.id;
      const isFocused =
        isHovered || isPersistent || externalHighlightIdRef.current === node.id;
      const fillOpacity = nodeOpacity(node.freshness);

      // 1. 노드 본체 — 테두리 없는 평면 점. 포커스된 노드만 같은 색으로 은은하게 빛난다.
      const hasFocusActive = isFocusActive() || currentHover;
      const baseAlpha = hasFocusActive && !isFocused && !isHighlighted
        ? fillOpacity * 0.28
        : fillOpacity;
      const depthAlpha = typeof focusDepth === "number"
        ? Math.max(0.28, 1 - focusDepth * 0.18)
        : (depthMap.size > 0 ? 0.72 : 1);
      const typeColor = nodeColor(node.type);
      const color = !node.__hub && !isFocused && !isHighlighted
        ? mixHex(typeColor, resolvedNodeNeutralRef.current, NODE_MUTE_RATIO)
        : typeColor;
      const indexAlpha = node.__index && !isFocused ? 0.45 : 1;

      ctx.save();
      if (isFocused) {
        // shadowBlur는 화면 픽셀 단위라 zoom과 무관하게 같은 크기로 번진다.
        ctx.shadowColor = hexToRgba(color, 0.85);
        ctx.shadowBlur = 18;
      } else if (node.__hub && !hasFocusActive) {
        ctx.shadowColor = hexToRgba(color, 0.55);
        ctx.shadowBlur = 12;
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, renderedSize, 0, 2 * Math.PI, false);
      ctx.fillStyle = hexToRgba(color, baseAlpha * indexAlpha);
      ctx.globalAlpha = depthAlpha;
      ctx.fill();
      ctx.restore();

      // 겹친 점끼리 경계가 뭉개지지 않게 하는 머리카락 두께 윤곽 (zoom 무관 1px).
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = resolvedNodeOutlineRef.current;
      ctx.globalAlpha = hasFocusActive && !isFocused && !isHighlighted ? 0.3 : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // 포커스 링 — 점과 살짝 띄운 얇은 고리
      if (isFocused) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, renderedSize + 3 / scale, 0, 2 * Math.PI, false);
        ctx.strokeStyle = resolvedEdgeHighlightRef.current;
        ctx.lineWidth = 1.5 / scale;
        ctx.stroke();
      }

      // 붉은색 경고 Halo 효과 (Broken Dependency Alert)
      if (node.broken_dependency) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, renderedSize + 4.5 / scale, 0, 2 * Math.PI, false);
        ctx.strokeStyle = "rgba(239, 68, 68, 0.75)";
        ctx.lineWidth = 2.5 / scale;
        ctx.stroke();
      }

      // 2. 텍스트 라벨 그리기 (LOD - Level of Detail)
      // dense(all-vault)에서는 라벨을 훨씬 보수적으로 노출해 "떡처럼 붙는" 현상을 줄인다.
      // current scope도 무조건 상시 노출 대신 zoom/중요도(weight) 기준을 둬 시야를 정리한다.
      const showLabel = shouldShowLabel(
        node,
        scale,
        isDense,
        isFocused,
        isHighlighted
      );
      if (showLabel) {
        const label = node.title || node.slug || node.id;
        const fontSize = NODE_LABEL_BASE_SIZE / scale;
        ctx.save();
        ctx.font = `${isFocused ? "500" : "400"} ${fontSize}px ${GRAPH_LABEL_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        // v0.7.146 (B): zoom-out에서 라벨이 노드 안에 박혀서 깨짐 → 노드 옆으로 오프셋.
        // zoom-in (scale > 1.5) 이하면 라벨을 노드 오른쪽으로 띄움.
        const labelOffsetX = scale < 1.5 ? (renderedSize + 8) / scale : 0;
        const labelX = node.x + labelOffsetX;
        const labelY = node.y + renderedSize + 3.8 / scale;

        // v0.7.201+: 긴 제목이 안 잘려서 다른 노드/UI와 겹치던 문제 — 잘라서
        // 표시하고, 호버/포커스 중인 노드만 배경 박스와 함께 전체 제목을 보여준다.
        // 절단 결과는 (폰트, 폭, 라벨) 키로 캐시되어 프레임마다 measureText를
        // 다시 이진탐색하지 않는다.
        const maxLabelWidth = NODE_LABEL_MAX_WIDTH_PX / scale;
        const displayLabel = isFocused
          ? label
          : resolveDisplayLabel(ctx, labelMetricsCacheRef.current, label, maxLabelWidth);

        // 라벨 충돌 회피: 포커스/하이라이트 라벨은 항상 그리고, 나머지는 이미
        // 라벨이 놓인 자리와 겹치면 이번 프레임에 포기한다.
        const measuredWidth = ctx.measureText(displayLabel).width;
        const labelClaimed =
          isFocused ||
          isHighlighted ||
          labelGridRef.current.tryOccupy(
            labelX - measuredWidth / 2,
            labelY,
            measuredWidth,
            fontSize
          );

        if (labelClaimed) {
          if (isFocused) {
            const padX = 4 / scale;
            const padY = 2 / scale;
            ctx.fillStyle = "rgba(15, 15, 20, 0.82)";
            ctx.fillRect(
              labelX - measuredWidth / 2 - padX,
              labelY - padY,
              measuredWidth + padX * 2,
              fontSize + padY * 2
            );
          }

          // No text outline: small canvas labels became fat/blurry with halo strokes.
          // Rely on theme-resolved high-contrast label color instead.
          ctx.fillStyle = isFocused
            ? resolvedEdgeHighlightRef.current
            : resolvedLabelColorRef.current;
          ctx.fillText(displayLabel, labelX, labelY);
        }
        ctx.restore();
      }
      // v0.7.144+: vault 라벨 코드 제거 (all-scope 모드 들어냄)
    })
      .nodePointerAreaPaint((node: any, color: string, ctx: CanvasRenderingContext2D, globalScale: number) => {
        if (!node || node.x === undefined || node.y === undefined) return;
        const scale = globalScale || 1;
        const depthMap = focusDepthMapRef.current;
        const focusDepth = depthMap.get(node.id);
        const depthMultiplier =
          typeof focusDepth === "number"
            ? Math.max(0.68, 1 - focusDepth * 0.12)
            : (depthMap.size > 0 ? 0.88 : 1);
        const hitRadius = Math.max(
          nodeSize(node.weight, isDense ? "dense" : "normal") * depthMultiplier * DIRECT_HIT_NODE_RADIUS_MULTIPLIER,
          DIRECT_MOUSE_HIT_RADIUS_PX / scale
        );
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, hitRadius, 0, 2 * Math.PI, false);
        ctx.fill();
      });

    // v0.7.144+: vault ring도 제거 — single vault에서는 모든 노드가 같은 vault이라 무의미.

    // 줌 아웃 시점에만 단순 텍스트로 폴더 라벨 투사 (LOD HUD)
    // 프레임 시작 시점: 뷰포트 경계와 라벨 점유 격자를 갱신한다.
    // nodeCanvasObject가 이 두 값을 읽어 화면 밖 노드를 건너뛰고(B1 컬링),
    // 이미 라벨이 놓인 자리와 겹치는 라벨을 포기한다(B1 충돌 회피).
    graph.onRenderFramePre((ctx: CanvasRenderingContext2D, globalScale: number) => {
      const scale = globalScale || 1;

      const toGraphCoords = (sx: number, sy: number) =>
        typeof graph.screen2canvasCoords === "function"
          ? graph.screen2canvasCoords(sx, sy)
          : graph.screen2GraphCoords(sx, sy);
      const width = graph.width?.() ?? 0;
      const height = graph.height?.() ?? 0;
      if (width > 0 && height > 0) {
        const topLeft = toGraphCoords(0, 0);
        const bottomRight = toGraphCoords(width, height);
        if (topLeft && bottomRight) {
          viewportRef.current = {
            x0: Math.min(topLeft.x, bottomRight.x),
            y0: Math.min(topLeft.y, bottomRight.y),
            x1: Math.max(topLeft.x, bottomRight.x),
            y1: Math.max(topLeft.y, bottomRight.y),
          };
        }
      }
      labelGridRef.current.reset();

      // 1. Domain View일 때 커뮤니티별 반투명 구획(Onion bound) 그리기.
      // 커뮤니티 대표 라벨은 데이터 변경 시 1회 계산해둔 communityLabelsRef를 읽는다
      // (이전 구현은 매 프레임 전 노드 제목을 정규식 토크나이즈 + 빈도 정렬했다).
      if (layoutMode === "domain") {
        const groupStats: Record<number, { xSum: number; ySum: number; count: number; xMin: number; xMax: number; yMin: number; yMax: number }> = {};
        const currentNodes = graph.graphData().nodes;

        currentNodes.forEach((node: any) => {
          const c = node.community ?? 0;
          if (!groupStats[c]) {
            groupStats[c] = { xSum: 0, ySum: 0, count: 0, xMin: 99999, xMax: -99999, yMin: 99999, yMax: -99999 };
          }
          groupStats[c].xSum += node.x;
          groupStats[c].ySum += node.y;
          groupStats[c].count += 1;
          if (node.x < groupStats[c].xMin) groupStats[c].xMin = node.x;
          if (node.x > groupStats[c].xMax) groupStats[c].xMax = node.x;
          if (node.y < groupStats[c].yMin) groupStats[c].yMin = node.y;
          if (node.y > groupStats[c].yMax) groupStats[c].yMax = node.y;
        });

        ctx.save();
        for (const cidStr in groupStats) {
          const cid = Number(cidStr);
          const stat = groupStats[cid];
          if (stat.count === 0) continue;
          const cx = stat.xSum / stat.count;
          const cy = stat.ySum / stat.count;

          const dx = stat.xMax - stat.xMin;
          const dy = stat.yMax - stat.yMin;
          const radius = Math.max(38, Math.hypot(dx, dy) / 2 + 35);

          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
          const color = communityPaletteRef.current[cid % communityPaletteRef.current.length];

          // LOD 줌 연동: 줌 레벨에 따라 채우기 및 테두리 투명도 보정
          const bgOpacity = Math.max(0.01, Math.min(0.06, (0.85 - scale) * 0.08));
          const borderOpacity = Math.max(0.05, Math.min(0.24, (0.85 - scale) * 0.3));

          ctx.fillStyle = hexToRgba(color, bgOpacity);
          ctx.fill();
          ctx.lineWidth = 0.8 / scale;
          ctx.strokeStyle = hexToRgba(color, borderOpacity);
          ctx.stroke();

          // 축소 수준이 높을 때(scale < 0.85)만 대표 도메인 레이블을 투사한다.
          if (scale < 0.85) {
            const labelText = communityLabelsRef.current.get(cid) ?? `Community ${cid}`;
            const textOpacity = Math.min(0.75, (0.85 - scale) * 1.15);
            const fontSize = Math.max(10, Math.min(14, 14 - scale * 4));

            ctx.save();
            ctx.font = `600 ${fontSize / scale}px ${HUD_LABEL_FONT}`;
            ctx.fillStyle = color;
            ctx.globalAlpha = textOpacity;
            ctx.textAlign = "center";
            ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
            ctx.shadowBlur = 4 / scale;
            ctx.fillText(labelText, cx, cy - radius - 8 / scale);
            ctx.restore();
          }
        }
        ctx.restore();
        return;
      }

      // 2. Timeline View 가이드 라인 — 축 격자는 데이터 변경 시 1회 계산해둔
      // timelineGridRef를 읽는다 (이전 구현은 매 프레임 Math.min(...times) 스프레드와
      // 격자 재생성을 수행했다).
      if (layoutMode === "timeline" && nodes.length > 0) {
        ctx.save();
        ctx.strokeStyle = "rgba(148, 163, 184, 0.12)";
        ctx.lineWidth = 0.8 / scale;
        ctx.font = `600 ${10 / scale}px ${HUD_LABEL_FONT}`;
        ctx.fillStyle = "rgba(148, 163, 184, 0.4)";

        for (const [typeName, yVal] of Object.entries(TIMELINE_TYPE_LANES)) {
          ctx.beginPath();
          ctx.moveTo(-500, yVal);
          ctx.lineTo(500, yVal);
          ctx.stroke();

          ctx.textAlign = "left";
          ctx.fillText(typeLabel(typeName) || typeName, -485, yVal - 8 / scale);
        }

        ctx.strokeStyle = "rgba(148, 163, 184, 0.06)";
        timelineGridRef.current.forEach(({ x, label }) => {
          ctx.beginPath();
          ctx.moveTo(x, -250);
          ctx.lineTo(x, 200);
          ctx.stroke();

          ctx.textAlign = "center";
          ctx.fillText(label, x, 215 / scale);
        });
        ctx.restore();
        return;
      }

      if (layoutMode === "layered" && nodes.length > 0) {
        const layers = layeredAxisRef.current;
        if (layers.length === 0) return;

        ctx.save();
        ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
        ctx.lineWidth = 0.9 / scale;
        ctx.font = `600 ${10 / scale}px ${HUD_LABEL_FONT}`;
        ctx.fillStyle = "rgba(148, 163, 184, 0.5)";
        ctx.textAlign = "center";

        const xStart = -430;
        const xEnd = 430;
        const span = Math.max(1, layers[layers.length - 1] - layers[0]);

        layers.forEach((layer) => {
          const ratio = (layer - layers[0]) / span;
          const x = xStart + ratio * (xEnd - xStart);
          ctx.beginPath();
          ctx.moveTo(x, -260);
          ctx.lineTo(x, 260);
          ctx.stroke();
          ctx.fillText(`Layer ${layer}`, x, 276 / scale);
        });

        ctx.restore();
        return;
      }

      // 3. Force-directed 모드일 때 Centroid LOD HUD 라벨 연산
      const labelOpacity = Math.max(0, Math.min(1, (0.75 - scale) / 0.25));
      if (labelOpacity <= 0.05) return;

      const groupCoords: Record<string, { xSum: number; ySum: number; count: number; label: string }> = {};
      const currentNodes = graph.graphData().nodes;

      for (const node of currentNodes) {
        if (typeof node.x !== "number" || typeof node.y !== "number" || !node.folder_group) continue;
        const gid = node.folder_group;
        if (!groupCoords[gid]) {
          groupCoords[gid] = { xSum: 0, ySum: 0, count: 0, label: node.folder_label || gid };
        }
        groupCoords[gid].xSum += node.x;
        groupCoords[gid].ySum += node.y;
        groupCoords[gid].count += 1;
      }

      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      for (const gid in groupCoords) {
        const data = groupCoords[gid];
        if (data.count < 5) continue;

        const cx = data.xSum / data.count;
        const cy = data.ySum / data.count;
        const drawY = cy - 24 / scale;

        const labelText = data.label;
        const isContent = gid === "content";
        const targetGroupAlpha = isContent ? 0.24 : 0.16;
        const textOpacity = labelOpacity * targetGroupAlpha;

        const fontSize = Math.max(
          isContent ? 12 : 14,
          (isContent ? 13 : HUD_LABEL_BASE_SIZE) / scale
        );

        ctx.font = `600 ${fontSize}px ${HUD_LABEL_FONT}`;

        ctx.fillStyle = resolvedBgColorRef.current;
        ctx.globalAlpha = textOpacity * 0.75;
        for (let dx = -1.5; dx <= 1.5; dx += 1.5) {
          for (let dy = -1.5; dy <= 1.5; dy += 1.5) {
            if (dx !== 0 || dy !== 0) {
              ctx.fillText(labelText, cx + dx * (0.8 / scale), drawY + dy * (0.8 / scale));
            }
          }
        }

        ctx.fillStyle = resolvedLabelColorRef.current;
        ctx.globalAlpha = textOpacity;
        ctx.fillText(labelText, cx, drawY);
      }
      ctx.restore();
    });

    // v0.7.139+: fitView는 scope 전환(all ↔ current) 또는 첫 데이터 로드 시에만.
    // 검색/필터로 nodes가 바뀌어도 사용자의 pan/zoom 위치를 보존한다.
    // v0.7.150+: container 크기가 아직 계산되지 않았다면(width/height가 0일 때) 줌핏이 어긋나므로
    // 크기가 정상 확보될 때까지 대기 후 zoomToFit을 정확한 시점에 단 1회 실행합니다.
    const scopeChanged = prevIsDenseRef.current !== isDense;
    const firstLoad = prevNodeCountRef.current === 0 && nodes.length > 0;
    if (scopeChanged || firstLoad) {
      if (initialFitTimerRef.current !== null) {
        window.clearTimeout(initialFitTimerRef.current);
        initialFitTimerRef.current = null;
      }
      initialFitCancelledRef.current = false;
      if (nodes.length > 0) {
        const tryFit = (retryCount = 0) => {
          initialFitTimerRef.current = null;
          if (initialFitCancelledRef.current) return;
          const g = graphInstanceRef.current;
          if (!g) return;
          const w = g.width();
          const h = g.height();
          if (w > 0 && h > 0) {
            // 초기 맞춤은 애니메이션하지 않는다. 선택 직후 detail 패널이 캔버스 폭을
            // 바꾸는 동안 진행 중인 zoomToFit 트윈이 카메라를 다시 덮어쓰지 않게 한다.
            g.zoomToFit(0, 96);
            // 살아 있는 물리가 첫 1~2초 동안 서버 좌표에서 평형 크기로 펴지므로,
            // 자리 잡은 뒤 한 번 더 맞춘다. 사용자가 그 사이 조작했으면 건너뛴다.
            initialFitTimerRef.current = window.setTimeout(() => {
              initialFitTimerRef.current = null;
            }, SETTLED_FIT_DELAY_MS);
          } else if (retryCount < 10) {
            // 크기 대기 재시도 (최대 10회, 1초)
            initialFitTimerRef.current = window.setTimeout(() => tryFit(retryCount + 1), 100);
          }
        };
        initialFitTimerRef.current = window.setTimeout(() => tryFit(), 50);
      }
    }
    prevIsDenseRef.current = isDense;
    prevNodeCountRef.current = nodes.length;

    return () => {
      // 초기 맞춤 timer는 여기서 취소하지 않는다. 첫 로드 직후 이 effect가 콜백 deps
      // 변화로 연달아 재실행되는데(측정: 80ms 안에 3회), 그때마다 취소하면 firstLoad가
      // 아닌 재실행은 다시 예약하지 않아 초기 맞춤이 한 번도 실행되지 않았다.
      // 취소는 언마운트(인스턴스 생성 effect의 cleanup)와 사용자 클릭이 맡는다.
      container?.removeEventListener("mousedown", handleMouseDown);
      container?.removeEventListener("touchstart", handleTouchStart);
      container?.removeEventListener("mouseup", handleMouseUp);
      container?.removeEventListener("touchend", handleTouchEnd);
      container?.removeEventListener("touchcancel", handleTouchCancel);
      if (graphInstanceRef.current) {
        graphInstanceRef.current.onRenderFramePre(null);
      }
    };
  }, [
    nodes,
    edges,
    isDense,
    // A3: 하이라이트 3종은 deps에서 빠졌다 — 클릭/호버가 graphData 재설정과
    // d3 리히트를 유발하지 않는다. 다만 concentric 뷰는 "선택 노드"를 중심으로
    // 좌표를 다시 깔아야 하므로, 그 모드에서만 중심 id를 dep으로 남긴다.
    concentricCenterDep,
    onNodeInspect,
      layoutMode,
  ]);

  const fitGraph = () => {
    if (graphInstanceRef.current) {
      // v0.7.150+: '맞춤' 기능은 노드들의 기하학적 배치(fx/fy)를 뭉개지 않고 
      // 단순히 카메라 줌/팬을 전체 노드 영역에 맞추도록 개선합니다.
      // D3 시뮬레이션을 재가열하여 배치 데이터를 폭발시키거나 흩뿌리는 대신,
      // 원래 위치를 유지한 상태에서 zoomToFit만 즉시 실행합니다.
      graphInstanceRef.current.zoomToFit(400, 96);
    }
  };

  // v0.7.139+: programmatic zoom (factor 1.6 / 0.625). force-graph의 zoom(k)는 중심을
  // 그대로 두고 배율만 바꿔 pan/zoom UX와 일관됨.
  const ZOOM_STEP = 1.6;
  /** B4: 선택 노드로 줌할 때 최소 확보 배율 (이미 더 확대돼 있으면 유지). */
  const ZOOM_TO_SELECTION_SCALE = 2.2;
  const zoomIn = () => {
    const g = graphInstanceRef.current;
    if (!g) return;
    g.zoom((g.zoom() ?? 1) * ZOOM_STEP, 400);
  };
  const zoomOut = () => {
    const g = graphInstanceRef.current;
    if (!g) return;
    g.zoom((g.zoom() ?? 1) / ZOOM_STEP, 400);
  };
  /**
   * B4: 선택(또는 현재 문서) 노드로 카메라를 옮기고 확대한다. 좌표는 그래프
   * 인스턴스의 실제 노드에서 읽는다 — 드래그로 옮긴 위치까지 반영된다.
   */
  const zoomToSelection = () => {
    const graph = graphInstanceRef.current;
    if (!graph) return;
    const targetId = focusNodeId ?? persistentHighlightNodeId ?? externalHighlightNodeId;
    if (!targetId) return;
    const liveNodes: any[] = Array.isArray(graph.graphData?.().nodes)
      ? graph.graphData().nodes
      : graphNodesRef.current;
    const target = liveNodes.find((n) => n?.id === targetId);
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return;
    graph.centerAt(target.x, target.y, 450);
    graph.zoom(Math.max(graph.zoom() ?? 1, ZOOM_TO_SELECTION_SCALE), 450);
  };

  const hasSelection = !!(focusNodeId ?? persistentHighlightNodeId ?? externalHighlightNodeId);

  // 배율 표시 — 1.0 = 100%. 줌이 1 근처일 때만 "100%"로 단순화, 그 외엔 백분율로 표시.
  const zoomPercent = Math.round(zoomLevel * 100);
  const zoomLabel = `${zoomPercent}%`;

  const isMinimap = variant === "minimap";

  return (
    <div
      className={`graph-canvas-container${isMinimap ? " is-minimap" : ""}`}
    >
      {isJSDOM ? (
        <div data-testid="graph-canvas-mock" style={{ color: "var(--graph-text)", padding: 20 }}>
          [JSDOM Test Mock Graph Canvas]
        </div>
      ) : (
        // v0.7.139+: touchAction:none — 모바일에서 캔버스 pan이 pull-to-refresh로
        // 새지 않도록 모든 native touch gesture를 우리가 처리.
        <div
          ref={containerRef}
          style={{ width: "100%", height: "100%", touchAction: "none" }}
        />
      )}

      {/* 툴바 컨트롤 레이어 */}
      <div className="graph-canvas-toolbar">
        {onFullscreen && (
          <button
            type="button"
            onClick={onFullscreen}
            className="graph-canvas-btn"
            aria-label="그래프 전체보기"
            title="팝업으로 크게 보기"
          >
            {isMinimap ? "전체" : "전체보기"}
          </button>
        )}
        <button
          type="button"
          onClick={fitGraph}
          className="graph-canvas-btn"
          aria-label="그래프 화면 맞춤"
          title="배치를 초기화하고 모든 노드가 화면에 들어오도록 뷰를 맞춥니다"
        >
          맞춤
        </button>
        <button
          type="button"
          onClick={zoomToSelection}
          className="graph-canvas-btn"
          aria-label="선택한 문서로 이동"
          title="선택한 문서를 화면 중앙으로 가져와 확대합니다"
          disabled={!hasSelection}
        >
          선택 위치
        </button>
        {onResetLayout && (
          <button
            type="button"
            onClick={onResetLayout}
            className="graph-canvas-btn"
            aria-label="그래프 레이아웃 리셋"
            title="드래그로 옮긴 노드 위치를 모두 버리고 서버 원본 배치로 되돌립니다"
          >
            리셋
          </button>
        )}
        {/* v0.7.139+: 줌 컨트롤 순서: + / 배율% / − (미니맵 포함 항상 표시) */}
        <button
          type="button"
          onClick={zoomIn}
          className="graph-canvas-btn"
          aria-label="그래프 확대"
          title="확대 (단축키: +)"
        >
          +
        </button>
        <span
          aria-live="polite"
          className="graph-canvas-zoom-label"
          title={`현재 줌 배율 — 더블클릭으로 100%로 리셋`}
          onDoubleClick={() => graphInstanceRef.current?.zoomTo(1, 200)}
        >
          {zoomLabel}
        </span>
        <button
          type="button"
          onClick={zoomOut}
          className="graph-canvas-btn"
          aria-label="그래프 축소"
          title="축소 (단축키: −)"
        >
          −
        </button>

      </div>
    </div>
  );
}

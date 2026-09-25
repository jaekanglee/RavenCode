import { apiFetch } from "../lib/api";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  DEFAULT_FOCUS_DEPTH,
  GraphCanvas,
  MAX_FOCUS_DEPTH,
  MIN_FOCUS_DEPTH,
  typeLabel,
} from "../components/GraphCanvas";
import { FullscreenGraphModal } from "../components/FullscreenGraphModal";
import type { Graph, GraphNode } from "../types";
import { EmptyState } from "../components/ui/EmptyState";
import { PageHeader } from "../components/ui/PageHeader";
import { TextField } from "../components/ui/TextField";
import { FilterChip } from "../components/ui/FilterChip";
import { Button } from "../components/ui/Button";
import { EmptyIcon } from "../lib/emptyIcons";
import { RELATION_COLOR_FALLBACK, TYPE_COLOR_FALLBACK } from "../lib/graph/render";
import {
  deriveCommunityOptions,
  deriveGraphInsights,
  deriveNodeDetail,
  filterGraphView,
  type GraphFilterState,
  type GraphInsight,
  type GraphNodeDetail,
} from "../lib/graph/derive";

const GRAPH_SEED_ITERATIONS = 60;

const RELATION_HELPERS = [
  { value: "wikilink", title: "링크", description: "문장/문맥 중심의 기본 연결" },
  { value: "uses", title: "Uses", description: "이 문서가 다른 문서를 사용함" },
  { value: "depends_on", title: "Depends on", description: "이 문서가 선행 문서에 의존함" },
  { value: "implements", title: "Implements", description: "이 문서가 개념이나 설계를 구현함" },
  { value: "implemented_by", title: "Implemented by", description: "이 문서가 구현체로 실현됨" },
  { value: "related", title: "Related", description: "명시적 의존은 아니지만 맥락적으로 연관됨" },
] as const;

// v0.7.125+: 외부 호환을 위해 re-export. 기존 import 경로 보존하면서
// lib/graph/derive.ts가 단일 source of truth.
export {
  deriveCommunityOptions,
  deriveGraphInsights,
  deriveNodeDetail,
  filterGraphView,
} from "../lib/graph/derive";

/**
 * v0.7.123+: GraphPage의 사용자 입력 필터 상태 (GraphFilterState와 1:1 매핑이지만
 * selectedCommunity는 현재 UX에서 노출하지 않으므로 항상 null). useReducer
 * 상태로 묶어 resetGraphFilters 등 다중 setState를 한 번의 dispatch로 통합.
 */
type GraphPageFilters = {
  query: string;
  selectedType: string;
  hideOrphans: boolean;
  selectedNodeId: string | null;
  visibleRelations: string[];
};

type GraphPageFilterAction =
  | { type: "setQuery"; value: string }
  | { type: "setSelectedType"; value: string }
  | { type: "setHideOrphans"; value: boolean }
  | { type: "setSelectedNodeId"; value: string | null }
  | { type: "setVisibleRelations"; value: string[] }
  | { type: "toggleRelation"; relation: string }
  | { type: "reset" };

const initialFilters: GraphPageFilters = {
  query: "",
  selectedType: "all",
  hideOrphans: true,
  selectedNodeId: null,
  visibleRelations: ["wikilink", "uses", "depends_on", "implements", "implemented_by", "related"],
};

function filterReducer(
  state: GraphPageFilters,
  action: GraphPageFilterAction
): GraphPageFilters {
  switch (action.type) {
    case "setQuery":
      return { ...state, query: action.value };
    case "setSelectedType":
      return { ...state, selectedType: action.value };
    case "setHideOrphans":
      return { ...state, hideOrphans: action.value };
    case "setSelectedNodeId":
      return { ...state, selectedNodeId: action.value };
    case "setVisibleRelations":
      return { ...state, visibleRelations: action.value };
    case "toggleRelation": {
      const isVisible = state.visibleRelations.includes(action.relation);
      const nextVisible = isVisible
        ? state.visibleRelations.filter((r) => r !== action.relation)
        : [...state.visibleRelations, action.relation];
      return { ...state, visibleRelations: nextVisible };
    }
    case "reset":
      return initialFilters;
    default:
      return state;
  }
}

type GraphScope = "all" | "current";

function nodeVault(node: GraphNode, fallbackVault: string): string {
  return node.vault || fallbackVault;
}

function nodeSlug(node: GraphNode): string {
  return node.slug ?? node.id;
}

/**
 * GraphPage — dark xyflow canvas + connected-document exploration.
 * v0.6.10+: 백엔드가 nodes[i].x/y force-directed 좌표 제공.
 * v0.7.35+: search/type controls + insight cards for graph exploration.
 * v0.7.6x+: layout은 atlas(ForceAtlas2/LinLog hybrid) 고정 — 선택 UI 제거.
 * v0.7.122+: community/cluster controls are hidden from the primary UX;
 *   graph colors are user-facing document type colors.
 */
export function GraphPage() {
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  // v0.7.144+: graphScope 토글 제거 — current 단일 vault만 표시.
  // v0.7.123+: 그래프 페이지 필터 상태(query/selectedType/hideOrphans/selectedNodeId)를
  // useReducer로 묶어 resetGraphFilters 등 다중 setState 시 동기화 + 의도 명시.
  // 인사이트 hover 2종 + 로딩/에러/showFullGraph는 데이터 라이프사이클/UI 토글로
  // 빈도가 낮아 그대로 useState 유지.
  const [filters, dispatchFilters] = useReducer(filterReducer, initialFilters);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [hoveredInsightNodeId, setHoveredInsightNodeId] = useState<string | null>(null);
  const [hoveredInsightType, setHoveredInsightType] = useState<string | null>(null);
  const [showFullGraph, setShowFullGraph] = useState(false);
  const [activeTab, setActiveTab] = useState<"inbound" | "outbound" | "neighbors">("inbound");
  // B3: 선택 노드로부터 몇 촌까지 강조할지. 이전에는 3촌 하드코딩이었다.
  const [focusDepth, setFocusDepth] = useState<number>(DEFAULT_FOCUS_DEPTH);
  const navigate = useNavigate();
  const { vault } = useOutletContext<{ vault: string }>();

  const { query, selectedType, hideOrphans, selectedNodeId, visibleRelations } = filters;

  const resetGraphFilters = () => {
    dispatchFilters({ type: "reset" });
    setFocusDepth(DEFAULT_FOCUS_DEPTH);
  };

  useEffect(() => {
    setActiveTab("inbound");
  }, [selectedNodeId]);

  // v0.7.147+: 사이드바 문서 호버 시 그래프 상의 노드 동적 하이라이트 연동
  useEffect(() => {
    const handleSidebarHover = (e: Event) => {
      const customEvent = e as CustomEvent<{ id: string | null }>;
      setHoveredInsightNodeId(customEvent.detail.id);
    };
    window.addEventListener("raven-node-hover", handleSidebarHover);
    return () => {
      window.removeEventListener("raven-node-hover", handleSidebarHover);
    };
  }, []);

  const loadGraph = () => {
    if (!vault) return;
    setLoading(true);
    setLoadError(false);
    // v0.7.144+: ?scope= 쿼리 제거 — current만 사용.
    // 서버 ForceAtlas 좌표는 클라이언트 물리의 출발점일 뿐이라 거칠어도 된다.
    // 기본 500회는 169문서 vault에서 ~2.8초, 60회는 ~0.3초.
    apiFetch(`/api/vaults/${encodeURIComponent(vault)}/graph?iterations=${GRAPH_SEED_ITERATIONS}`)
      .then((r) => (r.ok ? r.json() : { nodes: [], edges: [] }))
      .then((d) => setGraph({ nodes: d.nodes ?? [], edges: d.edges ?? [] }))
      .catch(() => {
        setGraph({ nodes: [], edges: [] });
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadGraph();
  }, [vault]);

  const filteredGraph = useMemo(
    () =>
      filterGraphView(graph, {
        hideOrphans,
        query,
        selectedType,
        selectedCommunity: null,
        visibleRelations,
      }),
    [graph, hideOrphans, query, selectedType, visibleRelations]
  );

  const visibleNodes = filteredGraph.nodes;
  const visibleEdges = filteredGraph.edges;

  const orphanCount = useMemo(
    () => graph.nodes.filter((n) => (n.weight ?? 0) === 0).length,
    [graph.nodes]
  );

  const graphInsights = useMemo(() => deriveGraphInsights(graph), [graph]);
  const selectedNodeDetail = useMemo(
    () => (selectedNodeId ? deriveNodeDetail(graph, selectedNodeId) : null),
    [graph, selectedNodeId]
  );

  // 관계 칩은 실제로 존재하는 관계 타입만, 의미 관계가 하나라도 있을 때만 보인다.
  // (hub-control-room: 링크 592 / 의미 관계 3 — 여섯 토글이 늘 켜져만 있었다)
  const relationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of graph.edges) {
      const key = e.relation_type || "wikilink";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [graph.edges]);
  const presentRelations = RELATION_HELPERS.filter((item) => (relationCounts.get(item.value) ?? 0) > 0);
  const showRelationChips = presentRelations.some((item) => item.value !== "wikilink");

  const hasAnyNodes = graph.nodes.length > 0;
  const hasVisibleNodes = visibleNodes.length > 0;
  const isDefaultRelations =
    visibleRelations.length === 6 &&
    ["wikilink", "uses", "depends_on", "implements", "implemented_by", "related"].every((r) =>
      visibleRelations.includes(r)
    );

  const hasActiveFilter =
    query.trim().length > 0 ||
    selectedType !== "all" ||
    !hideOrphans ||
    !isDefaultRelations ||
    focusDepth !== DEFAULT_FOCUS_DEPTH;

  const graphNodeMap = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes]
  );

  // v0.7.144+: vaultCentroids useMemo 제거 (all-scope 모드 종료).

  // v0.7.139+: useCallback으로 안정화 — GraphCanvas의 effect deps가 매번 흔들려서
  // onNodeClick/onNodeDoubleClick 리스너가 재바인딩되는 걸 방지. 안정적이어야
  // force-graph의 클릭 디바운스(lastClick)와 mousemove 히트 판정이 깨지지 않음.
  const openGraphNode = useCallback(
    (nodeId: string) => {
      const node = graphNodeMap.get(nodeId);
      if (!node) return;
      navigate(`/page/${nodeVault(node, vault)}/${nodeSlug(node)}`);
    },
    [navigate, vault, graphNodeMap]
  );

  const handleCanvasNodeClick = useCallback(
    (nodeId: string) => {
      dispatchFilters({ type: "setSelectedNodeId", value: nodeId });
    },
    [dispatchFilters]
  );

  // v0.7.151+: "리셋" 버튼 — 드래그로 저장된 좌표(.graph_positions.json)를 모두
  // 지우고 서버 원본 ForceAtlas2 배치로 되돌린다. 되돌릴 수 없는 동작이라 확인을 거친다.
  const resetLayout = useCallback(() => {
    if (!vault) return;
    if (!window.confirm("드래그로 옮긴 모든 노드 위치를 버리고 원래 배치로 되돌릴까요?")) return;
    apiFetch(`/api/vaults/${encodeURIComponent(vault)}/graph/positions`, { method: "DELETE" })
      .catch(() => {})
      .finally(() => loadGraph());
  }, [vault]);

  // 타입을 고르면 그 타입 전체를 보려는 것 — 남아 있던 문서 선택이 포커스 모드로
  // 나머지를 물려서 "80개인데 하나만 보이는" 상태가 되지 않게 선택을 푼다.
  const selectType = (type: string) => {
    dispatchFilters({ type: "setSelectedNodeId", value: null });
    dispatchFilters({ type: "setSelectedType", value: type });
  };

  const filterBar = (
    <div className="graph-filter-bar" role="toolbar" aria-label="그래프 필터">
      <div className="graph-filter-search">
        <TextField
          label="문서 검색"
          hideLabel
          value={query}
          onChange={(e) => dispatchFilters({ type: "setQuery", value: e.target.value })}
          placeholder="문서 검색 — 일치 문서와 1촌 이웃만 남김"
        />
      </div>
      <div className="graph-filter-chips" aria-label="문서 타입">
        <FilterChip
          label="전체"
          count={graph.nodes.length}
          active={selectedType === "all"}
          onClick={() => selectType("all")}
        />
        {graphInsights.typeBreakdown.map(({ type, count }) => (
          <FilterChip
            key={type}
            label={typeLabel(type) || type}
            count={count}
            active={selectedType === type}
            dotColor={`var(--graph-type-${type}, ${TYPE_COLOR_FALLBACK[type] ?? "var(--color-muted)"})`}
            onClick={() => selectType(selectedType === type ? "all" : type)}
          />
        ))}
      </div>
      {showRelationChips && (
        <div className="graph-filter-chips" aria-label="관계">
          {presentRelations.map((item) => (
            <FilterChip
              key={item.value}
              label={item.title}
              count={relationCounts.get(item.value)}
              active={visibleRelations.includes(item.value)}
              dotColor={RELATION_COLOR_FALLBACK[item.value]}
              title={item.description}
              onClick={() => dispatchFilters({ type: "toggleRelation", relation: item.value })}
            />
          ))}
        </div>
      )}
      <div className="graph-filter-actions">
        {hasActiveFilter && (
          <Button type="button" variant="ghost" size="sm" onClick={resetGraphFilters}>
            필터 초기화
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={loadGraph} title="그래프 다시 불러오기">
          새로고침
        </Button>
      </div>
    </div>
  );

  useEffect(() => {
    if (!selectedNodeId) return;
    const stillVisible = visibleNodes.some((node) => (node.id) === selectedNodeId);
    if (!stillVisible) dispatchFilters({ type: "setSelectedNodeId", value: null });
  }, [selectedNodeId, visibleNodes]);

  return (
    <div className="graph-page-shell">
      <div className="graph-page-toolbar">
        <PageHeader
          title="그래프"
          contextLabel={`${vault} 보관소`}
          titleSize={24}
          bottomSpacing={0}
        />
        <div className="graph-page-meta" aria-label="그래프 상태">
          <span>{loading ? "그래프 계산 중…" : `문서 ${visibleNodes.length}/${graph.nodes.length}`}</span>
          <span>{loading ? "잠시만 기다려 주세요" : `연결 ${visibleEdges.length}`}</span>
          {orphanCount > 0 && hideOrphans && <span>연결 없는 문서 {orphanCount}개 숨김</span>}
        </div>
        <label className="graph-page-toggle">
          <input
            type="checkbox"
            checked={hideOrphans}
            onChange={(e) => dispatchFilters({ type: "setHideOrphans", value: e.target.checked })}
          />
          연결 없는 문서 숨김
        </label>
      </div>

      {filterBar}

      <div className="graph-page-workspace">
      <div className="graph-canvas-frame">
        {loading ? (
          <EmptyState
            icon={<EmptyIcon.Spinner />}
            title="그래프를 불러오는 중입니다"
            description="문서 연결 구조를 계산하고 있습니다."
          />
        ) : loadError ? (
          <EmptyState
            icon={<EmptyIcon.AlertTriangle />}
            title="그래프를 불러오지 못했습니다"
            description="API 응답 또는 로컬 상태를 다시 확인해 보세요."
            action={(
              <button
                type="button"
                className="btn-secondary"
                style={{ height: 36, padding: "8px 14px", fontSize: 13 }}
                onClick={loadGraph}
              >
                다시 시도
              </button>
            )}
          />
        ) : !hasAnyNodes ? (
          <EmptyState
            icon={<EmptyIcon.Database />}
            title="아직 시각화할 문서가 없습니다"
            description="현재 보관소에 문서를 추가하면 연결 그래프가 여기에 표시됩니다."
          />
        ) : !hasVisibleNodes && hideOrphans && orphanCount === graph.nodes.length ? (
          <EmptyState
            icon={<EmptyIcon.Fog />}
            title="지금은 모두 연결 없는 문서입니다"
            description="연결 없는 문서 숨김을 끄면 문서는 보이지만 아직 서로 연결되지 않았다는 뜻입니다."
            action={(
              <button
                type="button"
                className="btn-secondary"
                style={{ height: 36, padding: "8px 14px", fontSize: 13 }}
                onClick={() => dispatchFilters({ type: "setHideOrphans", value: false })}
              >
                연결 없는 문서 보기
              </button>
            )}
          />
        ) : !hasVisibleNodes ? (
          <EmptyState
            icon={<EmptyIcon.Search />}
            title="필터와 일치하는 문서가 없습니다"
            description="검색어를 지우거나 타입 필터를 바꿔서 다시 확인해 보세요."
            action={(
              <button
                type="button"
                className="btn-secondary"
                style={{ height: 36, padding: "8px 14px", fontSize: 13 }}
                onClick={resetGraphFilters}
              >
                필터 초기화
              </button>
            )}
          />
        ) : (
          <GraphCanvas
            nodes={visibleNodes}
            edges={visibleEdges}
            focusNodeId={selectedNodeId}
            // v0.7.139+: force-graph의 onNodeClick은 node.id를 그대로 전달한다.
            // all-scope에선 id="{vault}:{slug}", current-scope에선 id=slug이므로
            // selectedNodeId는 항상 id로 통일해야 highlightNodes/edge에서 매칭됨.
            // useCallback으로 안정화해서 effect 재실행 폭발 방지 — 콜백이 매번 새 ref면
            // GraphCanvas의 effect deps가 흔들려 onNodeClick 리스너가 끊임없이 재바인딩됨.
            onNodeClick={handleCanvasNodeClick}
            onNodeDoubleClick={openGraphNode}
            onBackgroundClick={() => dispatchFilters({ type: "setSelectedNodeId", value: null })}
            // v0.7.139+: 사용자가 노드를 클릭하면 선택된 노드 + 그 인접 노드(1-hop)가
            // 캔버스에서 하이라이트되고, 나머지는 톤다운되어 포커스된다.
            // 우선순위: hoveredInsightNodeId(호버 노드) > selectedNodeId(클릭 선택 노드).
            externalHighlightNodeId={hoveredInsightNodeId ?? selectedNodeId}
            externalHighlightType={hoveredInsightType}
            density="normal"
            focusDepthLimit={focusDepth}
            onFullscreen={() => setShowFullGraph(true)}
            onResetLayout={resetLayout}
          />
        )}
      </div>
      <aside className="graph-detail-panel" aria-label="선택 문서 상세">
        {selectedNodeDetail ? (
          <>
            {/* 컴팩트 헤더 */}
            <div className="graph-detail-header">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                  <span className="sidebar-tree-page-pill" data-type={selectedNodeDetail.node.type || "unknown"}>
                    {typeLabel(selectedNodeDetail.node.type) || selectedNodeDetail.node.type || "미분류"}
                  </span>
                  {selectedNodeDetail.node.collection && (
                    <span className="graph-detail-chip">{selectedNodeDetail.node.collection}</span>
                  )}
                  {selectedNodeDetail.node.status && (
                    <span className="graph-detail-chip graph-detail-chip-muted">{selectedNodeDetail.node.status}</span>
                  )}
                  {selectedNodeDetail.node.vault && (
                    <span className="graph-vault-chip">{selectedNodeDetail.node.vault}</span>
                  )}
                </div>
                <strong className="graph-detail-title" style={{ display: "block", fontSize: "16px", color: "var(--color-ink)", wordBreak: "break-all" }}>
                  {selectedNodeDetail.node.title}
                </strong>
                <p className="graph-detail-slug" style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--color-muted)", wordBreak: "break-all" }}>
                  {nodeSlug(selectedNodeDetail.node)}
                </p>
                {selectedNodeDetail.node.aliases && selectedNodeDetail.node.aliases.length > 0 && (
                  <div className="graph-detail-aliases">
                    <span>별칭</span>
                    <div>
                      {selectedNodeDetail.node.aliases.slice(0, 4).map((alias) => (
                        <span key={alias} className="graph-detail-chip graph-detail-chip-muted">{alias}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 미니 액션 툴바 */}
            <div className="graph-detail-mini-actions">
              <Button
                type="button"
                className="graph-detail-action-btn"
                variant="secondary"
                size="sm"
                onClick={() => {
                  dispatchFilters({ type: "setQuery", value: selectedNodeDetail.node.title });
                  dispatchFilters({ type: "setSelectedType", value: "all" });
                }}
                title="이 문서와 1-hop 연결망 중심으로 그래프를 포커스합니다"
              >
                🎯 포커스
              </Button>
              <Button
                type="button"
                className="graph-detail-action-btn"
                variant="ghost"
                size="sm"
                onClick={() => openGraphNode(selectedNodeDetail.node.id)}
                title="문서 읽기/편집 페이지로 이동합니다"
                >
                📖 열기
              </Button>
            </div>

            {/* 이웃 깊이 — 선택한 문서가 있을 때만 의미가 있어 상세 패널에 둔다 */}
            <div className="graph-page-depth-field">
              <label className="graph-page-depth-head" htmlFor="graph-focus-depth">
                <strong>이웃 깊이</strong>
                <span>{focusDepth}촌</span>
              </label>
              <input
                id="graph-focus-depth"
                type="range"
                min={MIN_FOCUS_DEPTH}
                max={MAX_FOCUS_DEPTH}
                step={1}
                value={focusDepth}
                onChange={(e) => setFocusDepth(Number(e.target.value))}
                aria-describedby="graph-focus-depth-helper"
              />
              <span className="graph-page-depth-helper" id="graph-focus-depth-helper">
                이 촌수까지 밝게 남기고 나머지는 뒤로 물립니다.
              </span>
            </div>

            {/* 통계 기반 클릭 인터랙티브 탭 카드 */}
            <div className="graph-detail-stats">
              <button
                type="button"
                className={`graph-detail-stat-card ${activeTab === "inbound" ? "active" : ""}`}
                onClick={() => setActiveTab("inbound")}
              >
                <span>참조됨</span>
                <strong>{selectedNodeDetail.inbound.length}</strong>
              </button>
              <button
                type="button"
                className={`graph-detail-stat-card ${activeTab === "outbound" ? "active" : ""}`}
                onClick={() => setActiveTab("outbound")}
              >
                <span>참조함</span>
                <strong>{selectedNodeDetail.outbound.length}</strong>
              </button>
              <button
                type="button"
                className={`graph-detail-stat-card ${activeTab === "neighbors" ? "active" : ""}`}
                onClick={() => setActiveTab("neighbors")}
              >
                <span>관련</span>
                <strong>{selectedNodeDetail.neighbors.length}</strong>
              </button>
            </div>

            {/* 단일 관계 목록 출력 영역 */}
            <div className="graph-detail-tab-content">
              {activeTab === "inbound" && (
                <div className="graph-detail-section">
                  {selectedNodeDetail.inbound.length > 0 ? (
                    <ul className="graph-detail-list">
                      {selectedNodeDetail.inbound.slice(0, 10).map((node) => (
                        <li key={node.id}>
                          <button
                            type="button"
                            className="graph-detail-link"
                            onClick={() => dispatchFilters({ type: "setSelectedNodeId", value: node.id })}
                            onMouseEnter={() => setHoveredInsightNodeId(node.id)}
                            onMouseLeave={() => setHoveredInsightNodeId(null)}
                          >
                            <span>{node.title}</span>
                            <span className="sidebar-tree-page-pill" data-type={node.type || "unknown"}>
                              {typeLabel(node.type) || node.type || "미분류"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="graph-insight-empty">이 문서를 참조하는 문서가 없습니다.</p>
                  )}
                </div>
              )}

              {activeTab === "outbound" && (
                <div className="graph-detail-section">
                  {selectedNodeDetail.outbound.length > 0 ? (
                    <ul className="graph-detail-list">
                      {selectedNodeDetail.outbound.slice(0, 10).map((node) => (
                        <li key={node.id}>
                          <button
                            type="button"
                            className="graph-detail-link"
                            onClick={() => dispatchFilters({ type: "setSelectedNodeId", value: node.id })}
                            onMouseEnter={() => setHoveredInsightNodeId(node.id)}
                            onMouseLeave={() => setHoveredInsightNodeId(null)}
                          >
                            <span>{node.title}</span>
                            <span className="sidebar-tree-page-pill" data-type={node.type || "unknown"}>
                              {typeLabel(node.type) || node.type || "미분류"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="graph-insight-empty">이 문서가 참조하는 문서가 없습니다.</p>
                  )}
                </div>
              )}

              {activeTab === "neighbors" && (
                <div className="graph-detail-section">
                  {selectedNodeDetail.neighbors.length > 0 ? (
                    <ul className="graph-detail-list">
                      {selectedNodeDetail.neighbors.slice(0, 10).map((node) => (
                        <li key={node.id}>
                          <button
                            type="button"
                            className="graph-detail-link"
                            onClick={() => dispatchFilters({ type: "setSelectedNodeId", value: node.id })}
                            onMouseEnter={() => setHoveredInsightNodeId(node.id)}
                            onMouseLeave={() => setHoveredInsightNodeId(null)}
                          >
                            <span>{node.title}</span>
                            <span className="sidebar-tree-page-pill" data-type={node.type || "unknown"}>
                              {typeLabel(node.type) || node.type || "미분류"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="graph-insight-empty">관련된 연결 문서가 없습니다.</p>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="graph-detail-empty">
            <span className="graph-detail-empty-icon" aria-hidden="true">🕸️</span>
            <strong>문서를 선택해 주세요</strong>
            <p>그래프의 노드를 클릭하면 해당 문서의 참조 관계와 이동 도구가 여기에 표시됩니다.</p>
          </div>
        )}
      </aside>
      </div>

      {showFullGraph && graph.nodes.length > 0 && (
        <FullscreenGraphModal
          vault={vault}
          nodes={graph.nodes}
          edges={graph.edges}
          centerTitle={`${vault} 전체 그래프`}
          onClose={() => setShowFullGraph(false)}
        />
      )}
    </div>
  );
}

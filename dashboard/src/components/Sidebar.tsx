import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { NewPageButton } from "./NewPageButton";
import { NewIssueButton } from "./NewIssueButton";
import { nodeColor, typeLabel } from "./GraphCanvas";
import { RawTree } from "./RawTree";
import { SearchBar } from "./SearchBar";
import { HostPicker } from "./HostPicker";
import { Modal } from "./ui/Modal";
import { TextField } from "./ui/TextField";
import { Button } from "./ui/Button";
import { fetchDraftsList, writeRaw, type DraftListItem } from "../lib/api";
import { resolveNewRawFile } from "../lib/rawPath";
import type { TreeNode as TNode, VaultMeta } from "../types";

interface SidebarProps {
  vaults: VaultMeta[];
  trees: Record<string, TNode | null>;
  rawItems: Record<string, import("../lib/api").RawItem[]>;
  activeVault: string;
  /** v0.7.99+: 현재 PageView의 slug. 사이드바 트리에서 해당 행을 active 강조. */
  activeSlug: string | null;
  onSelectVault: (name: string) => void;
  onRefresh?: () => void;
  /** Controlled drawer state. Off-canvas only kicks in inside @media (max-width: 744px). */
  open: boolean;
  onClose: () => void;
  currentPath?: string;
}

const VAULT_OPEN_KEY = "__vault__";

// v0.7.97.4+: 사이드바 resize. 데스크탑에서만. localStorage 영속화.
const SIDEBAR_WIDTH_KEY = "raven.sidebar.width";
const SIDEBAR_WIDTH_DEFAULT = 288;
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 480;

function readSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_WIDTH_DEFAULT;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n)) return SIDEBAR_WIDTH_DEFAULT;
    return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, n));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function writeSidebarWidth(w: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
  } catch {}
}

function openFoldersStorageKey(vault: string): string {
  return `raven.sidebar.openFolders.${vault}`;
}

function readOpenFolders(vault: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(openFoldersStorageKey(vault));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeOpenFolders(vault: string, folders: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(openFoldersStorageKey(vault), JSON.stringify([...folders].sort()));
  } catch {}
}

function readFavoriteVaults(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem("raven.dashboard.favoriteVaults");
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeFavoriteVaults(favs: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("raven.dashboard.favoriteVaults", JSON.stringify([...favs]));
  } catch {}
}


const SCHEMA_TYPE_ORDER = [
  "concept",
  "rule",
  "journal",
  "issue",
  "project",
  "tool",
  "person",
  "comparison",
  "query",
] as const;

const SCHEMA_TYPE_RANK: Record<string, number> = Object.fromEntries(
  SCHEMA_TYPE_ORDER.map((type, idx) => [type, idx])
);

const CANONICAL_GROUP_PREFIX = "__canonical";
const CONTENT_ROOT = "content";
const HIDDEN_CATALOG_PATHS = new Set(["content/index"]);

function isHiddenCatalogNode(node: TNode): boolean {
  if (node.path === "content/_index" || node.path.startsWith("content/_index/")) return true;
  if (node.type === "page" && HIDDEN_CATALOG_PATHS.has(node.path)) return true;
  return false;
}

function normalizePageType(pageType?: string): string {
  const raw = (pageType ?? "").trim().toLowerCase();
  return raw && raw !== "?" ? raw : "misc";
}

function collectPages(node: TNode, out: TNode[]) {
  if (isHiddenCatalogNode(node)) return;
  if (node.type === "page") {
    out.push(node);
    return;
  }
  for (const child of node.children ?? []) collectPages(child, out);
}

export function normalizeSidebarTree(tree: TNode | null): TNode | null {
  if (!tree) return tree;
  const pages: TNode[] = [];
  collectPages(tree, pages);

  const groups = new Map<string, TNode[]>();
  for (const page of pages) {
    const type = normalizePageType(page.pageType);
    const bucket = groups.get(type) ?? [];
    bucket.push(page);
    groups.set(type, bucket);
  }

  const typeNames = [...groups.keys()].sort((a, b) => {
    const ar = SCHEMA_TYPE_RANK[a] ?? 999;
    const br = SCHEMA_TYPE_RANK[b] ?? 999;
    if (ar !== br) return ar - br;
    return a.localeCompare(b);
  });

  return {
    ...tree,
    children: typeNames.map((type) => ({
      type: "dir" as const,
      path: `${CANONICAL_GROUP_PREFIX}/${type}`,
      children: [...(groups.get(type) ?? [])].sort((a, b) =>
        displayTitle(a).localeCompare(displayTitle(b), "ko") || a.path.localeCompare(b.path)
      ),
    })),
  };
}

// v0.7.181: 사이드바 dir row "＋"(새 페이지)가 프리필할 실제 폴더 경로.
//
// normalizeSidebarTree가 만드는 `__canonical/<type>` 그룹은 SCHEMA type별 가상
// 노드다 — vault에 그런 폴더는 없다. 이 가상 path를 initialSlug로 넘기면 모달
// 경로가 `__canonical/issue`로 잡히고, 저장 시 백엔드 normalize_prefix가
// content/를 붙여 `content/__canonical/issue.md`를 만든다 (UI sentinel이
// 파일시스템에 새는 오염). 그래서 그룹은 소속 페이지들의 공통 부모 디렉토리로
// 환원하고, 공통 부모가 없으면 content/로 폴백한다.
//
// trailing slash는 의도적 — 마지막 segment가 파일명이므로 사용자가 이어서
// 입력할 자리를 남긴다 (NewPageButton의 폴더 피커 pickFolder와 같은 규약).
export function newPageTargetSlug(node: TNode): string {
  if (!node.path.startsWith(`${CANONICAL_GROUP_PREFIX}/`)) {
    return `${node.path.replace(/\/+$/, "")}/`;
  }
  const parents = (node.children ?? [])
    .filter((child) => child.type === "page")
    .map((child) => child.path.split("/").slice(0, -1))
    .filter((segments) => segments.length > 0);
  if (parents.length === 0) return `${CONTENT_ROOT}/`;
  let common = parents[0];
  for (const segments of parents.slice(1)) {
    const next: string[] = [];
    for (let i = 0; i < Math.min(common.length, segments.length); i++) {
      if (common[i] !== segments[i]) break;
      next.push(common[i]);
    }
    common = next;
  }
  return common.length > 0 ? `${common.join("/")}/` : `${CONTENT_ROOT}/`;
}

// v0.7.181: canonical 그룹 "＋"가 프리필할 문서 분류.
//
// 그룹은 SCHEMA type 그 자체다. type을 안 넘기면 issue 그룹에서 만든 페이지가
// NewPageButton 기본값(concept)으로 저장돼, 방금 누른 그룹이 아닌 "일반 노트"
// 그룹으로 들어간다. 실제 dir 노드는 type과 무관하므로 강제하지 않는다.
// (misc 같은 비-SCHEMA 값은 NewPageButton이 자기 옵션 목록으로 걸러낸다.)
export function newPageTargetType(node: TNode): string | undefined {
  if (!node.path.startsWith(`${CANONICAL_GROUP_PREFIX}/`)) return undefined;
  return node.path.split("/").pop() || undefined;
}

function findTreeAncestors(tree: TNode | null, predicate: (node: TNode) => boolean): string[] {
  if (!tree) return [];
  const stack: string[] = [];
  function visit(node: TNode): boolean {
    if (predicate(node)) return true;
    if (node.type !== "dir") return false;
    stack.push(node.path);
    for (const child of node.children ?? []) {
      if (visit(child)) return true;
    }
    stack.pop();
    return false;
  }
  return visit(tree) ? stack.filter((path) => path !== tree.path) : [];
}

function slugMatchesActive(nodeSlug: string, activeSlug: string | null): boolean {
  if (!activeSlug) return false;
  if (nodeSlug === activeSlug) return true;
  if (nodeSlug.replace(/^content\//, "") === activeSlug) return true;
  if (`content/${activeSlug}` === nodeSlug) return true;
  return false;
}

function filterTree(tree: TNode | null, query: string): TNode | null {
  const q = query.trim().toLowerCase();
  if (!tree || !q) return tree;

  function matches(node: TNode): boolean {
    if (node.path.toLowerCase().includes(q)) return true;
    if (node.type === "page") {
      const title = (node.title ?? "").toLowerCase();
      if (title.includes(q)) return true;
      const pt = (node.pageType ?? "").toLowerCase();
      if (pt.includes(q)) return true;
    }
    return false;
  }

  function visit(node: TNode): TNode | null {
    if (matches(node)) return node;
    const children = (node.children ?? []).map(visit).filter((x): x is TNode => Boolean(x));
    if (children.length > 0) return { ...node, children };
    return null;
  }

  const children = (tree.children ?? []).map(visit).filter((x): x is TNode => Boolean(x));
  return { ...tree, children };
}

export function Sidebar({
  vaults,
  trees,
  rawItems,
  activeVault,
  activeSlug,
  onSelectVault,
  onRefresh,
  open,
  onClose,
}: SidebarProps) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(() => readFavoriteVaults());

  // v0.7.97.4+: 사이드바 width + drag state. 성능 최적화 — drag 중엔 ref로 DOM 직접 조작,
  // state/commit은 drag 끝나면 1회만. 매 픽셀 React re-render 방지.
  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number>(() => readSidebarWidth());
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 744px)");
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // width 변경 시 aside DOM에 직접 반영 (state는 resize 끝나면 1회만 set)
  useEffect(() => {
    if (asideRef.current && !isMobile) {
      asideRef.current.style.width = `${width}px`;
    }
  }, [width, isMobile]);

  function toggleFavorite(name: string) {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      writeFavoriteVaults(next);
      return next;
    });
  }

  const activeVaultMeta = vaults.find((v) => v.name === activeVault);
  const activeTree = trees[activeVault] ?? null;
  // Dashboard 표준 보기: 실제 vault 폴더는 그대로 두고, 사이드바 렌더링만
  // SCHEMA 9종 type 그룹으로 canonicalize. flat / singular / plural / default 폴더
  // 차이를 UI에서 흡수하고, 자동 카탈로그(_index, content/index)는 숨긴다.
  const sidebarTree = useMemo(() => normalizeSidebarTree(activeTree), [activeTree]);
  const activeRawItems = rawItems[activeVault] ?? [];

  // v0.7.97.4+: resize drag handlers. 데스크탑에서만 활성화.
  // v0.7.97.4.1+: drag 중 setState 호출 제거 → 매 픽셀 React re-render 방지.
  // aside DOM width 직접 조작 (ref 기반), drag 끝나면 state 1회 commit + localStorage.
  function onResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    if (isMobile) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const target = e.currentTarget;
    const aside = asideRef.current;
    if (!aside) return;
    target.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    // v0.7.97.4.2+: drag 중 transition 무력화 (paint 비용 차단)
    document.body.classList.add("sidebar-resizing");

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const next = Math.min(
        SIDEBAR_WIDTH_MAX,
        Math.max(SIDEBAR_WIDTH_MIN, startWidth + dx)
      );
      // DOM 직접 — React re-render 우회
      aside.style.width = `${next}px`;
    };
    const onUp = (ev: PointerEvent) => {
      try { target.releasePointerCapture(ev.pointerId); } catch {}
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.body.classList.remove("sidebar-resizing");
      const dx = ev.clientX - startX;
      const finalWidth = Math.min(
        SIDEBAR_WIDTH_MAX,
        Math.max(SIDEBAR_WIDTH_MIN, startWidth + dx)
      );
      // drag 끝났을 때만 state 1회 commit → localStorage + 다음 mount 시 유지
      setWidth(finalWidth);
      writeSidebarWidth(finalWidth);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function onResizeDoubleClick() {
    setWidth(SIDEBAR_WIDTH_DEFAULT);
    writeSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    if (asideRef.current) {
      asideRef.current.style.width = `${SIDEBAR_WIDTH_DEFAULT}px`;
    }
  }

  return (
    <aside
      id="primary-sidebar"
      ref={asideRef}
      className={clsx(
        "layout-sidebar",
        "sidebar-offcanvas",
        open && "sidebar-offcanvas-open",
        "flex flex-col"
      )}
      style={{
        borderRight: "1px solid var(--color-hairline)",
        // v0.7.97.4.1+: width는 useEffect에서 DOM 직접 조작. 인라인은 모바일 fallback만.
        width: isMobile ? undefined : width,
        padding: "16px 16px 20px",
        background: "var(--color-canvas)",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        position: "relative",
      }}
    >
      {/* v0.7.97.4+: resize handle (desktop only) */}
      {!isMobile && (
        <div
          className="sidebar-resize-handle"
          onPointerDown={onResizeStart}
          onDoubleClick={onResizeDoubleClick}
          role="separator"
          aria-orientation="vertical"
          aria-label="사이드바 크기 조정 (더블클릭 시 기본값)"
          title="끌어서 크기 조절 · 더블클릭 시 기본값"
        />
      )}
      <div className="sidebar-top-actions">
        <button
          type="button"
          className="sidebar-close-button"
          onClick={onClose}
          aria-label="사이드바 닫기"
          title="사이드바 닫기"
        >
          ×
        </button>
      </div>

      {/* v0.7.97.3+: 사이드바는 explorer 역할로 복귀.
          nav는 헤더 아래 section nav 레일, theme는 헤더 우측, 모두 빠짐. */}

      {/* v0.7.97+: 헤더에서 이관된 전역 검색 */}
      {vaults.length > 0 && (
        <SearchBar
          vault={activeVault}
          variant="sidebar"
          onSelect={(slug) => {
            navigate(`/page/${activeVault}/${slug}`);
            onClose();
          }}
        />
      )}

      {/* Host selector */}
      <HostPicker />

      {/* Vault selector */}
      {vaults.length > 0 && (
        <div className="sidebar-vault-selector-container" style={{ marginTop: 12 }}>
          <div
            className="sidebar-label"
            style={{
              padding: "0 4px 6px",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.32px",
              color: "var(--color-muted)",
              fontFamily: "var(--font-display)",
            }}
          >
            보관소 ({vaults.length})
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select
              className="input-base"
              value={activeVault}
              onChange={(e) => onSelectVault(e.target.value)}
              aria-label="보관소 선택"
              style={{ flex: 1, margin: 0 }}
            >
              {[...vaults]
                .sort((a, b) => {
                  const aFav = favorites.has(a.name);
                  const bFav = favorites.has(b.name);
                  if (aFav && !bFav) return -1;
                  if (!aFav && bFav) return 1;
                  if (a.default && !b.default) return -1;
                  if (!a.default && b.default) return 1;
                  return a.name.localeCompare(b.name);
                })
                .map((v) => {
                  const isFav = favorites.has(v.name);
                  return (
                    <option key={v.name} value={v.name}>
                      📁 {isFav ? "⭐ " : ""}{v.name} {v.default ? "★" : ""}
                    </option>
                  );
                })}
            </select>
            <button
              type="button"
              onClick={() => toggleFavorite(activeVault)}
              className={clsx(
                "sidebar-favorite-btn",
                favorites.has(activeVault) && "sidebar-favorite-btn-active"
              )}
              title={favorites.has(activeVault) ? "즐겨찾기 해제" : "즐겨찾기 추가"}
              aria-label={favorites.has(activeVault) ? "즐겨찾기 해제" : "즐겨찾기 추가"}
            >
              ★
            </button>
          </div>
        </div>
      )}

      {vaults.length === 0 && (
        <div style={{ padding: 8, fontSize: 13, color: "var(--color-muted)", fontFamily: "var(--font-display)" }}>
          보관소 없음
        </div>
      )}

      {/* 필터 */}
      {vaults.length > 0 && (
        <label className="sidebar-filter-label" style={{ marginTop: 10 }}>
          <span className="sr-only">파일 또는 폴더 필터</span>
          <input
            className="sidebar-filter-input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="파일 또는 폴더 필터..."
            aria-label="파일 또는 폴더 필터"
          />
        </label>
      )}

      <div style={{ flex: 1, overflowY: "auto", marginTop: 12 }}>
        {activeVaultMeta ? (
          <VaultTreeGroup
            vault={activeVaultMeta}
            tree={filterTree(sidebarTree, filter)}
            isActive={true}
            showMeta={false}
            activeSlug={activeSlug}
            filterActive={filter.trim().length > 0}
            onSelect={() => {}}
            onClose={onClose}
            onRefresh={onRefresh}
          />
        ) : (
          vaults.length > 0 && (
            <div style={{ padding: 8, fontSize: 13, color: "var(--color-muted)" }}>
              보관소가 선택되지 않았습니다.
            </div>
          )
        )}

        {activeVaultMeta && (
          <div style={{ marginTop: 16 }}>
            <div
              className="sidebar-label"
              style={{
                padding: "0 4px 6px",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.32px",
                color: "var(--color-muted)",
                fontFamily: "var(--font-display)",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span>📂</span>
              <span>raw</span>
              <span style={{ marginLeft: "auto", fontWeight: 500, fontSize: 10 }}>
                {activeRawItems.length}
              </span>
              <NewRawFileButton
                vault={activeVault}
                items={activeRawItems}
                onOpen={onClose}
                onCreated={onRefresh}
              />
            </div>
            {activeRawItems.length > 0 && (
              <RawTree
                items={activeRawItems}
                selectedPath={null}
                onSelect={(path, type) => {
                  // RawTree already expands/collapses directories; only files have a viewer route.
                  if (type === "dir") return;
                  const rel = path.replace(/^raw\//, "");
                  navigate(`/raw/${activeVault}/${rel}`);
                  onClose();
                }}
                compact
              />
            )}
          </div>
        )}
      </div>

      {/* Mini Stats Widget */}
      <div style={{ marginTop: "auto", paddingTop: 16, borderTop: "1px solid var(--color-hairline)" }}>
        <SidebarStatsWidget activeVault={activeVault} />
      </div>
    </aside>
  );
}

// v0.7.98+ page 라벨 폴리시.
// 1) frontmatter title이 있으면 그대로 (정확).
// 2) title이 slug와 같거나 비어있으면 (대부분의 경우), path의 마지막 segment를
//    사람이 읽기 좋게 변환: 하이픈/언더스코어 → 공백, 선행/후행 점/공백 제거.
// 3) 그래도 빈 문자열이면 path 그대로.
function displayTitle(node: TNode): string {
  if (node.type !== "page") {
    if (node.path.startsWith(`${CANONICAL_GROUP_PREFIX}/`)) {
      const type = node.path.split("/").pop() || node.path;
      return type === "misc" ? "기타" : type;
    }
    const parts = node.path.split("/");
    return parts[parts.length - 1] || node.path;
  }
  const raw = (node.title ?? "").trim();
  if (raw && raw !== node.path) {
    // title이 있고 slug와 다른 경우 (사람이 의도적으로 title 지정) — 그대로.
    return raw;
  }
  // title이 slug와 같거나 비어있음 → 마지막 segment 폴리시.
  const parts = node.path.split("/");
  const last = parts[parts.length - 1] || node.path;
  if (!last) return node.path;
  // .md 확장자 제거 후 하이픈/언더스코어 → 공백.
  const noExt = last.replace(/\.md$/i, "");
  const humanized = noExt
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return humanized || node.path;
}

function VaultTreeGroup({
  vault,
  tree,
  isActive,
  showMeta,
  activeSlug,
  filterActive,
  onSelect,
  onClose,
  onRefresh,
}: {
  vault: VaultMeta;
  tree: TNode | null;
  isActive: boolean;
  showMeta: boolean;
  activeSlug: string | null;
  filterActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRefresh?: () => void;
}) {
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => readOpenFolders(vault.name));
  const open = openFolders.has(VAULT_OPEN_KEY);

  function toggleFolder(key: string) {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeOpenFolders(vault.name, next);
      return next;
    });
  }

  // v0.7.99+: activeSlug가 nested 폴더 안일 때 부모 폴더들 자동 펼침.
  // slug가 "content/concept/llm-wiki-패턴" → ["content", "content/concept"] 폴더 펼침.
  // VAULT_OPEN_KEY도 함께 펼침(루트 vault row 토글 = 사이드바 펼침).
  // activeSlug가 null이거나 다른 vault slug면 아무것도 안 함.
  useEffect(() => {
    if (!activeSlug) return;
    setOpenFolders((prev) => {
      const ancestors = [
        VAULT_OPEN_KEY,
        ...findTreeAncestors(tree, (node) => node.type === "page" && slugMatchesActive(node.path, activeSlug)),
      ];
      let changed = false;
      const next = new Set(prev);
      for (const a of ancestors) {
        if (!next.has(a)) { next.add(a); changed = true; }
      }
      if (changed) writeOpenFolders(vault.name, next);
      return changed ? next : prev;
    });
  }, [activeSlug, tree, vault.name]);

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        role="button"
        tabIndex={0}
        className="sidebar-vault-row"
        onClick={() => {
          toggleFolder(VAULT_OPEN_KEY);
          onSelect();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleFolder(VAULT_OPEN_KEY);
            onSelect();
          }
        }}
        aria-expanded={open}
      >
        <span aria-hidden className={clsx("sidebar-chevron", open && "sidebar-chevron-open")}>
          <svg viewBox="0 0 12 12" width="14" height="14" aria-hidden>
            <path d="M4 2 L8 6 L4 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="sidebar-vault-name">{vault.name}</span>
        <NewPageButton vault={vault.name} variant="icon" label="페이지" onOpen={onClose} />
        <NewIssueButton vault={vault.name} initialSlug={`content/issues`} onOpen={onClose} />
        {showMeta && vault.default && (
          <span className="sidebar-vault-default" aria-label="default">★</span>
        )}
        {showMeta && isActive && (
          <span className="sidebar-vault-active" aria-label="active">●</span>
        )}
      </div>

      {open && tree && (
        <div className="sidebar-tree">
          {(tree.children ?? []).map((child) => (
            <TreeLeaf
              key={child.path}
              node={child}
              vault={vault.name}
              onClose={onClose}
              activeSlug={activeSlug}
              filterActive={filterActive}
              openFolders={openFolders}
              onToggleFolder={toggleFolder}
              onRefresh={onRefresh}
              depth={1}
            />
          ))}
        </div>
      )}
      {open && (
        <DraftSection
          vault={vault.name}
          activeSlug={activeSlug}
          onClose={onClose}
        />
      )}
    </div>
  );
}

// v0.7.x+: 사이드바 raw 섹션 인라인 새 파일 생성. RawPanel.tsx의 새 파일 모달과
// 동일 패턴(파일명 + 부모 디렉토리 → writeRaw)을 재사용해 /raw/{vault} 이동 없이 생성 가능.
function NewRawFileButton({
  vault,
  items,
  onOpen,
  onCreated,
}: {
  vault: string;
  items: import("../lib/api").RawItem[];
  onOpen?: () => void;
  onCreated?: () => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [dir, setDir] = useState("raw");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dirOptions = useMemo(() => {
    const set = new Set<string>(["raw"]);
    for (const it of items) {
      if (it.type === "dir") set.add(it.path);
    }
    return [...set].sort();
  }, [items]);

  async function submit() {
    setErr(null);
    // v0.7.181: 검증은 rawPath.resolveNewRawFile 한 곳 — 특히 기존 파일을
    // writeRaw(rel, "")로 덮어써 내용을 날리는 경로를 여기서 막는다.
    const { rel, error } = resolveNewRawFile({ name, dir, items });
    if (error || !rel) {
      setErr(error);
      return;
    }
    setBusy(true);
    try {
      await writeRaw(vault, rel, "");
      setOpen(false);
      setName("");
      onCreated?.();
      navigate(`/raw/${vault}/${rel}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="sidebar-icon-action"
        onClick={(e) => {
          e.stopPropagation();
          onOpen?.();
          setOpen(true);
        }}
        aria-label={`${vault} raw/에 새 파일 만들기`}
        title={`${vault} raw/에 새 파일 만들기`}
      >
        ＋
      </button>
      {open && (
        <Modal open={open} onClose={() => !busy && setOpen(false)} disableBackdropClose={busy}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>raw/ 새 파일</h3>
            <TextField
              label="파일명"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: notes.md, source.txt"
              helper="확장자 포함. 예: my-notes.md"
            />
            <TextField
              label="부모 디렉토리"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              helper="기본 raw/. 다른 디렉토리 경로 입력 가능 (예: raw/articles)."
            />
            <details style={{ fontSize: 12, color: "var(--color-muted)" }}>
              <summary style={{ cursor: "pointer" }}>기존 디렉토리 ({dirOptions.length})</summary>
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {dirOptions.map((d) => (
                  <li key={d} style={{ cursor: "pointer" }} onClick={() => setDir(d)}>
                    {d}
                  </li>
                ))}
              </ul>
            </details>
            {err && (
              <div
                style={{
                  background: "var(--color-danger-soft, #fee)",
                  color: "var(--color-danger, #c00)",
                  padding: "8px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                ❌ {err}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)} disabled={busy}>
                취소
              </Button>
              <Button type="button" variant="primary" size="md" onClick={submit} disabled={busy || !name.trim()}>
                {busy ? "만드는 중…" : "만들기"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function DraftSection({
  vault,
  activeSlug,
  onClose,
}: {
  vault: string;
  activeSlug: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setDrafts(await fetchDraftsList(vault));
    } catch {
      // Drafts are optional; an unavailable endpoint must not break navigation.
      setDrafts([]);
    }
  }, [vault]);

  useEffect(() => {
    load();
  }, [load]);

  // 외부에서 커밋/삭제 후 갱신 이벤트를 수신해 목록 갱신
  useEffect(() => {
    const handler = () => load();
    window.addEventListener("raven-draft-changed", handler);
    return () => window.removeEventListener("raven-draft-changed", handler);
  }, [load]);

  if (drafts.length === 0) return null;

  return (
    <div style={{ marginTop: 8, borderTop: "1px solid var(--color-hairline)", paddingTop: 4 }}>
      <button
        type="button"
        className="sidebar-tree-dir-row"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ paddingLeft: 8, width: "100%" }}
        title="에이전트가 생성한 초안 목록"
      >
        <span aria-hidden className={clsx("sidebar-chevron", open && "sidebar-chevron-open")}>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            <path d="M4 2 L8 6 L4 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span aria-hidden style={{ fontSize: 13 }}>📋</span>
        <span className="sidebar-tree-dir-label">
          초안
          <span style={{
            marginLeft: 6,
            fontSize: 10,
            fontWeight: 700,
            padding: "1px 5px",
            borderRadius: 8,
            background: "var(--color-primary)",
            color: "#fff",
            verticalAlign: "middle",
          }}>{drafts.length}</span>
        </span>
      </button>
      {open && (
        <div className="sidebar-tree">
          {drafts.map((d) => {
            const isActive = activeSlug === d.slug;
            return (
              <button
                key={d.slug}
                type="button"
                className={clsx("sidebar-tree-page-row", isActive && "sidebar-tree-page-row-active")}
                onClick={() => {
                  // slug: "drafts/foo" → /page/{vault}/drafts/foo
                  navigate(`/page/${vault}/${d.slug}`);
                  onClose();
                }}
                style={{ paddingLeft: 18 }}
                title={d.title}
              >
                <span aria-hidden className="sidebar-tree-page-dot" style={{ background: "var(--color-muted)" }} />
                <span aria-hidden className="sidebar-tree-page-pill" data-type={d.type}>{d.type}</span>
                <span className="sidebar-tree-page-label">{d.title || d.filename}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TreeLeaf({
  node,
  vault,
  onClose,
  activeSlug,
  filterActive,
  openFolders,
  onToggleFolder,
  onRefresh,
  depth,
}: {
  node: TNode;
  vault: string;
  onClose: () => void;
  activeSlug: string | null;
  filterActive: boolean;
  openFolders: Set<string>;
  onToggleFolder: (k: string) => void;
  onRefresh?: () => void;
  depth: number;
}) {
  const navigate = useNavigate();
  const isOpen = openFolders.has(node.path);

  if (node.type === "dir") {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center" }}>
          <button
            type="button"
            className="sidebar-tree-dir-row"
            onClick={() => onToggleFolder(node.path)}
            aria-expanded={isOpen}
            style={{ paddingLeft: 8 + depth * 10, flex: 1 }}
          >
            <span aria-hidden className={clsx("sidebar-chevron", isOpen && "sidebar-chevron-open")}>
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
                <path d="M4 2 L8 6 L4 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span aria-hidden style={{ fontSize: 13 }}>📁</span>
            <span className="sidebar-tree-dir-label">{displayTitle(node)}</span>
          </button>
          <NewPageButton
            vault={vault}
            initialSlug={newPageTargetSlug(node)}
            initialType={newPageTargetType(node)}
            variant="icon"
            label="페이지"
            onOpen={onClose}
          />
        </div>
        {isOpen && (node.children ?? []).length > 0 && (
          <div className="sidebar-tree">
            {(node.children ?? []).map((child) => (
              <TreeLeaf
                key={child.path}
                node={child}
                vault={vault}
                onClose={onClose}
                activeSlug={activeSlug}
                filterActive={filterActive}
                openFolders={openFolders}
                onToggleFolder={onToggleFolder}
                onRefresh={onRefresh}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isActive = slugMatchesActive(node.path, activeSlug);
  const label = typeLabel(node.pageType);
  return (
    <button
      type="button"
      className={clsx("sidebar-tree-page-row", isActive && "sidebar-tree-page-row-active")}
      onClick={() => {
        navigate(`/page/${vault}/${node.path.replace(/^content\//, "")}`);
        onClose();
      }}
      onMouseEnter={() => {
        window.dispatchEvent(new CustomEvent("raven-node-hover", { detail: { id: node.path } }));
      }}
      onMouseLeave={() => {
        window.dispatchEvent(new CustomEvent("raven-node-hover", { detail: { id: null } }));
      }}
      style={{ paddingLeft: 8 + depth * 10 }}
      title={node.title ?? node.path}
    >
      <span aria-hidden className="sidebar-tree-page-dot" style={{ background: nodeColor(node.pageType) }} />
      {label && <span aria-hidden className="sidebar-tree-page-pill" data-type={node.pageType}>{label}</span>}
      <span className="sidebar-tree-page-label">{displayTitle(node)}</span>
    </button>
  );
}

function SidebarStatsWidget({ activeVault }: { activeVault: string }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        background: "var(--color-surface-soft)",
        border: "1px solid var(--color-hairline)",
        borderRadius: "var(--radius-md)",
        fontSize: 12,
        color: "var(--color-muted)",
      }}
    >
      <div style={{ fontWeight: 600, color: "var(--color-ink)", fontSize: 13, marginBottom: 2 }}>
        {activeVault || "—"}
      </div>
      <div style={{ fontFamily: "var(--font-display)" }}>현재 보관소</div>
    </div>
  );
}
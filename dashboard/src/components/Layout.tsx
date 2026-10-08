import { Outlet, Link, useLocation, useMatch, Navigate } from "react-router-dom";
import clsx from "clsx";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { UpdateChecker } from "./UpdateChecker";
import { fetchRawList, fetchVaults, fetchTree, getActiveVault, setActiveVault, type RawItem } from "../lib/api";
import { useIsCompactNav, useIsDrawerMobile } from "../lib/useMediaQuery";
import { useEffect, useState } from "react";
import type { TreeNode, VaultMeta } from "../types";

// v0.7.97.3+: 헤더에서 sub-nav 레일로 분리. 전역 섹션 nav (앱 내 페이지 전환).
// 탭 레일은 헤더 아래 별도 1줄 좌정렬. PKM "탐색 / 섹션 / 콘텐츠" 3단 분리.
export interface SectionNavEntry {
  to: string;
  label: string;
  icon: string;
  match: (pathname: string) => boolean;
}

// 레일에 놓이는 항목 수 상한. 390px에서 가로로 잘리던 원인이 8개 동일 위계였다.
export const SECTION_NAV_MAX = 5;

export const PRIMARY_NAV: SectionNavEntry[] = [
  { to: "/", label: "홈", icon: "🏠", match: (p) => p === "/" },
  { to: "/search", label: "검색", icon: "🔍", match: (p) => p.startsWith("/search") },
  { to: "/graph", label: "그래프", icon: "🕸", match: (p) => p.startsWith("/graph") },
  { to: "/garden", label: "정원", icon: "🌱", match: (p) => p.startsWith("/garden") },
];

// 운영 도구는 매일 쓰는 탐색이 아니다 → 더보기 메뉴 하위로.
export const MORE_NAV: SectionNavEntry[] = [
  { to: "/log", label: "로그", icon: "📋", match: (p) => p.startsWith("/log") },
  { to: "/lint", label: "린트", icon: "🛠", match: (p) => p.startsWith("/lint") },
  { to: "/workspace", label: "워크스페이스", icon: "💻", match: (p) => p.startsWith("/workspace") },
  { to: "/vault/manage", label: "관리", icon: "⚙", match: (p) => p.startsWith("/vault/manage") },
];

export interface SectionNavPlan {
  primary: SectionNavEntry[];
  more: SectionNavEntry[];
  /** 320/390에서는 활성 탭만 라벨을 남긴다 — 레일이 가로로 잘리지 않게. */
  compact: boolean;
  railItems: number;
}

export function planSectionNav(width: number): SectionNavPlan {
  return {
    primary: PRIMARY_NAV,
    more: MORE_NAV,
    compact: width <= 390,
    railItems: PRIMARY_NAV.length + 1,
  };
}

export function isMoreNavActive(pathname: string): boolean {
  return MORE_NAV.some((entry) => entry.match(pathname));
}

export function chooseLayoutVault(vaults: VaultMeta[], current: string, stored: string): string {
  if (current && vaults.some((v) => v.name === current)) return current;
  if (stored && vaults.some((v) => v.name === stored)) return stored;
  return vaults.find((v) => v.default)?.name || vaults[0]?.name || "";
}

export function Layout() {
  const [vault, setVault] = useState<string>(() => getActiveVault() || "");
  const [vaults, setVaults] = useState<VaultMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [trees, setTrees] = useState<Record<string, TreeNode | null>>({});
  const [rawItems, setRawItems] = useState<Record<string, RawItem[]>>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();

  // v0.7.99+: 현재 path에서 page slug 추출. /page/:vault/* 패턴에 매치될 때만.
  // Sidebar의 VaultTreeGroup activeSlug prop으로 흘러서, PageView 진입 시
  // 사이드바 트리에서 해당 문서 행이 active 강조됨 (v0.7.97 §6 후속).
  // App.tsx 라우트 정의: /page/:vault/* — wildcard `*`에 slug가 들어옴.
  const pageMatch = useMatch("/page/:vault/*");
  const activeSlug = pageMatch?.params["*"] ?? null;

  // theme state — 헤더에서 toggle
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    try {
      const stored = window.localStorage.getItem("theme");
      if (stored === "dark" || stored === "light") return stored;
    } catch {}
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    return "light";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = window.document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
      root.setAttribute("data-color-mode", "dark");
    } else {
      root.classList.remove("dark");
      root.setAttribute("data-color-mode", "light");
    }
    try { window.localStorage.setItem("theme", theme); } catch {}
  }, [theme]);

  useEffect(() => {
    fetchVaults().then((vs) => { setVaults(vs); setLoaded(true); }).catch(() => { setVaults([]); setLoaded(true); });
  }, [refreshKey]);

  useEffect(() => {
    if (vaults.length === 0) return;
    const next = chooseLayoutVault(vaults, vault, getActiveVault());
    if (!next || next === vault) return;
    setVault(next);
    setActiveVault(next);
  }, [vaults, vault]);

  useEffect(() => {
    if (vaults.length === 0) return;
    Promise.all(vaults.map((v) => fetchTree(v.name)))
      .then((results) => {
        const map: Record<string, TreeNode | null> = {};
        for (let i = 0; i < vaults.length; i++) map[vaults[i].name] = results[i];
        setTrees(map);
      });
  }, [vaults, refreshKey]);

  useEffect(() => {
    if (vaults.length === 0) return;
    Promise.all(vaults.map((v) => fetchRawList(v.name)))
      .then((results) => {
        const map: Record<string, RawItem[]> = {};
        for (let i = 0; i < vaults.length; i++) map[vaults[i].name] = results[i]?.items ?? [];
        setRawItems(map);
      });
  }, [vaults, refreshKey]);

  // 744px drawer 판정 — Sidebar와 같은 primitive를 쓴다 (중복 matchMedia 제거).
  const isMobile = useIsDrawerMobile();
  // 390px compact 판정 — raw resize listener 대신 breakpoint crossing에서만 갱신.
  const compactNav = useIsCompactNav();

  // desktop(>744px)에서는 drawer 자체가 없다 → open state를 desktop sidebar/backdrop에
  // 전달하지 않는다. CSS(트리거 숨김)와 함께 JSX도 같은 계약을 주장한다:
  // "open/close state는 mobile drawer에만 의미를 가진다."
  const drawerOpen = isMobile && mobileNavOpen;

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileNavOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);

  useEffect(() => setMoreOpen(false), [location.pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMoreOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  // Cmd+K / Ctrl+K — 커맨드 팔레트 (P0-2)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (loaded && vaults.length === 0 && location.pathname !== "/vault/new") {
    return <Navigate to="/vault/new" replace />;
  }

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));
  const navPlan = planSectionNav(compactNav ? 390 : 1024);
  const moreActive = isMoreNavActive(location.pathname);

  return (
    <div className="flex h-screen" style={{ background: "var(--color-canvas)" }}>
      <Sidebar
        vaults={vaults}
        trees={trees}
        rawItems={rawItems}
        activeVault={vault}
        activeSlug={activeSlug}
        onSelectVault={(name) => { setVault(name); setActiveVault(name); setRefreshKey((k) => k + 1); }}
        onRefresh={() => setRefreshKey((k) => k + 1)}
        open={drawerOpen}
        onClose={() => setMobileNavOpen(false)}
      />

      {drawerOpen && <div className="sidebar-backdrop" onClick={() => setMobileNavOpen(false)} aria-hidden />}

      <main className="flex-1 flex flex-col overflow-hidden" style={{ minWidth: 0 }}>
        {/* v0.7.97.3+: 헤더 — 유틸리티. brand + 현재 vault + theme만.
            가운데 안 비고, 과밀 안 됨. 탭 레일은 헤더 아래 별도 1줄. */}
        <header
          className="app-header"
          style={{
            height: 52,
            borderBottom: "1px solid var(--color-hairline)",
            background: "var(--color-canvas)",
            flexShrink: 0,
            position: "sticky",
            top: 0,
            zIndex: 50,
          }}
        >
          <div
            className="app-header-inner"
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              padding: "0 16px 0 20px",
              gap: 16,
            }}
          >
            {/* Left — 햄버거 + 브랜드 */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <button
                type="button"
                className="header-hamburger"
                onClick={() => setMobileNavOpen((v) => !v)}
                aria-label="메뉴 열기"
                aria-expanded={drawerOpen}
                aria-controls="primary-sidebar"
              >
                <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>☰</span>
              </button>
              <Link
                to="/"
                className="app-header-brand"
                style={{
                  fontSize: 17,
                  fontWeight: 700,
                  letterSpacing: "-0.2px",
                  color: "var(--color-ink)",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span aria-hidden style={{ fontSize: 18 }}>🐦</span>
                <span>Raven</span>
              </Link>
            </div>

            {/* Center spacer — 탭 레일이 헤더 바로 아래로 빠지면서 가운데에 공간이 필요 없게 됨 */}

            {/* Right — theme 토글 (slim pill) */}
            <div
              className="app-header-theme"
              style={{
                marginLeft: "auto",
                display: "flex",
                border: "1px solid var(--color-hairline)",
                borderRadius: "var(--radius-full)",
                padding: 2,
                gap: 2,
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={() => theme !== "light" && toggleTheme()}
                aria-label="라이트 테마"
                title="라이트"
                className={clsx("app-header-theme-btn", theme === "light" && "app-header-theme-btn-active")}
                style={{ fontSize: 13, padding: "4px 10px" }}
              >
                ☀️
              </button>
              <button
                type="button"
                onClick={() => theme !== "dark" && toggleTheme()}
                aria-label="다크 테마"
                title="다크"
                className={clsx("app-header-theme-btn", theme === "dark" && "app-header-theme-btn-active")}
                style={{ fontSize: 13, padding: "4px 10px" }}
              >
                🌙
              </button>
            </div>
          </div>
        </header>

        {/* Global section nav 레일 — 헤더 바로 아래 1줄 좌정렬.
            상시 노출은 탐색 4개 + 더보기 1개(운영 도구). 390px에서도 안 잘린다. */}
        <nav
          className="global-section-nav"
          aria-label="주요 섹션"
          style={{
            height: 44,
            display: "flex",
            alignItems: "center",
            gap: 2,
            padding: "0 16px 0 20px",
            background: "var(--color-canvas)",
            borderBottom: "1px solid var(--color-hairline)",
            flexShrink: 0,
            position: "sticky",
            top: 52,
            zIndex: 49,
          }}
        >
          {/* 탐색 탭만 가로 스크롤 대상 — 이 wrapper에만 overflow를 건다.
              (예전엔 overflowY:hidden이 <nav> 전체에 걸려 있어, position:absolute인
              더보기 드롭다운이 44px 높이 밖으로 나가는 순간 통째로 잘려 안 보였음.) */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              height: "100%",
              overflowX: "auto",
              overflowY: "hidden",
              minWidth: 0,
            }}
          >
            {navPlan.primary.map((t) => {
              const isActive = t.match(location.pathname);
              const showLabel = !navPlan.compact || isActive;
              return (
                <Link
                  key={t.to}
                  to={t.to}
                  className={clsx("section-nav-tab", isActive && "section-nav-tab-active")}
                  aria-current={isActive ? "page" : undefined}
                  aria-label={showLabel ? undefined : t.label}
                  title={showLabel ? undefined : t.label}
                  style={{ flexShrink: 0 }}
                >
                  <span aria-hidden style={{ fontSize: 14 }}>{t.icon}</span>
                  {showLabel && <span>{t.label}</span>}
                </Link>
              );
            })}
          </div>

          <div style={{ position: "relative", flexShrink: 0 }}>
            <button
              type="button"
              className={clsx("section-nav-tab", moreActive && "section-nav-tab-active")}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              onClick={() => setMoreOpen((v) => !v)}
            >
              <span aria-hidden style={{ fontSize: 14 }}>⋯</span>
              <span>더보기</span>
            </button>
            {moreOpen && (
              <div className="section-nav-more-panel" role="menu" aria-label="운영 도구">
                {navPlan.more.map((t) => {
                  const isActive = t.match(location.pathname);
                  return (
                    <Link
                      key={t.to}
                      to={t.to}
                      role="menuitem"
                      className={clsx("section-nav-more-item", isActive && "section-nav-tab-active")}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => setMoreOpen(false)}
                    >
                      <span aria-hidden style={{ fontSize: 14 }}>{t.icon}</span>
                      <span>{t.label}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </nav>

        <div
          className="page-content flex-1 overflow-y-auto"
          style={{
            width: "100%",
            maxWidth: 1440,
            margin: "0 auto",
            padding: "32px 40px",
            background: "var(--color-canvas)",
          }}
        >
          <Outlet
            context={{
              vault,
              refresh: () => setRefreshKey((k) => k + 1),
            }}
          />
        </div>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} vault={vault} />
      <UpdateChecker />
    </div>
  );
}
import { Outlet, Link, useLocation, useMatch, Navigate } from "react-router-dom";
import clsx from "clsx";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { UpdateChecker } from "./UpdateChecker";
import { EmptyState } from "./ui/EmptyState";
import { Button } from "./ui/Button";
import { EmptyIcon } from "../lib/emptyIcons";
import { ApiHttpError, fetchRawList, fetchVaults, fetchTree, getActiveHostUrl, getActiveVault, setActiveVault, type RawItem } from "../lib/api";
import { useIsCompactNav, useIsDrawerMobile } from "../lib/useMediaQuery";
import { useEffect, useRef, useState } from "react";
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

// Issue #30: vault 목록 조회 실패의 종류. "vault 0개"(성공한 빈 목록)와는 별개 상태다.
export type VaultsFailure =
  | { kind: "auth" }
  | { kind: "forbidden" }
  | { kind: "server"; status: number }
  | { kind: "network" };

export function classifyVaultsFailure(err: unknown): VaultsFailure {
  if (err instanceof ApiHttpError) {
    if (err.status === 401) return { kind: "auth" };
    if (err.status === 403) return { kind: "forbidden" };
    return { kind: "server", status: err.status };
  }
  return { kind: "network" };
}

function describeVaultsFailure(f: VaultsFailure): { title: string; description: string } {
  switch (f.kind) {
    case "auth":
      // 토큰 입력창은 api-base 래퍼가 띄운다(AuthTokenDialog). 여기서 모달을 또 열지 않는다.
      return {
        title: "인증이 필요합니다",
        description: "이 호스트는 접근 토큰을 요구합니다. 다시 시도하면 토큰 입력창이 열립니다.",
      };
    case "forbidden":
      return {
        title: "보관소 목록을 볼 권한이 없습니다",
        description: "Core API가 요청을 거부했습니다 (HTTP 403). 호스트 설정과 토큰을 확인하세요.",
      };
    case "server":
      return {
        title: `${f.status >= 500 ? "Core 서버 오류" : "Core 응답 오류"} (HTTP ${f.status})`,
        description: "Core가 요청을 처리하지 못했습니다. 재시작 중일 수 있으니 잠시 후 다시 시도하세요.",
      };
    case "network":
      return {
        title: "Core에 연결할 수 없습니다",
        description: "Core가 실행 중인지, 선택한 호스트 주소가 맞는지 확인하세요.",
      };
  }
}

export function Layout() {
  const [vault, setVault] = useState<string>(() => getActiveVault() || "");
  const [vaults, setVaults] = useState<VaultMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [vaultsError, setVaultsError] = useState<VaultsFailure | null>(null);
  // 지금 표시 중인 vaults를 받아 온 호스트. 실패 시 이전 목록 유지는 같은 호스트일 때만.
  const vaultsHostRef = useRef<string | null>(null);
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
    // 늦게 도착한 이전 요청(다른 호스트일 수 있음)이 최신 결과를 덮지 않게 한다.
    let stale = false;
    const host = getActiveHostUrl();
    fetchVaults()
      .then((vs) => {
        if (stale) return;
        vaultsHostRef.current = host;
        setVaults(vs);
        setVaultsError(null);
        setLoaded(true);
      })
      .catch((err) => {
        if (stale) return;
        // 같은 호스트의 일시 장애면 이전 목록을 유지한다 — 실패를 "0개"로 덮어쓰면
        // /vault/new 오인 이동이 된다. 다른 호스트의 목록은 이 호스트 것처럼 남기지 않는다.
        if (vaultsHostRef.current !== host) {
          vaultsHostRef.current = null;
          setVaults([]);
        }
        setVaultsError(classifyVaultsFailure(err));
        setLoaded(true);
      });
    return () => { stale = true; };
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
  //
  // desktop으로 crossing하면 mobile drawer state를 *폐기*한다. `&&`로 가리기만 하면
  // mobile → desktop → mobile 왕복 시 mobileNavOpen=true가 살아남아, 사용자 입력 없이
  // drawer가 다시 열린다 (PR #10 review blocker). desktop 구간에는 mobile 전용 state가
  // 남지 않아야 계약이 성립한다.
  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false);
  }, [isMobile]);

  const drawerOpen = isMobile && mobileNavOpen;

  // Escape listener는 *실제로 열려 있는* drawer에만 붙는다. desktop에서는 위 effect가
  // mobileNavOpen을 폐기하므로 잔존 listener도 남지 않는다 (같은 root cause).
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileNavOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

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

  // /vault/new 이동은 *성공한* 빈 목록에서만 (Issue #30).
  if (loaded && !vaultsError && vaults.length === 0 && location.pathname !== "/vault/new") {
    return <Navigate to="/vault/new" replace />;
  }

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));
  // vault 이름은 localStorage에서 오므로 다른 호스트의 것일 수 있다. 지금 표시 중인 목록에
  // 있을 때만 사이드바·팔레트로 내린다 — B 실패 화면에 A의 vault를 "현재 보관소"로 보이거나
  // 팔레트가 그 이름으로 B에 요청하지 않게.
  const listedVault = vaults.some((v) => v.name === vault) ? vault : "";
  const navPlan = planSectionNav(compactNav ? 390 : 1024);
  const moreActive = isMoreNavActive(location.pathname);

  return (
    <div className="flex h-screen" style={{ background: "var(--color-canvas)" }}>
      <Sidebar
        vaults={vaults}
        trees={trees}
        rawItems={rawItems}
        activeVault={listedVault}
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
            // Issue #9: header는 어떤 scroll container의 descendant도 아니다.
            // 실제 scrollport는 sibling인 .page-content(overflow-y-auto)이고,
            // 조상인 main은 overflow-hidden(스크롤 없음)이다. 따라서 sticky/top은
            // offset될 대상이 없어 무효였다. 남는 의도는 "page content 위로 뜨는
            // layering"뿐이므로 relative + z-index로 표현한다 (static이면 z-index 무시).
            position: "relative",
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
                onClick={() => {
                  // toggle은 mobile drawer 전용이다. desktop에서 활성화되면
                  // mobileNavOpen=true가 latch되고, 나중에 mobile 구간으로
                  // crossing하는 순간 사용자 입력 없이 drawer가 열린다
                  // (위 effect가 막으려는 것과 같은 stale state). CSS가 햄버거를
                  // 숨기더라도 state 경로 자체를 mobile로 제한한다.
                  if (isMobile) setMobileNavOpen((v) => !v);
                }}
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
            // Issue #9: nav도 scroll container 밖(sibling .page-content가 스크롤 담당)이라
            // sticky/top이 무효였다. z-index는 "더보기" 드롭다운이 page content 위에 뜨는
            // 근거로 필요하므로 relative로 유지한다.
            position: "relative",
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
          {vaultsError && (
            <div role="alert" style={{ marginBottom: 24 }}>
              <EmptyState
                icon={<EmptyIcon.AlertTriangle />}
                {...describeVaultsFailure(vaultsError)}
                action={
                  <Button variant="primary" onClick={() => setRefreshKey((k) => k + 1)}>
                    다시 시도
                  </Button>
                }
              />
            </div>
          )}
          {/* 목록을 한 번도 못 받았으면 하위 페이지를 띄우지 않는다 — vault 없는 화면이
              "등록된 vault가 없습니다"로 오인되는 것을 막는다. 이전 목록이 있으면 유지. */}
          {(!vaultsError || vaults.length > 0) && (
            <Outlet
              context={{
                vault,
                refresh: () => setRefreshKey((k) => k + 1),
              }}
            />
          )}
        </div>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} vault={listedVault} />
      <UpdateChecker />
    </div>
  );
}
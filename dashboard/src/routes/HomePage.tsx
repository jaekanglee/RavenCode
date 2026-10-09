import { Link, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  fetchPages,
  fetchVaults,
  getActiveVault,
  setActiveVault as setActiveVaultLS,
  type VaultInfo,
} from "../lib/api";
import { NewPageInline } from "../components/NewPageInline";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";

/**
 * HomePage — v0.7.181+: 오늘의 작업대 (최근 문서 · 손볼 문서 · 건간 삼단).
 *   보감소 목록은 맨 아래로 내리고, test/tmp 스크래치 vault는 기본 숨김.
 *
 * 이전(v0.6.10 P16): 종합 홈 (vault 미선택).
 *
 * 이전: HomePage가 useOutletContext<{vault}>로 활성 vault를 받아 그 vault
 *   한 곳의 페이지/통계만 표시 = "vault 운영 콘솔"로 동작.
 * 변경: Home = "vault를 선택하거나 새로 만드는 곳"으로 재정의.
 *   - 활성 vault에 의존 ❌ (outlet context 무시)
 *   - 모든 vault 카드 리스트 (GET /api/vaults + 각 stats)
 *   - hero: "vault를 선택하거나 새로 만드세요"
 *   - Quick Actions는 vault 선택 시 활성화, 미선택 시 disabled + 안내
 *
 * Desktop (≥745px):
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Hero: "Raven — vault를 선택하거나 새로 만드세요"        │
 *   │  Quick Actions (4-up grid; 미선택 vault 시 disabled)    │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  Vaults (3-col grid of cards)                           │
 *   │   · 각 카드: 이름, 모드, 페이지 수, 깨진 링크, 로그     │
 *   │   · 클릭 → /vault/manage 또는 /page/<vault>/content/.. │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Mobile (≤744px): 1-col stack.
 */

interface VaultStats {
  ok: boolean;
  vault: string;
  pages: number;
  size_bytes: number;
  log_entries: number;
  broken_links: number;
}

interface VaultWithStats {
  meta: VaultInfo;
  stats: VaultStats | null;
  statsError?: string;
}

// VaultMeta = VaultInfo (lib/api의 정식 이름 사용)
type VaultMeta = VaultInfo;

interface QuickAction {
  to: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  primary?: boolean;
  primaryWithoutVault?: boolean;
  requiresVault?: boolean;
}

// Lucide-style SVG icons (v0.7.69+): 이모지 ❌ (OS별 렌더링 차이, 다크모드 깨짐)
// → inline SVG (currentColor → var(--color-ink) 자동 적용, hover 시 var(--color-accent)).
// InlineMarkdownEditor Icon 패턴과 동일 — 24x24 viewBox, stroke 2.
const ActionIcon = {
  Search: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  ),
  Plus: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  ),
  Graph: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M8.5 7.5 15.5 16.5" />
      <path d="M15.5 7.5 8.5 16.5" />
      <path d="M9 6h6" />
      <path d="M9 18h6" />
    </svg>
  ),
};

const ACTIONS: QuickAction[] = [
  {
    to: "/search",
    label: "검색",
    description: "활성 vault 전체 BM25",
    icon: <ActionIcon.Search />,
    requiresVault: true,
  },
  {
    to: "/vault/new",
    label: "새 vault",
    description: "지금 만드는 새 vault",
    icon: <ActionIcon.Plus />,
    primaryWithoutVault: true,
  },
  {
    to: "/graph",
    label: "그래프",
    description: "vault 페이지 연결",
    icon: <ActionIcon.Graph />,
    requiresVault: true,
  },
];

// Plan v1 묶음 B: "새 페이지" Quick Action — onClick으로 인라인 폼을 토글한다.
interface NewPageAction {
  kind: "new-page";
  label: string;
  description: string;
  icon: string;
  requiresVault: true;
}

const MOBILE_MQ = "(max-width: 744px)";

export interface HomePageSummary {
  slug: string;
  title?: string;
  type?: string;
  status?: string;
  updated?: string;
}

const SCRATCH_NAME = /(^|[-_])(test|tests|tmp|temp|scratch|fixture|sample)([-_]|\d|$)/i;
const SCRATCH_PATH = /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/)/;

// 사람용 목록과 테스트/임시 생성물을 섞지 않기 위한 식별 신호 (이름 + 임시 디렉토리 경로).
export function isScratchVault(meta: { name: string; path?: string }): boolean {
  return SCRATCH_NAME.test(meta.name) || SCRATCH_PATH.test(meta.path ?? "");
}

export function pickRecentPages<T extends HomePageSummary>(pages: T[], limit = 6): T[] {
  return [...pages]
    .sort((a, b) => {
      const diff = (b.updated ?? "").trim().localeCompare((a.updated ?? "").trim());
      return diff !== 0 ? diff : (a.title ?? a.slug).localeCompare(b.title ?? b.slug);
    })
    .slice(0, limit);
}

// SCHEMA.md status 4종 중 사람이 손봐야 하는 것은 stale/contested — archived는 거리지 않는다.
export function pickUnfinishedPages<T extends HomePageSummary>(pages: T[], limit = 6): T[] {
  return pickRecentPages(
    pages.filter((p) => p.status === "stale" || p.status === "contested"),
    limit,
  );
}

export function HomePage() {
  const [vaults, setVaults] = useState<VaultWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  // Issue #30: 목록 조회 실패는 "vault 0개"와 다르다 — 첫 vault 만들기 CTA를 띄우지 않는다.
  const [loadFailed, setLoadFailed] = useState(false);
  const [activeVault, setActiveVault] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [pages, setPages] = useState<HomePageSummary[]>([]);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [showScratch, setShowScratch] = useState(false);
  // Plan v1 묶음 B (Tasks 5-7): 인라인 폼 트리거.
  const [showNewPageForm, setShowNewPageForm] = useState(false);
  const navigate = useNavigate();

  // ─── viewport ────────────────────────────────────────
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_MQ);
    setIsMobile(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "n") return;
      if (!activeVault) return;
      e.preventDefault();
      setShowNewPageForm(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activeVault]);

  // ─── data fetch: vaults + per-vault stats ─────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      let metas: Awaited<ReturnType<typeof fetchVaults>>;
      try {
        metas = await fetchVaults();
      } catch {
        if (!cancelled) {
          setLoadFailed(true);
          setLoading(false);
        }
        return;
      }
      if (cancelled) return;
      // active vault: localStorage(Sidebar/VaultPicker 동기화) → default → first
      const stored = getActiveVault();
      const active =
        (stored && metas.find((v) => v.name === stored)?.name) ||
        metas.find((v) => v.default)?.name ||
        metas[0]?.name ||
        null;
      setActiveVault(active);
      // stats fetch in parallel
      const enriched = await Promise.all(
        metas.map(async (meta): Promise<VaultWithStats> => {
          try {
            const r = await fetch(
              `/api/vaults/${encodeURIComponent(meta.name)}/stats`
            );
            if (!r.ok) {
              return { meta, stats: null, statsError: `HTTP ${r.status}` };
            }
            const s = (await r.json()) as VaultStats;
            return { meta, stats: s };
          } catch (e: any) {
            return { meta, stats: null, statsError: e?.message ?? "fetch error" };
          }
        })
      );
      if (cancelled) return;
      setVaults(enriched);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = useMemo(
    () =>
      [...vaults].sort((a, b) => {
        // default first, then by name
        if (a.meta.default !== b.meta.default) return a.meta.default ? -1 : 1;
        return a.meta.name.localeCompare(b.meta.name);
      }),
    [vaults]
  );

  useEffect(() => {
    if (!activeVault) {
      setPages([]);
      return;
    }
    let cancelled = false;
    setPagesLoading(true);
    fetchPages(activeVault)
      .then((rows: HomePageSummary[]) => {
        if (!cancelled) setPages(rows ?? []);
      })
      .catch(() => {
        if (!cancelled) setPages([]);
      })
      .finally(() => {
        if (!cancelled) setPagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeVault]);

  const recentPages = useMemo(() => pickRecentPages(pages), [pages]);
  const unfinishedPages = useMemo(() => pickUnfinishedPages(pages), [pages]);
  const activeStats = useMemo(
    () => vaults.find((v) => v.meta.name === activeVault)?.stats ?? null,
    [vaults, activeVault]
  );
  const scratchVaults = useMemo(() => sorted.filter((v) => isScratchVault(v.meta)), [sorted]);
  const visibleVaults = useMemo(
    () => (showScratch ? sorted : sorted.filter((v) => !isScratchVault(v.meta))),
    [sorted, showScratch]
  );

  return (
    <div style={{ maxWidth: 1120 }}>
      {/* ─── Hero ──────────────────────────────────────────── */}
      <section
        style={{
          paddingTop: isMobile ? 8 : 16,
          paddingBottom: isMobile ? 24 : 40,
        }}
      >
        <PageHeader
          title="오늘의 작업대"
          titleSize={isMobile ? 22 : 30}
          bottomSpacing={0}
          subtitle={
            loading
              ? "보감소를 불러오는 중…"
              : loadFailed
              ? "보관소 목록을 불러오지 못했습니다."
              : vaults.length === 0
              ? "아직 등록된 보감소가 없습니다. 새 vault를 만들어 시작하세요."
              : activeVault
              ? `${activeVault} · 바로 이어서 쓰거나 손볼 문서를 고르세요.`
              : "보감소를 선택하면 오늘 쓸 문서가 여기 오릅니다."
          }
        />
      </section>

      {/* ─── Quick actions ─────────────────────────────────── */}
      <section style={{ paddingBottom: isMobile ? 24 : 40 }}>
        <h2
          style={{
            fontSize: 14,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.32px",
            color: "var(--color-muted)",
            marginBottom: 16,
          }}
        >
          빠른 액션
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile
              ? "repeat(2, 1fr)"
              : "repeat(4, 1fr)",
            gap: 12,
          }}
        >
          <NewPageCard
            isMobile={isMobile}
            disabled={!activeVault}
            active={showNewPageForm}
            primary={Boolean(activeVault)}
            onToggle={() => setShowNewPageForm((v) => !v)}
          />
          {ACTIONS.map((a) => (
            <ActionCard
              key={a.to}
              action={a}
              isMobile={isMobile}
              disabled={Boolean(a.requiresVault) && !activeVault}
              primary={
                a.primaryWithoutVault ? !activeVault : Boolean(a.primary)
              }
            />
          ))}
        </div>
        {!activeVault && vaults.length > 0 && (
          <p
            className="text-muted"
            style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}
          >
            💡 vault를 선택하면 검색·그래프·디제스트가 활성화됩니다.
          </p>
        )}
      </section>

      {/* ─── Inline new-page form (묶음 B, Tasks 5-7) ─────── */}
      {showNewPageForm && activeVault && (
        <NewPageInline
          vault={activeVault}
          onClose={() => setShowNewPageForm(false)}
        />
      )}

      {activeVault && (
        <section style={{ paddingBottom: isMobile ? 24 : 40 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
              gap: 12,
            }}
          >
            <PageQueue
              heading="최근 문서"
              emptyText={pagesLoading ? "불러오는 중…" : "아직 문서가 없습니다."}
              vault={activeVault}
              pages={recentPages}
            />
            <PageQueue
              heading="손볼 문서"
              emptyText={pagesLoading ? "불러오는 중…" : "stale·contested 문서가 없습니다."}
              vault={activeVault}
              pages={unfinishedPages}
              showStatus
            />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 8,
              marginTop: 12,
            }}
          >
            <Stat label="페이지" value={activeStats ? activeStats.pages : "—"} />
            <Stat
              label="깨진 링크"
              value={activeStats ? activeStats.broken_links : "—"}
              tone={activeStats && activeStats.broken_links > 0 ? "warn" : "default"}
            />
            <Stat
              label="손볼 문서"
              value={pagesLoading ? "—" : unfinishedPages.length}
              tone={unfinishedPages.length > 0 ? "warn" : "default"}
            />
          </div>
        </section>
      )}

      {/* ─── Vaults ────────────────────────────────────────── */}
      <section style={{ paddingBottom: 64 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >          <h2 style={{ fontSize: 18 }}>
            보관소{" "}
            <span
              className="text-muted"
              style={{ fontSize: 13, fontWeight: 400 }}
            >
              ({visibleVaults.length})
            </span>
          </h2>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {scratchVaults.length > 0 && (
              <Button
                variant="pill"
                onClick={() => setShowScratch((v) => !v)}
                aria-pressed={showScratch}
                style={{ fontSize: 12 }}
              >
                {showScratch ? "스크래치 숨기기" : `스크래치 ${scratchVaults.length}개 보기`}
              </Button>
            )}
            <Link
              to="/vault/manage"
              className="link-muted"
              style={{ fontSize: 13 }}
            >
              vault 관리 →
            </Link>
          </div>
        </div>

        {loading ? (
          <p className="text-muted">불러오는 중…</p>
        ) : loadFailed ? (
          <p className="text-muted">보관소 목록을 불러오지 못했습니다.</p>
        ) : visibleVaults.length === 0 ? (
          <div className="card-flat" style={{ padding: 24, borderRadius: 8 }}>
            <p className="text-muted" style={{ marginBottom: 12 }}>
              등록된 vault가 없습니다.
            </p>
            <Link
              to="/vault/new"
              className="btn-pill-primary"
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <ActionIcon.Plus />첫 vault 만들기
            </Link>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile
                ? "1fr"
                : "repeat(auto-fill, minmax(300px, 1fr))",
              gap: 12,
            }}
          >
            {visibleVaults.map((v) => (
              <VaultCard
                key={v.meta.name}
                v={v}
                isMobile={isMobile}
                isActive={v.meta.name === activeVault}
                onOpen={async () => {
                  setActiveVaultLS(v.meta.name);
                  setActiveVault(v.meta.name);
                  // 옛 vault는 content/index 없음. 첫 페이지 또는 manage로 fallback.
                  try {
                    const r = await fetch(
                      `/api/vaults/${encodeURIComponent(v.meta.name)}/pages?top_k=1`
                    );
                    const d = await r.json();
                    const slug = d?.pages?.[0]?.slug;
                    if (slug) {
                      navigate(`/page/${encodeURIComponent(v.meta.name)}/${slug}`);
                    } else {
                      navigate(`/vault/manage`);
                    }
                  } catch {
                    navigate(`/vault/manage`);
                  }
                }}
                onManage={() => navigate("/vault/manage")}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ────────────────────────── sub-components ────────────────────────

function PageQueue({
  heading,
  emptyText,
  vault,
  pages,
  showStatus = false,
}: {
  heading: string;
  emptyText: string;
  vault: string;
  pages: HomePageSummary[];
  showStatus?: boolean;
}) {
  return (
    <section className="card-flat" style={{ padding: 16, borderRadius: 8 }} aria-label={heading}>
      <h2 style={{ fontSize: 15, marginBottom: 10 }}>{heading}</h2>
      {pages.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
          {emptyText}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {pages.map((page) => (
            <li key={page.slug}>
              <Link
                to={`/page/${encodeURIComponent(vault)}/${page.slug}`}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  color: "var(--color-ink)",
                  textDecoration: "none",
                  fontSize: 14,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {page.title || page.slug}
                </span>
                {showStatus && page.status && (
                  <span
                    className="chip"
                    style={{
                      fontSize: 10,
                      background: "var(--color-warning-bg)",
                      color: "var(--color-warning-text)",
                    }}
                  >
                    {page.status}
                  </span>
                )}
                {page.updated && (
                  <span className="text-muted" style={{ fontSize: 11, marginLeft: "auto", flexShrink: 0 }}>
                    {page.updated}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


function ActionCard({
  action,
  isMobile,
  disabled,
  primary,
}: {
  action: QuickAction;
  isMobile: boolean;
  disabled: boolean;
  primary: boolean;
}) {
  const base: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    textAlign: "left",
    padding: isMobile ? 16 : 20,
    background: "var(--color-canvas)",
    border: "1px solid var(--color-hairline)",
    borderRadius: 8,
    minHeight: isMobile ? 88 : 96,
    color: "var(--color-ink)",
    textDecoration: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    transition:
      "box-shadow 0.12s ease, transform 0.12s ease, border-color 0.12s ease",
    opacity: disabled ? 0.45 : 1,
    pointerEvents: disabled ? "none" : "auto",
  };
  if (primary) {
    base.border = "1.5px solid var(--color-primary)";
    base.background = "var(--color-primary-bg)";
  }
  return (
    <Link
      to={action.to}
      style={base}
      data-primary={primary || undefined}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        if (disabled) e.preventDefault();
      }}
      onMouseEnter={(e) => {
        if (isMobile || disabled) return;
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = "var(--shadow-card)";
        el.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = "none";
        el.style.transform = "none";
      }}
    >
      <div
        style={{
          fontSize: isMobile ? 20 : 22,
          marginBottom: 6,
          lineHeight: 1,
        }}
        aria-hidden
      >
        {action.icon}
      </div>
      <div
        style={{
          fontSize: isMobile ? 14 : 15,
          fontWeight: 600,
          marginBottom: 2,
        }}
      >
        {action.label}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--color-muted)",
          lineHeight: 1.3,
        }}
      >
        {action.description}
      </div>
    </Link>
  );
}

function VaultCard({
  v,
  isMobile,
  isActive,
  onOpen,
  onManage,
}: {
  v: VaultWithStats;
  isMobile: boolean;
  isActive: boolean;
  onOpen: () => void;
  onManage: () => void;
}) {
  const s = v.stats;
  const bytesKb = s ? Math.max(1, Math.round(s.size_bytes / 1024)) : null;
  return (
    <div
      className="card-flat"
      style={{
        padding: isMobile ? 16 : 18,
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        border: isActive
          ? "1.5px solid var(--color-primary)"
          : undefined,
        transition:
          "box-shadow 0.12s ease, transform 0.12s ease, border-color 0.12s ease",
      }}
      onMouseEnter={(e) => {
        if (isMobile) return;
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = "var(--shadow-card)";
        el.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = "none";
        el.style.transform = "none";
      }}
    >
      {/* header: name + badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: isMobile ? 16 : 17,
            fontWeight: 700,
            color: "var(--color-ink)",
          }}
        >
          {v.meta.name}
        </span>
        {v.meta.default && (
          <span
            className="chip"
            style={{ fontSize: 10, background: "var(--color-info-bg)", color: "var(--color-info-text)" }}
          >
            default
          </span>
        )}
        {isActive && (
          <span
            className="chip"
            style={{ fontSize: 10, background: "var(--color-success-bg)", color: "var(--color-success-text)" }}
          >
            active
          </span>
        )}
        <span
          className="chip"
          style={{
            fontSize: 10,
            marginLeft: "auto",
            background: "var(--color-surface-soft)",
            color: "var(--color-muted)",
          }}
        >
          {v.meta.mode}
        </span>
      </div>

      {/* path */}
      <div
        style={{
          fontSize: 11,
          color: "var(--color-muted)",
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {v.meta.path}
      </div>

      {/* stats row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 8,
          marginTop: 4,
        }}
      >
        <Stat label="페이지" value={s ? s.pages : "—"} />
        <Stat
          label="깨진 링크"
          value={s ? s.broken_links : "—"}
          tone={s && s.broken_links > 0 ? "warn" : "default"}
        />
        <Stat
          label="용량"
          value={bytesKb !== null ? `${bytesKb} KB` : "—"}
          hint={s ? `${s.log_entries} log` : undefined}
        />
      </div>

      {v.statsError && (
        <div style={{ fontSize: 11, color: "var(--color-danger-text)" }}>
          stats 오류: {v.statsError}
        </div>
      )}

      {/* actions */}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 6,
        }}
      >
        <Button variant="pillPrimary" onClick={onOpen} style={{ flex: 1, fontSize: 13 }}>
          열기
        </Button>
        <Button variant="pill" onClick={onManage} style={{ flex: 1, fontSize: 13 }}>
          관리
        </Button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: string;
  value: string | number;
  tone?: "default" | "warn";
  hint?: string;
}) {
  const color =
    tone === "warn" ? "var(--color-warning-text)" : "var(--color-ink, #161616)";
  return (
    <div
      style={{
        padding: "6px 8px",
        background: "var(--color-surface-soft)",
        borderRadius: 4,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: "var(--color-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.3px",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          color,
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: 10, color: "var(--color-muted)" }}>
          {hint}
        </div>
      )}
    </div>
  );
}

// ─── 묶음 B: "새 페이지" Quick Action 카드 ──────────────────
// ActionCard와 동일 비주얼이지만 Link가 아닌 button — 클릭 시 인라인 폼 토글.
function NewPageCard({
  isMobile,
  disabled,
  active,
  primary,
  onToggle,
}: {
  isMobile: boolean;
  disabled: boolean;
  active: boolean;
  primary: boolean;
  onToggle: () => void;
}) {
  const base: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    textAlign: "left",
    padding: isMobile ? 16 : 20,
    background: active || primary
      ? "var(--color-primary-bg)"
      : "var(--color-canvas)",
    border: active || primary
      ? "1.5px solid var(--color-primary)"
      : "1px solid var(--color-hairline)",
    borderRadius: 8,
    minHeight: isMobile ? 88 : 96,
    color: "var(--color-ink)",
    textDecoration: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    transition:
      "box-shadow 0.12s ease, transform 0.12s ease, border-color 0.12s ease",
    opacity: disabled ? 0.45 : 1,
    pointerEvents: disabled ? "none" : "auto",
    fontFamily: "inherit",
    width: "100%",
  };
  return (
    <button
      type="button"
      style={base}
      data-primary={primary || undefined}
      aria-disabled={disabled || undefined}
      aria-pressed={active}
      onClick={() => {
        if (disabled) return;
        onToggle();
      }}
      onMouseEnter={(e) => {
        if (isMobile || disabled) return;
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = "var(--shadow-card)";
        el.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = "none";
        el.style.transform = "none";
      }}
    >
      <div
        style={{
          fontSize: isMobile ? 20 : 22,
          marginBottom: 6,
          lineHeight: 1,
        }}
        aria-hidden
      >
        {active ? "✕" : "➕"}
      </div>
      <div
        style={{
          fontSize: isMobile ? 14 : 15,
          fontWeight: 600,
          marginBottom: 2,
        }}
      >
        {active ? "폼 닫기" : "새 페이지"}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--color-muted)",
          lineHeight: 1.3,
        }}
      >
        {active ? "인라인 폼이 열려 있습니다" : "인라인 폼으로 만들기"}
      </div>
    </button>
  );
}

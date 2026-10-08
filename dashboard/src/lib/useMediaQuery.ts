import { useSyncExternalStore } from "react";

/**
 * Responsive breakpoint SOT (dashboard).
 *
 * 여기 숫자가 사이드바/drawer 계약의 단일 출처다. globals.css의 미디어 쿼리와
 * 반드시 일치해야 하며, `Layout.responsive-contract.test.ts`가 실제 shipped
 * stylesheet를 읽어 두 값이 어긋나면 RED가 된다.
 *
 *   DRAWER_MQ — 사이드바 drawer 경계. desktop(>744px)은 in-flow 상시 노출,
 *               mobile(≤744px)은 off-canvas drawer (hamburger·backdrop·×).
 *   COMPACT_NAV_MQ — 390 이하에서만 섹션 nav가 아이콘 위주로 접힌다.
 */
export const DRAWER_MQ = "(max-width: 744px)";
export const COMPACT_NAV_MQ = "(max-width: 390px)";

function noopUnsubscribe(): void {}

/**
 * query별 *stable* subscribe. 같은 query에 대해 항상 같은 함수 identity를 돌려준다.
 *
 * useSyncExternalStore는 subscribe identity가 바뀌면 재구독하므로, 매 render
 * 새 closure를 넘기면 Layout의 무관한 state 변화(햄버거 클릭 등)마다 media query
 * 구독이 해제/재등록된다 (PR #10 review에서 지적된 churn). 캐시로 identity를
 * 고정해 그 churn을 없앤다.
 */
const subscribeCache = new Map<string, (onChange: () => void) => () => void>();

function subscribeTo(query: string): (onChange: () => void) => () => void {
  const cached = subscribeCache.get(query);
  if (cached) return cached;

  // MediaQueryList는 값이 바뀔 때만 "change"를 알린다 (resize마다 ❌).
  const subscribe = (onChange: () => void): (() => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return noopUnsubscribe;
    }
    const mql = window.matchMedia(query);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  };
  subscribeCache.set(query, subscribe);
  return subscribe;
}

/** query별 *stable* getSnapshot. identity가 고정돼야 매 render 재구독이 없다. */
const snapshotCache = new Map<string, () => boolean>();

function snapshotFor(query: string): () => boolean {
  const cached = snapshotCache.get(query);
  if (cached) return cached;

  const getSnapshot = (): boolean => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(query).matches;
  };
  snapshotCache.set(query, getSnapshot);
  return getSnapshot;
}

/** SSR/비브라우저 환경의 보수적 기본값 (기존 초기값과 동일). */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * breakpoint *crossing* 때만 state가 바뀐다. 같은 구간 안에서 창을 resize해도
 * React re-render가 발생하지 않는다 (raw resize listener 대체).
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(subscribeTo(query), snapshotFor(query), getServerSnapshot);
}

/** true = mobile drawer 구간 (≤744px). */
export function useIsDrawerMobile(): boolean {
  return useMediaQuery(DRAWER_MQ);
}

/** true = compact 섹션 nav 구간 (≤390px). */
export function useIsCompactNav(): boolean {
  return useMediaQuery(COMPACT_NAV_MQ);
}

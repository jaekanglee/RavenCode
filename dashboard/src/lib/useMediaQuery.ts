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

/** MediaQueryList는 값이 바뀔 때만 구독자에게 알린다 (resize마다 ❌). */
function subscribe(mql: MediaQueryList, onChange: () => void): () => void {
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * breakpoint *crossing* 때만 state가 바뀐다. 같은 구간 안에서 창을 resize해도
 * React re-render가 발생하지 않는다 (raw resize listener 대체).
 *
 * SSR/비브라우저 환경에서는 false로 시작한다 (기존 초기값과 동일한 보수적 기본).
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {};
      }
      return subscribe(window.matchMedia(query), onChange);
    },
    () => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return false;
      }
      return window.matchMedia(query).matches;
    },
    () => false,
  );
}

/** true = mobile drawer 구간 (≤744px). */
export function useIsDrawerMobile(): boolean {
  return useMediaQuery(DRAWER_MQ);
}

/** true = compact 섹션 nav 구간 (≤390px). */
export function useIsCompactNav(): boolean {
  return useMediaQuery(COMPACT_NAV_MQ);
}

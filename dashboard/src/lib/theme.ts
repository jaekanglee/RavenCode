// Issue #32 잔여: 테마(색 모드) 적용의 단일 소유자.
//
// 수정 전에는 `Layout.tsx`만 `html.dark` 클래스와 `data-color-mode` 속성을 설정했다.
// 그런데 원격 호스트 설정이 깨졌을 때는 `HostConfigGate`가 Layout *대신* 그려지므로
// (요청을 보내는 화면을 그리지 않기 위해) 그 화면에는 테마가 적용되지 않았다 —
// 다크 모드 사용자가 흰 오류 화면을 보게 된다.
//
// 저장 키(`theme`)는 `index.html`의 `boot-theme.js`(React 마운트 전 배경)와 같아야 한다.

export const THEME_STORAGE_KEY = "theme";

export type ColorMode = "light" | "dark";

/** 저장된 테마를 읽고, 없으면 OS 설정을 따른다. Layout의 기존 초기화 로직과 동일한 규칙. */
export function readStoredColorMode(): ColorMode {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {}
  if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

/** 색 모드를 문서 루트에 적용한다. globals.css의 `[data-color-mode="dark"]` 토큰 override를 켠다. */
export function applyColorMode(mode: ColorMode): void {
  if (typeof window === "undefined") return;
  const root = window.document.documentElement;
  if (mode === "dark") {
    root.classList.add("dark");
    root.setAttribute("data-color-mode", "dark");
  } else {
    root.classList.remove("dark");
    root.setAttribute("data-color-mode", "light");
  }
}

/** 색 모드를 저장한다 (헤더 토글이 사용). */
export function persistColorMode(mode: ColorMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {}
}

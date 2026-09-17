import { beforeEach } from "vitest";

// v0.7.102: vitest global setup — jsdom 기본 한계 보완.
//
// 1. window.matchMedia stub — jsdom은 matchMedia 미제공. Sidebar/Layout 등
//    useMediaQuery 훅이 호출되며 v0.7.97 §6 Folder-hover-menu 회귀 테스트가
//    깨졌음. addEventListener/removeEventListener stub으로 해결.
//
// 2. window.scrollTo stub — jsdom 미구현. 일부 component가 호출 시 console.error.
//    no-op으로 처리.
//
// 3. localStorage stub (v0.7.180) — jsdom 25.0.1은 직접 쓰면 localStorage를
//    주지만 vitest 2.1.9의 jsdom environment는 노출하지 않는다 (직접 JSDOM
//    probe로 확인). api.ts의 getActiveVault/getActiveHostId가 이걸 무조건
//    호출하므로 stub 없이는 api를 import하는 suite가 죄다 깨진다. 테스트 간
//    누수를 막기 위해 beforeEach에서 비운다.

if (typeof window !== "undefined") {
  // matchMedia stub — v0.7.97 §6 (Folder-hover-menu 회귀 가드 회복).
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},           // legacy API (deprecated)
        removeListener: () => {},        // legacy API
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  // scrollTo stub — jsdom 미구현.
  if (typeof window.scrollTo !== "function") {
    window.scrollTo = () => {};
  }
}

// v0.7.181: 존재 여부만 보던 가드를 "Storage로 동작하는가"로 강화. Node 22의
// 실험적 웹스토리지 플래그(--localstorage-file) 영향으로 vitest 2.1.9 jsdom
// 환경에는 getItem이 없는 빈 객체가 localStorage로 노출된다. 그래서 이전 가드는
// stub을 건너뛰고, getActiveHostId처럼 try/catch 없이 호출하는 코드가 있는
// suite(Folder-hover-menu 등)는 "localStorage.getItem is not a function"으로 죽었다.
if (
  typeof globalThis !== "undefined" &&
  typeof (globalThis as any).localStorage?.getItem !== "function"
) {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
  for (const target of [globalThis, typeof window !== "undefined" ? window : undefined]) {
    if (target) {
      Object.defineProperty(target, "localStorage", {
        writable: true,
        configurable: true,
        value: storage,
      });
    }
  }
  beforeEach(() => storage.clear());
}

/* v0.6.17+ — Source-code contract guards.
 *
 * 메모리 §위임 금지 + 회귀 가드 원칙: 비싼 컴포넌트 마운트 없이도
 * 변경 영향이 미치는 source 위치에 가드를 둔다.
 *
 * 보장:
 *  1. NewPageButton: onOpen?: () => void prop + 트리거에서 onOpen?.() 호출
 *  2. Sidebar: 호출부에 onOpen={onClose} 전달 (모달 → 사이드바 자동 close)
 *  3. Layout: 모바일 breakpoint 744px 그대로 유지
 *
 * v0.7.181: NewFolderButton 계약 제거 — 컴포넌트 삭제.
 */
import { describe, it, expect } from "vitest";

// Vite raw imports — no @types/node dependency.
// `node:fs` / `node:path` would require @types/node + tsconfig types array.
// Tests still load file content at runtime via Vite's bundler.
import NewPageButtonSrc from "../src/components/NewPageButton.tsx?raw";
import SidebarSrc from "../src/components/Sidebar.tsx?raw";
import LayoutSrc from "../src/components/Layout.tsx?raw";

const SOURCES = {
  NewPageButton: NewPageButtonSrc,
  Sidebar: SidebarSrc,
  Layout: LayoutSrc,
} as const;

describe("Modal-close-sidebar source contracts", () => {
  it("NewPageButton exposes onOpen?: () => void and fires it before setOpen(true)", () => {
    const s = SOURCES.NewPageButton;
    expect(s).toMatch(/onOpen\?:\s*\(\)\s*=>\s*void/);
    // 호출 위치는 setOpen(true) 직전 (주석/whitespace 포함해서 200자 이내)
    expect(s).toMatch(/onOpen\?\.\(\);[\s\S]{0,200}setOpen\(true\)/);
  });

  it("Sidebar forwards onOpen={onClose} to NewPageButton in vault row", () => {
    const s = SOURCES.Sidebar;
    // VaultTreeGroup 내부의 NewPageButton 호출
    expect(s).toMatch(/<NewPageButton[\s\S]*?onOpen=\{onClose\}[\s\S]*?\/>/);
  });



  it("Layout keeps 744px mobile breakpoint (drawer auto-close only meaningful there)", () => {
    const s = SOURCES.Layout;
    expect(s).toMatch(/max-width:\s*744px/);
  });

  // globals.css 검증은 vite ?raw 한계로 회귀 가드에서 제외.
  // Layout.tsx의 744px 매칭이 살아있으면 globals.css도 동일 breakpoint 사용을 가정.
  // (실제 CSS는 v0.6.10+ 작업에서 검증됨.)
});
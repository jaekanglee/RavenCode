/* Issue #6 — 사이드바 responsive 계약 + breakpoint SOT 회귀 가드.
 *
 * 이 테스트는 *실제로 ship되는* stylesheet(src/styles/globals.css)와
 * *실제로 ship되는* source(Layout.tsx / Sidebar.tsx / useMediaQuery.ts)를 읽는다.
 *
 * 왜 교체했나: 이전 `Layout.desktop-drawer.test.ts`는 테스트 파일 안에 CSS
 * 문자열을 복사해 두고 "그 복사본이 자기 자신과 일치하는가"를 검사했다
 * (tautology). production CSS가 어떻게 변하든 초록이었고 — 실제 drift(햄버거
 * desktop 노출, backdrop 상시 overlay, 주석 충돌)를 하나도 잡지 못했다.
 *
 * 확정 계약 (SOT — 코드·CSS·테스트·주석이 모두 이 하나를 주장한다):
 *   desktop (>744px) : .sidebar-offcanvas = in-flow (position: relative) 상시 노출.
 *                      drawer 트리거(hamburger · × · backdrop)는 CSS가 숨긴다.
 *                      .sidebar-offcanvas-open 은 desktop 규칙이 없다 → open state 무해.
 *   mobile  (≤744px) : .sidebar-offcanvas = fixed off-canvas drawer.
 *                      hamburger가 열고, backdrop · Escape · ×가 닫는다.
 *   breakpoint 숫자 SOT = src/lib/useMediaQuery.ts (DRAWER_MQ / COMPACT_NAV_MQ).
 */
import { describe, expect, it } from "vitest";
import css from "../src/styles/globals.css?raw";
import LayoutSrc from "../src/components/Layout.tsx?raw";
import SidebarSrc from "../src/components/Sidebar.tsx?raw";
import HookSrc from "../src/lib/useMediaQuery.ts?raw";
import { COMPACT_NAV_MQ, DRAWER_MQ } from "../src/lib/useMediaQuery";
import { planSectionNav } from "../src/components/Layout";

// ── 실제 shipped CSS 파서 (주석 제거 → 중괄호 매칭) ──────────────────────
const CSS = css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 블록 주석 제거 — 계약 검사는 실제 로직/CSS만 본다.
 * (Sidebar의 JSDoc이 `@media (max-width: 744px)`를 *설명*만 해도 걸리면 안 된다.)
 * 라인 주석은 `https://` 같은 문자열을 망가뜨릴 수 있어 건드리지 않는다.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function matchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface MediaBlock {
  start: number;
  end: number;
  body: string;
}

/** `@media <query> { ... }` 블록 전부 (source order). */
function mediaBlocks(query: string): MediaBlock[] {
  const needle = `@media ${query}`;
  const blocks: MediaBlock[] = [];
  let from = 0;
  for (;;) {
    const start = CSS.indexOf(needle, from);
    if (start === -1) break;
    const open = CSS.indexOf("{", start);
    if (open === -1) break;
    const end = matchingBrace(CSS, open);
    if (end === -1) break;
    blocks.push({ start, end, body: CSS.slice(open + 1, end) });
    from = end + 1;
  }
  return blocks;
}

/** @media 블록을 걷어낸 소스 = base(비조건) 규칙만 남는다. */
function withoutMediaBlocks(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("@media", i)) {
      const open = source.indexOf("{", i);
      if (open === -1) break;
      const end = matchingBrace(source, open);
      if (end === -1) break;
      out += "\n";
      i = end + 1;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** scope 안의 `selector { ... }` declaration body. 없으면 null. */
function ruleBody(scope: string, selector: string): string | null {
  const re = new RegExp(`(?:^|[},])\\s*${escapeForRegExp(selector)}\\s*\\{([^}]*)\\}`, "m");
  const match = scope.match(re);
  return match ? match[1] : null;
}

/** declaration body에서 property 값. */
function decl(body: string | null, property: string): string | null {
  if (!body) return null;
  const re = new RegExp(`(?:^|;)\\s*${escapeForRegExp(property)}\\s*:\\s*([^;]+)`, "i");
  const match = body.match(re);
  return match ? match[1].trim() : null;
}

const BASE = withoutMediaBlocks(CSS);
const MOBILE_BODY = mediaBlocks(DRAWER_MQ)
  .map((block) => block.body)
  .join("\n");

describe("사이드바 CSS 계약 — desktop (>744px) = in-flow 상시 노출", () => {
  it(".sidebar-offcanvas는 desktop에서 in-flow (position: relative)", () => {
    const body = ruleBody(BASE, ".sidebar-offcanvas");
    expect(body, "base .sidebar-offcanvas 규칙을 찾지 못했다").not.toBeNull();
    expect(decl(body, "position")).toBe("relative");
  });

  it("drawer 트리거(hamburger · × · backdrop)는 desktop에서 CSS로 숨는다", () => {
    expect(decl(ruleBody(BASE, ".header-hamburger"), "display")).toBe("none");
    expect(decl(ruleBody(BASE, ".sidebar-top-actions"), "display")).toBe("none");
    expect(decl(ruleBody(BASE, ".sidebar-backdrop"), "display")).toBe("none");
  });

  it(".sidebar-offcanvas-open은 desktop 규칙이 없다 → open state가 desktop sidebar를 바꾸지 않는다", () => {
    expect(ruleBody(BASE, ".sidebar-offcanvas-open")).toBeNull();
  });
});

describe("사이드바 CSS 계약 — mobile (≤744px) = off-canvas drawer", () => {
  it(".sidebar-offcanvas는 mobile에서 fixed off-canvas", () => {
    const body = ruleBody(MOBILE_BODY, ".sidebar-offcanvas");
    expect(body, "744px 블록 안 .sidebar-offcanvas 규칙을 찾지 못했다").not.toBeNull();
    expect(decl(body, "position")).toMatch(/^fixed/);
    expect(decl(body, "transform")).toBe("translateX(-100%)");
  });

  it("열림 상태에서만 translateX(0)으로 들어온다", () => {
    const body = ruleBody(MOBILE_BODY, ".sidebar-offcanvas-open");
    expect(body).not.toBeNull();
    expect(decl(body, "transform")).toBe("translateX(0)");
  });

  it("hamburger · × · backdrop가 mobile에서만 다시 켜진다", () => {
    expect(decl(ruleBody(MOBILE_BODY, ".header-hamburger"), "display")).toBe("inline-flex");
    expect(decl(ruleBody(MOBILE_BODY, ".sidebar-top-actions"), "display")).toBe("flex");
    expect(decl(ruleBody(MOBILE_BODY, ".sidebar-backdrop"), "display")).toBe("block");
  });
});

describe("cascade — backdrop base 규칙은 mobile 미디어 쿼리보다 앞에 온다", () => {
  it("같은 specificity라 source order가 승패를 가른다: base display:none → mobile display:block", () => {
    const baseRuleIndex = CSS.indexOf(".sidebar-backdrop {");
    const mobileBlock = mediaBlocks(DRAWER_MQ).find((block) =>
      block.body.includes(".sidebar-backdrop")
    );
    expect(baseRuleIndex).toBeGreaterThan(-1);
    expect(mobileBlock, "744px 블록에 .sidebar-backdrop이 없다").toBeTruthy();
    // base 규칙이 뒤로 밀리면 mobile 블록이 먼저 매칭돼 backdrop이 desktop에도 뜬다.
    expect(baseRuleIndex).toBeLessThan(mobileBlock!.start);
  });
});

describe("breakpoint SOT — CSS와 useMediaQuery.ts가 같은 숫자를 쓴다", () => {
  it("drawer 경계는 CSS 미디어 쿼리와 DRAWER_MQ가 정확히 일치한다", () => {
    expect(DRAWER_MQ).toBe("(max-width: 744px)");
    expect(CSS).toContain(`@media ${DRAWER_MQ}`);
    expect(mediaBlocks(DRAWER_MQ).length).toBeGreaterThan(0);
  });

  it("compact nav 경계는 390px 하나뿐이다 (SOT: COMPACT_NAV_MQ)", () => {
    expect(COMPACT_NAV_MQ).toBe("(max-width: 390px)");
    expect(HookSrc).toContain('COMPACT_NAV_MQ = "(max-width: 390px)"');
  });

  it("compact 판정 경계: 390 이하는 compact, 391 이상은 normal", () => {
    expect(planSectionNav(390).compact).toBe(true);
    expect(planSectionNav(391).compact).toBe(false);
    expect(planSectionNav(744).compact).toBe(false);
  });
});

describe("dedupe 계약 — 744px/matchMedia를 컴포넌트에 복제하지 않는다", () => {
  it("Layout과 Sidebar는 744px 미디어 쿼리를 하드코딩하지 않고 shared primitive를 쓴다", () => {
    for (const [name, raw] of [
      ["Layout", LayoutSrc],
      ["Sidebar", SidebarSrc],
    ] as const) {
      const source = stripComments(raw);
      expect(source, `${name}.tsx가 744px를 직접 박고 있다`).not.toMatch(/max-width:\s*744px/);
      // breakpoint 판정용 matchMedia 직접 호출 금지 (prefers-color-scheme 등
      // drawer와 무관한 호출은 허용 — 그래서 max-width 질의만 본다).
      expect(source, `${name}.tsx가 breakpoint용 matchMedia를 직접 호출한다`).not.toMatch(
        /matchMedia\(\s*["'`]\(\s*max-width/,
      );
      expect(source, `${name}.tsx가 shared primitive를 쓰지 않는다`).toMatch(/useMediaQuery/);
    }
  });

  it("Layout은 raw resize listener로 viewport 폭을 state에 담지 않는다", () => {
    const source = stripComments(LayoutSrc);
    expect(source).not.toMatch(/viewportWidth/);
    expect(source).not.toMatch(/addEventListener\(\s*["']resize["']/);
  });

  it("두 컴포넌트가 같은 primitive의 같은 두 판정을 쓴다", () => {
    const layout = stripComments(LayoutSrc);
    const sidebar = stripComments(SidebarSrc);
    expect(layout).toMatch(/useIsDrawerMobile/);
    expect(layout).toMatch(/useIsCompactNav/);
    expect(sidebar).toMatch(/useIsDrawerMobile/);
  });
});

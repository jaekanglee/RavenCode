/* Issue #2 B-1 — 디자인 토큰 계약 (source guard).
 *
 * 왜 source guard인가: 이 계약은 "화면이 어떻게 보이는가"가 아니라
 * "소스가 어떤 색 SOT를 참조하는가"를 검사한다. 컴포넌트를 마운트해서
 * 검증하려면 jsdom이 CSS 변수를 해석해야 하는데, jsdom은 `var()`를
 * 계산하지 않으므로 실제 drift(정의되지 않은 토큰, fallback에 가려진 오타)를
 * 하나도 잡지 못한다. 그래서 실제 ship되는 stylesheet와 source를 읽는다.
 *
 * 배경(수정 전 실제 상태):
 *   - `var(--color-danger-soft, #fee)` — `--color-danger-soft`는 globals.css에
 *     정의가 없다. fallback이 항상 이겨서 라이트/다크 모두 #fee로 렌더됐다.
 *     즉 작성자는 테마 토큰을 쓴다고 믿었지만 실제로는 하드코딩이었다.
 *   - `var(--color-warning, #c00)` — 같은 형태, 항상 #c00(빨강)이 나왔다.
 *   - `var(--color-accent)` / `var(--color-primary-soft)` — fallback이 없어
 *     선언 자체가 무효화됐다(선택 색이 적용되지 않고 border가 사라졌다).
 *
 * 확정 계약:
 *  1. fallback 없는 `var(--token)`은 globals.css에 정의가 있어야 한다.
 *     (없으면 그 선언은 브라우저에서 통째로 무시된다.)
 *  2. `var(--token, <원시 색 리터럴>)` 금지 — 색 SOT는 토큰 하나다
 *     (AGENTS.md §13.2). 원시 색 fallback은 테마 drift를 가린다.
 *     JS 표현식 fallback(`var(--graph-type-x, ${expr})`)은 허용한다:
 *     그 값은 여전히 render.ts의 SOT를 참조한다.
 */
import { describe, expect, it } from "vitest";
import css from "../src/styles/globals.css?raw";

const SOURCES = import.meta.glob("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const CSS = css.replace(/\/\*[\s\S]*?\*\//g, "");
const DEFINED = new Set(
  Array.from(CSS.matchAll(/--([A-Za-z0-9_-]+)\s*:/g), (m) => m[1]),
);

/** 주석 줄은 계약 대상이 아니다 (문서가 토큰 이름을 언급할 수 있다). */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** 코드 파일만 (테스트 제외) — 파일별 라인 배열. */
function codeLines(): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  for (const [file, text] of Object.entries(SOURCES)) {
    if (/\.test\.tsx?$/.test(file)) continue;
    out.push([file, text.split("\n")]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

describe("디자인 토큰 계약 (Issue #2 B-1)", () => {
  it("globals.css가 토큰을 실제로 정의한다 (SOT 파일 확인)", () => {
    expect(DEFINED.size).toBeGreaterThan(100);
    expect(DEFINED.has("color-primary")).toBe(true);
    expect(DEFINED.has("color-danger-bg")).toBe(true);
  });

  it("fallback 없는 var(--token)은 모두 globals.css에 정의돼 있다", () => {
    const offenders: string[] = [];
    for (const [file, lines] of codeLines()) {
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        for (const m of line.matchAll(/var\(\s*--([A-Za-z0-9_-]+)\s*\)/g)) {
          if (!DEFINED.has(m[1])) {
            offenders.push(`${file}:${i + 1} --${m[1]}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("원시 색 리터럴을 var() fallback으로 쓰지 않는다 (색 SOT는 토큰 하나)", () => {
    const offenders: string[] = [];
    for (const [file, lines] of codeLines()) {
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        for (const m of line.matchAll(
          /var\(\s*--[A-Za-z0-9_-]+\s*,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|white|black)\s*\)/g,
        )) {
          offenders.push(`${file}:${i + 1} ${m[0]}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

// ── Issue #85: 캔버스 오버레이 툴팁 — 토큰 사용과 라이트/다크 대비 ──────────────
//
// nodeLabel/linkLabel의 HTML은 force-graph가 문서 안에 붙이는 DOM 오버레이라 문서 루트의
// [data-color-mode] 토큰이 그대로 적용된다(PageView의 그래프 툴팁과 같은 경로). jsdom은
// var()를 계산하지 못하고 이 저장소에는 스크린샷 자동화가 없으므로, ship되는 stylesheet의
// 캐스케이드를 직접 해석해 두 테마에서 실제로 칠해질 색으로 대비를 계산한다.

/** 캐스케이드 순서대로 [selector, body] — at-rule 중첩은 안쪽 규칙으로 펼친다. */
function* cssRules(
  text: string,
  conditional = false,
): Generator<{ selector: string; body: string; conditional: boolean }> {
  let depth = 0;
  let start = 0;
  let selectorEnd = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) selectorEnd = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const selector = text.slice(start, selectorEnd);
        const body = text.slice(selectorEnd + 1, i);
        // 테마는 `data-color-mode` 속성으로 정해지므로 @media/@supports 안의 정의는
        // "이 테마에서 칠해질 값"이 아닐 수 있다 — 조건부 여부를 들고 다닌다.
        const nested = conditional || /^\s*@(media|supports|container)\b/.test(selector);
        if (body.includes("{")) yield* cssRules(body, nested);
        else yield { selector, body, conditional };
        start = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      start = i + 1; // `@import ...;` 같은 at-statement는 블록이 아니다
    }
  }
}

/** `:root`는 두 테마 모두에 적용되고, 모드 속성 셀렉터는 해당 테마에만 적용된다. */
function partAppliesTo(part: string, mode: "light" | "dark"): boolean {
  if (part.includes('[data-color-mode="dark"]') || /(^|\.)dark\b/.test(part)) {
    return mode === "dark";
  }
  if (part.includes('[data-color-mode="light"]')) return mode === "light";
  return part.startsWith(":root");
}

/** `[data-color-mode]` 캐스케이드로 그 테마의 토큰 맵을 만든다 (뒤에 온 규칙이 이긴다). */
function tokenMap(mode: "light" | "dark"): Map<string, { value: string; conditional: boolean }> {
  const map = new Map<string, { value: string; conditional: boolean }>();
  for (const rule of cssRules(CSS)) {
    const selector = rule.selector;
    if (!selector.split(",").some((part) => partAppliesTo(part.trim(), mode))) continue;
    for (const decl of rule.body.matchAll(/--([A-Za-z0-9_-]+)\s*:\s*([^;]+)/g)) {
      map.set(decl[1], { value: decl[2].trim(), conditional: rule.conditional });
    }
  }
  return map;
}

/** `var(--x)` 체인을 끝까지 따라간 값. */
function resolveToken(
  map: Map<string, { value: string }>,
  name: string,
  depth = 0,
): string | null {
  if (depth > 12) return null;
  const entry = map.get(name);
  if (!entry) return null;
  const alias = entry.value.match(/^var\(\s*--([A-Za-z0-9_-]+)\s*\)$/);
  return alias ? resolveToken(map, alias[1], depth + 1) : entry.value;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: string | null): Rgba | null {
  if (!value) return null;
  const hex = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgb = value.match(
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/,
  );
  if (!rgb) return null;
  return {
    r: Number(rgb[1]),
    g: Number(rgb[2]),
    b: Number(rgb[3]),
    a: rgb[4] === undefined ? 1 : Number(rgb[4]),
  };
}

/** 반투명 색을 아래 색 위에 합성한다 — 툴팁과 배지는 캔버스 위에 뜬다. */
function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  const mix = (t: number, b: number) =>
    a === 0 ? 0 : (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

function relativeLuminance(c: Rgba): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** GraphCanvas의 툴팁 템플릿 구간(nodeLabel ~ linkLabel). */
function tooltipTemplateRegion(): string {
  const entry = Object.entries(SOURCES).find(([file]) =>
    file.endsWith("components/GraphCanvas.tsx"),
  );
  if (!entry) throw new Error("GraphCanvas.tsx를 소스 목록에서 찾지 못했습니다");
  const text = entry[1];
  const start = text.indexOf(".nodeLabel((node: any) => {");
  const end = text.indexOf("graph.nodeCanvasObject(", start);
  if (start < 0 || end < 0) throw new Error("툴팁 템플릿 구간을 찾지 못했습니다");
  return text.slice(start, end);
}

/** 툴팁이 참조하는 토큰 — 두 테마 모두에서 값이 나와야 한다. */
const TOOLTIP_TOKENS = [
  "graph-tooltip-bg",
  "graph-tooltip-border",
  "graph-tooltip-shadow",
  "graph-text",
  "graph-text-muted",
  "accent",
  "cds-tag-neutral-bg",
  "cds-tag-neutral-text",
] as const;

/** 테마별로 다시 칠해져야 하는 색 (배경 위에 놓이는 전경). */
const TOOLTIP_FOREGROUNDS = ["graph-text", "graph-text-muted", "accent"] as const;

describe("캔버스 오버레이 툴팁 (Issue #85)", () => {
  it("템플릿이 원시 색 리터럴 대신 디자인 토큰을 쓴다", () => {
    const region = tooltipTemplateRegion();
    expect(region.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? []).toEqual([]);
    for (const token of TOOLTIP_TOKENS) {
      expect(region).toContain(`var(--${token})`);
    }
  });

  describe.each(["light", "dark"] as const)("%s 테마", (mode) => {
    it("툴팁이 쓰는 토큰이 모두 테마 블록에 정의돼 있다 (@media 같은 조건부 블록이 아니다)", () => {
      const map = tokenMap(mode);
      const missing = TOOLTIP_TOKENS.filter((token) => resolveToken(map, token) === null);
      expect(missing).toEqual([]);
      // 조건부 블록의 값은 이 테마에서 칠해진다는 보장이 없다 — 그런 값에 기대면
      // 아래 대비 검사가 실제 화면이 아니라 정의만 보고 통과할 수 있다.
      const conditional = TOOLTIP_TOKENS.filter((token) => map.get(token)?.conditional);
      expect(conditional).toEqual([]);
    });

    it("툴팁 배경 위 전경색의 대비가 4.5:1 이상이다", () => {
      const map = tokenMap(mode);
      const canvas = parseColor(resolveToken(map, "graph-canvas-bg"));
      const tooltip = parseColor(resolveToken(map, "graph-tooltip-bg"));
      expect(canvas).not.toBeNull();
      expect(tooltip).not.toBeNull();
      const surface = composite(tooltip!, canvas!);
      const offenders: string[] = [];
      for (const token of TOOLTIP_FOREGROUNDS) {
        const fg = parseColor(resolveToken(map, token));
        if (!fg) {
          offenders.push(`--${token}: 값이 정의돼 있지 않다`);
          continue;
        }
        const ratio = contrastRatio(composite(fg, surface), surface);
        if (ratio < 4.5) offenders.push(`--${token}: ${ratio.toFixed(2)}:1`);
      }
      // 타입 배지(.chip과 같은 neutral 토큰 쌍)도 같은 기준으로 본다.
      const badgeBg = parseColor(resolveToken(map, "cds-tag-neutral-bg"));
      const badgeFg = parseColor(resolveToken(map, "cds-tag-neutral-text"));
      if (badgeBg && badgeFg) {
        const badgeSurface = composite(badgeBg, surface);
        const ratio = contrastRatio(composite(badgeFg, badgeSurface), badgeSurface);
        if (ratio < 4.5) offenders.push(`타입 배지: ${ratio.toFixed(2)}:1`);
      } else {
        offenders.push("타입 배지 토큰이 해석되지 않았다");
      }
      expect(offenders).toEqual([]);
    });
  });

  it("툴팁 배경이 테마를 따라간다 (한 값으로 고정되지 않는다)", () => {
    const light = resolveToken(tokenMap("light"), "graph-tooltip-bg");
    const dark = resolveToken(tokenMap("dark"), "graph-tooltip-bg");
    expect(light).not.toBeNull();
    expect(dark).not.toBeNull();
    const ratio = contrastRatio(
      composite(parseColor(light)!, parseColor("#ffffff")!),
      composite(parseColor(dark)!, parseColor("#ffffff")!),
    );
    // 두 배경은 서로 뚜렷이 달라야 한다 (같은 값으로 되돌아가면 1:1이 된다).
    expect(ratio).toBeGreaterThan(1.5);
  });
});

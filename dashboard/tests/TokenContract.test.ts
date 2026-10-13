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

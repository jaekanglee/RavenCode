/* v0.7.181 — raw/ "새 파일" 입력 검증 (Sidebar ＋ / RawPanel ＋ 공유).
 *
 * 배경: 두 호출부(Sidebar NewRawFileButton, RawPanel handleNewFile)가 같은
 * 로직을 복사해 쓰면서 검증이 하나도 없었다. 가장 위험한 건 overwrite —
 * writeRaw(vault, rel, "") 는 백엔드에서 기존 파일을 빈 내용으로 덮어쓴다
 * (server.py write_raw: "기존 파일 있으면 overwrite"). "새 파일 만들기"에서
 * 기존 파일명을 입력하면 그 파일 내용이 조용히 날아간다.
 *
 * 회귀 가드:
 *  1. rel 계산 — writeRaw는 raw/ 기준 상대경로를 받는다
 *  2. 부모 디렉토리는 raw/ 생략해도 raw/ 아래로 해석
 *  3. 기존 파일 덮어쓰기 거부 (데이터 손실 방어)
 *  4. 같은 이름 디렉토리 거부 (백엔드 400 선제)
 *  5. 파일명에 '/' 금지 — 위치는 부모 디렉토리 필드의 몫
 *  6. '..' / ':' / 절대경로 / '~' 거부 (백엔드 _safe_raw_path_or_400 미러)
 */
import { describe, it, expect } from "vitest";
import { resolveNewRawFile } from "../src/lib/rawPath";
import type { RawItem } from "../src/lib/api";

function file(path: string): RawItem {
  return { path, name: path.split("/").pop() ?? path, type: "file", kind: "raw" };
}
function dir(path: string): RawItem {
  return { path, name: path.split("/").pop() ?? path, type: "dir", kind: "raw" };
}

const ITEMS: RawItem[] = [file("raw/notes.md"), dir("raw/articles"), file("raw/articles/a.txt")];

describe("resolveNewRawFile — 경로 계산", () => {
  it("raw 루트: rel은 raw/ 를 뗀 상대경로", () => {
    expect(resolveNewRawFile({ name: "new.md", dir: "raw", items: ITEMS })).toEqual({
      rel: "new.md",
      error: null,
    });
  });

  it("중첩 디렉토리", () => {
    expect(resolveNewRawFile({ name: "b.txt", dir: "raw/articles", items: ITEMS }).rel).toBe(
      "articles/b.txt"
    );
  });

  it("raw/ 접두를 생략해도 raw/ 아래로 해석", () => {
    expect(resolveNewRawFile({ name: "b.txt", dir: "articles", items: ITEMS }).rel).toBe(
      "articles/b.txt"
    );
  });

  it("trailing slash / 빈 값은 정규화", () => {
    expect(resolveNewRawFile({ name: "b.txt", dir: "raw/articles/", items: ITEMS }).rel).toBe(
      "articles/b.txt"
    );
    expect(resolveNewRawFile({ name: "b.txt", dir: "", items: ITEMS }).rel).toBe("b.txt");
  });

  it("파일명 앞뒤 공백은 trim", () => {
    expect(resolveNewRawFile({ name: "  b.txt  ", dir: "raw", items: ITEMS }).rel).toBe("b.txt");
  });
});

describe("resolveNewRawFile — 검증", () => {
  it("기존 파일을 덮어쓰지 않는다", () => {
    const r = resolveNewRawFile({ name: "notes.md", dir: "raw", items: ITEMS });
    expect(r.rel).toBeNull();
    expect(r.error).toMatch(/이미 있는 파일/);
  });

  it("같은 이름의 디렉토리도 거부", () => {
    const r = resolveNewRawFile({ name: "articles", dir: "raw", items: ITEMS });
    expect(r.rel).toBeNull();
    expect(r.error).toMatch(/디렉토리/);
  });

  it("다른 디렉토리의 같은 파일명은 통과", () => {
    expect(resolveNewRawFile({ name: "notes.md", dir: "raw/articles", items: ITEMS }).rel).toBe(
      "articles/notes.md"
    );
  });

  it("빈 파일명 거부", () => {
    expect(resolveNewRawFile({ name: "   ", dir: "raw", items: ITEMS }).error).toMatch(/파일명/);
  });

  it("파일명에 '/' 거부 — 위치는 부모 디렉토리 필드의 몫", () => {
    const r = resolveNewRawFile({ name: "sub/new.md", dir: "raw", items: ITEMS });
    expect(r.rel).toBeNull();
    expect(r.error).toMatch(/부모 디렉토리/);
  });

  it("'..' / ':' / 절대경로 / '~' 거부", () => {
    expect(resolveNewRawFile({ name: "..", dir: "raw", items: ITEMS }).error).toBeTruthy();
    expect(resolveNewRawFile({ name: "a.md", dir: "raw/../content", items: ITEMS }).error).toBeTruthy();
    expect(resolveNewRawFile({ name: "C:a.md", dir: "raw", items: ITEMS }).error).toBeTruthy();
    expect(resolveNewRawFile({ name: "a.md", dir: "/etc", items: ITEMS }).error).toBeTruthy();
    expect(resolveNewRawFile({ name: "a.md", dir: "~/secrets", items: ITEMS }).error).toBeTruthy();
  });

  it("에러가 있으면 rel은 항상 null (호출부가 실수로 써도 안전)", () => {
    for (const bad of [
      { name: "notes.md", dir: "raw" },
      { name: "sub/x.md", dir: "raw" },
      { name: "..", dir: "raw" },
    ]) {
      expect(resolveNewRawFile({ ...bad, items: ITEMS }).rel).toBeNull();
    }
  });
});

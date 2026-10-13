/* v0.7.184+ — vault 문서 파일 내보내기 (공유 팝오버).
 *
 * md = API의 export.md를 받아 .md 저장 (vault 원본, frontmatter 포함)
 *
 * Contract:
 *  1. export.md URL — slug segment 인코딩, ?frontmatter=false
 *  2. 파일명 = slug 마지막 segment + .md (한글 그대로)
 *  3. 팝오버의 Markdown 버튼이 fetch → 저장, PDF 버튼은 없다
 *     (데스크톱 WKWebView가 iframe print()를 무시해 제거 — 회귀 가드)
 *  4. 데스크톱(Tauri)에서는 Blob 대신 save_download_file 커맨드로 저장
 *     — wry 0.55는 on_download 훅이 없는 웹뷰의 다운로드 내비게이션을
 *       WKNavigationActionPolicy::Cancel로 조용히 취소한다 (회귀 가드)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  downloadPageMarkdown,
  downloadPageMarkdownAs,
  markdownFilename,
  pageMarkdownUrl,
  saveTextFile,
  saveTextFileAs,
} from "../src/lib/pageExport";
import { ShareButton } from "../src/components/ShareButton";

const RAW_MD = "---\ntitle: 시험 문서\ntype: concept\n---\n# 시험 문서\n\n본문.\n";

describe("export.md URL / 파일명", () => {
  it("slug segment를 인코딩하고 '/'는 남긴다", () => {
    expect(pageMarkdownUrl("my-vault", "content/concept/한글-문서")).toBe(
      "/api/vaults/my-vault/pages/content/concept/%ED%95%9C%EA%B8%80-%EB%AC%B8%EC%84%9C/export.md"
    );
  });

  it("frontmatter=false 쿼리를 붙인다", () => {
    expect(pageMarkdownUrl("v", "content/a", { frontmatter: false })).toBe(
      "/api/vaults/v/pages/content/a/export.md?frontmatter=false"
    );
    expect(pageMarkdownUrl("v", "content/a", { frontmatter: true })).toBe(
      "/api/vaults/v/pages/content/a/export.md"
    );
  });

  it("파일명은 slug 마지막 segment + .md", () => {
    expect(markdownFilename("content/concept/한글-문서")).toBe("한글-문서.md");
    expect(markdownFilename("index")).toBe("index.md");
  });
});

describe("ShareButton 내보내기 섹션", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clicked: string[];

  beforeEach(() => {
    clicked = [];
    createObjectURL = vi.fn(() => "blob:mock");
    revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    // a.click()은 jsdom에서 navigation 경고를 내므로 download 파일명만 기록.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push(this.download);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/export.md")) {
          return new Response(RAW_MD, {
            status: 200,
            headers: { "Content-Type": "text/markdown; charset=utf-8" },
          });
        }
        // /api/system/info 등
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function openPopover() {
    render(<ShareButton vault="my-vault" slug="content/concept/시험-문서" />);
    await act(async () => {
      screen.getByLabelText("공유").click();
    });
    return screen.getByTestId("share-popover");
  }

  it("Markdown 저장 버튼이 export.md를 받아 파일로 저장한다", async () => {
    await openPopover();
    const btn = screen.getByLabelText("Markdown 파일로 저장");

    await act(async () => {
      btn.click();
    });

    await waitFor(() => expect(clicked).toContain("시험-문서.md"));
    const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calls.some((u: string) => u.includes("/export.md"))).toBe(true);
    expect(createObjectURL).toHaveBeenCalled();
  });

  it("PDF 버튼은 없다 (데스크톱에서 조용히 실패하던 인쇄 경로 제거)", async () => {
    await openPopover();
    expect(screen.getByLabelText("Markdown 파일로 저장")).toBeTruthy();
    expect(screen.queryByLabelText("PDF로 저장")).toBeNull();
    expect(screen.queryByText(/PDF/)).toBeNull();
  });

  it("저장 위치 선택 버튼이 save_download_file_as를 부르고 저장 경로를 보여준다", async () => {
    const invoke = vi.fn(async () => "/Users/me/Documents/시험-문서.md");
    (window as any).__TAURI_INTERNALS__ = { invoke };
    try {
      await openPopover();

      await act(async () => {
        screen.getByLabelText("저장 위치 선택").click();
      });

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("save_download_file_as", {
          filename: "시험-문서.md",
          contents: RAW_MD,
        })
      );
      await waitFor(() =>
        expect(screen.getByTestId("share-popover").textContent).toContain(
          "/Users/me/Documents/시험-문서.md"
        )
      );
      // 저장 위치 선택 경로는 Blob 다운로드를 타지 않는다.
      expect(clicked).toEqual([]);
    } finally {
      delete (window as any).__TAURI_INTERNALS__;
    }
  });

  it("저장 위치 선택에서 취소하면 오류도 저장 표시도 남기지 않는다", async () => {
    const invoke = vi.fn(async () => null);
    (window as any).__TAURI_INTERNALS__ = { invoke };
    try {
      await openPopover();

      await act(async () => {
        screen.getByLabelText("저장 위치 선택").click();
      });

      await waitFor(() => expect(invoke).toHaveBeenCalled());
      const popover = screen.getByTestId("share-popover");
      expect(popover.textContent).not.toContain("/Users/me/Documents");
      expect(popover.querySelector(".share-export-error")).toBeNull();
      expect(clicked).toEqual([]);
    } finally {
      delete (window as any).__TAURI_INTERNALS__;
    }
  });
});


describe("데스크톱(Tauri) 저장 경로", () => {
  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("Tauri 웹뷰에서는 Blob 대신 save_download_file 커맨드를 부른다", async () => {
    const invoke = vi.fn(async () => "/Users/me/Downloads/시험-문서.md");
    (window as any).__TAURI_INTERNALS__ = { invoke };
    const createObjectURL = vi.fn(() => "blob:mock");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    const saved = await saveTextFile("시험-문서.md", "본문", "text/markdown");

    expect(invoke).toHaveBeenCalledWith("save_download_file", {
      filename: "시험-문서.md",
      contents: "본문",
    });
    expect(saved.path).toBe("/Users/me/Downloads/시험-문서.md");
    // 데스크톱에서는 취소되는 Blob 다운로드 경로를 타지 않아야 한다.
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it("브라우저에서는 Blob 다운로드를 그대로 쓰고 path는 null", async () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      names.push(this.download);
    });

    const saved = await saveTextFile("a.md", "본문", "text/markdown");

    expect(createObjectURL).toHaveBeenCalled();
    expect(names).toEqual(["a.md"]);
    expect(saved.path).toBeNull();
  });

  it("downloadPageMarkdown이 저장 결과(경로)를 그대로 넘긴다", async () => {
    const invoke = vi.fn(async () => "/Users/me/Downloads/시험-문서.md");
    (window as any).__TAURI_INTERNALS__ = { invoke };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(RAW_MD, { status: 200 }))
    );

    const saved = await downloadPageMarkdown("v", "content/concept/시험-문서");

    expect(saved).toEqual({
      filename: "시험-문서.md",
      path: "/Users/me/Downloads/시험-문서.md",
    });
  });
});

/* Issue #4 D-2 — 저장 위치 선택 다이얼로그.
 *
 * 수정 전: 저장이 항상 ~/Downloads로 조용히 떨어졌다. 이슈의 수용 기준은
 * "저장 위치 선택 다이얼로그 제공"이다.
 *
 * 설계상 중요한 점: 다이얼로그는 **Rust가** 띄우고 웹뷰는 경로를 넘기지 않는다.
 * 웹뷰가 경로를 주면 `safe_file_name` 정화를 우회하는 통로가 생기므로, 여기서는
 * 웹뷰가 파일명+내용만 보내는지까지 고정한다.
 */
describe("데스크톱 저장 위치 선택 (#4 D-2)", () => {
  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("사용자가 고른 경로를 저장 결과로 돌려준다", async () => {
    const invoke = vi.fn(async () => "/Users/me/Documents/보고서/시험-문서.md");
    (window as any).__TAURI_INTERNALS__ = { invoke };

    const saved = await saveTextFileAs("시험-문서.md", "본문", "text/markdown");

    expect(invoke).toHaveBeenCalledWith("save_download_file_as", {
      filename: "시험-문서.md",
      contents: "본문",
    });
    expect(saved).toEqual({
      filename: "시험-문서.md",
      path: "/Users/me/Documents/보고서/시험-문서.md",
    });
  });

  it("웹뷰는 저장 경로를 넘기지 않는다 (파일명 정화 우회 차단)", async () => {
    const invoke = vi.fn(
      async (_cmd: string, _args?: Record<string, unknown>) => "/Users/me/Documents/a.md"
    );
    (window as any).__TAURI_INTERNALS__ = { invoke };

    await saveTextFileAs("../../etc/passwd", "본문", "text/markdown");

    const args = invoke.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["contents", "filename"]);
  });

  it("사용자가 취소하면 null을 돌려주고 오류로 보지 않는다", async () => {
    const invoke = vi.fn(async () => null);
    (window as any).__TAURI_INTERNALS__ = { invoke };

    expect(await saveTextFileAs("a.md", "본문", "text/markdown")).toBeNull();
  });

  it("브라우저에는 네이티브 다이얼로그가 없으므로 기존 다운로드로 폴백한다", async () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      names.push(this.download);
    });

    const saved = await saveTextFileAs("a.md", "본문", "text/markdown");

    expect(createObjectURL).toHaveBeenCalled();
    expect(names).toEqual(["a.md"]);
    expect(saved).toEqual({ filename: "a.md", path: null });
  });

  it("downloadPageMarkdownAs가 export.md를 받아 선택한 위치에 저장한다", async () => {
    const invoke = vi.fn(async () => "/Users/me/Documents/시험-문서.md");
    (window as any).__TAURI_INTERNALS__ = { invoke };
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        fetched.push(String(input));
        return new Response(RAW_MD, { status: 200 });
      })
    );

    const saved = await downloadPageMarkdownAs("my-vault", "content/concept/시험-문서");

    expect(fetched.some((u) => u.includes("/export.md"))).toBe(true);
    expect(invoke).toHaveBeenCalledWith("save_download_file_as", {
      filename: "시험-문서.md",
      contents: RAW_MD,
    });
    expect(saved?.path).toBe("/Users/me/Documents/시험-문서.md");
  });

  it("취소하면 fetch한 본문을 저장하지 않고 null을 돌려준다", async () => {
    const invoke = vi.fn(async () => null);
    (window as any).__TAURI_INTERNALS__ = { invoke };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(RAW_MD, { status: 200 }))
    );

    expect(await downloadPageMarkdownAs("v", "content/a")).toBeNull();
  });
});

/* v0.7.184+ — vault 문서 파일 내보내기 (공유 팝오버).
 *
 * md = API의 export.md를 받아 .md 저장 (vault 원본, frontmatter 포함)
 * pdf = 렌더된 본문을 격리 iframe + 인쇄 스타일시트로 옮겨 인쇄 대화상자
 *       (의존성 0 — PDF 라이브러리/CJK 폰트 임베드 없음)
 *
 * Contract:
 *  1. export.md URL — slug segment 인코딩, ?frontmatter=false
 *  2. 파일명 = slug 마지막 segment + .md (한글 그대로)
 *  3. 인쇄 문서에 제목/메타/본문 HTML이 들어가고 제목은 HTML escape
 *  4. printPageAsPdf가 iframe을 만들어 인쇄하고 정리한다
 *  5. 팝오버에 두 버튼이 뜨고, md는 fetch → 저장, pdf는 본문 HTML로 인쇄
 *  6. getPrintHtml이 없으면 PDF 버튼을 감춘다 (편집 모드 등)
 *  7. 데스크톱(Tauri)에서는 Blob 대신 save_download_file 커맨드로 저장
 *     — wry 0.55는 on_download 훅이 없는 웹뷰의 다운로드 내비게이션을
 *       WKNavigationActionPolicy::Cancel로 조용히 취소한다 (회귀 가드)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  buildPrintDocument,
  downloadPageMarkdown,
  markdownFilename,
  pageMarkdownUrl,
  printPageAsPdf,
  saveTextFile,
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

describe("buildPrintDocument", () => {
  it("제목·메타·본문을 담고 A4 인쇄 스타일을 붙인다", () => {
    const html = buildPrintDocument({
      title: "시험 문서",
      bodyHtml: "<h1>머리</h1><p>본문</p>",
      meta: [{ label: "분류", value: "concept" }],
      source: "my-vault / content/a",
    });
    expect(html).toContain("<title>시험 문서</title>");
    expect(html).toContain("분류: concept");
    expect(html).toContain("<h1>머리</h1><p>본문</p>");
    expect(html).toContain("my-vault / content/a");
    expect(html).toContain("@page { size: A4;");
    // 다크모드로 인쇄되지 않도록 light 고정
    expect(html).toContain('data-color-mode="light"');
  });

  it("제목/메타는 HTML escape (본문 HTML은 그대로)", () => {
    const html = buildPrintDocument({
      title: '<script>alert(1)</script>',
      bodyHtml: "<p>ok</p>",
    });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("printPageAsPdf", () => {
  // jsdom은 srcdoc을 파싱해 contentDocument를 채우지 않는다 — 실제 브라우저에서
  // 확인하는 부분은 렌더 결과이고, 여기서는 "무엇을 프레임에 넘겼는가"를 고정한다.
  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll("iframe").forEach((f) => f.remove());
  });

  it("인쇄 문서를 iframe에 심고 인쇄한 뒤 정리한다", async () => {
    vi.useFakeTimers();
    const print = vi.fn();
    const promise = printPageAsPdf({
      title: "문서",
      bodyHtml: "<p>본문</p>",
      meta: [{ label: "분류", value: "concept" }],
      print,
      styleTimeoutMs: 0,
    });

    const frame = document.querySelector("iframe");
    expect(frame).toBeTruthy();
    const srcdoc = frame?.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("<p>본문</p>");
    expect(srcdoc).toContain("문서");
    expect(srcdoc).toContain("분류: concept");
    // 화면 밖으로 치우되 display:none은 쓰지 않는다 (엔진이 인쇄를 건너뜀).
    expect(frame?.style.display).not.toBe("none");

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(print).toHaveBeenCalledTimes(1);

    expect(document.querySelectorAll("iframe").length).toBe(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(document.querySelectorAll("iframe").length).toBe(0);
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

  async function openPopover(extra: Partial<React.ComponentProps<typeof ShareButton>> = {}) {
    render(<ShareButton vault="my-vault" slug="content/concept/시험-문서" {...extra} />);
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

  it("PDF 버튼은 렌더된 본문 HTML을 인쇄에 넘긴다", async () => {
    await openPopover({ getPrintHtml: () => "<p>렌더된 본문</p>", title: "시험 문서" });

    const btn = screen.getByLabelText("PDF로 저장");
    expect(btn).toBeTruthy();

    await act(async () => {
      btn.click();
    });

    await waitFor(() => {
      const frame = document.querySelector("iframe");
      expect(frame).toBeTruthy();
      expect(frame?.getAttribute("srcdoc")).toContain("<p>렌더된 본문</p>");
      expect(frame?.getAttribute("srcdoc")).toContain("시험 문서");
    });
  });

  it("getPrintHtml이 없으면 PDF 버튼을 감춘다", async () => {
    await openPopover();
    expect(screen.getByLabelText("Markdown 파일로 저장")).toBeTruthy();
    expect(screen.queryByLabelText("PDF로 저장")).toBeNull();
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

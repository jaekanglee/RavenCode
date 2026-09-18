// pageExport — vault 문서를 파일로 내보내기 (v0.7.184+).
//
// 공유 팝오버의 "내보내기" 두 갈래를 담당한다:
//  1. Markdown — API의 export.md를 받아 .md 파일로 저장. vault 원본 그대로
//     (frontmatter 포함) 이므로 다른 vault/Obsidian으로 되돌릴 수 있다.
//  2. PDF — 렌더된 본문을 격리된 iframe에 옮겨 담고 전용 인쇄 스타일시트를
//     붙여 window.print()를 호출한다. 사용자가 대화상자에서 "PDF로 저장".
//     의존성 0이고 한글/코드블록/표가 OS 렌더러로 그대로 나오며 페이지 분할도
//     브라우저가 처리한다 (PDF 라이브러리 + CJK 폰트 임베드 불필요).
import { apiFetch } from "./api";

/** slug의 각 segment를 인코딩 — '/'는 경로 구분자로 남긴다. */
export function encodeSlugPath(slug: string): string {
  return slug.split("/").map(encodeURIComponent).join("/");
}

export function pageMarkdownUrl(
  vault: string,
  slug: string,
  opts: { frontmatter?: boolean } = {}
): string {
  const query = opts.frontmatter === false ? "?frontmatter=false" : "";
  return `/api/vaults/${encodeURIComponent(vault)}/pages/${encodeSlugPath(slug)}/export.md${query}`;
}

/** slug 마지막 segment = 실제 파일 stem (API가 주는 파일명과 같다). */
export function markdownFilename(slug: string): string {
  const base = slug.split("/").filter(Boolean).pop() || "page";
  return base.endsWith(".md") ? base : `${base}.md`;
}

/** Blob + a[download] 저장. 브라우저와 Tauri 웹뷰 모두 이 경로를 쓴다. */
export function saveTextFile(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 즉시 revoke하면 웹뷰가 아직 읽는 중일 수 있다.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function downloadPageMarkdown(
  vault: string,
  slug: string,
  opts: { frontmatter?: boolean } = {}
): Promise<void> {
  const res = await apiFetch(pageMarkdownUrl(vault, slug, opts));
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      detail ? `내보내기 실패 (HTTP ${res.status}): ${detail.slice(0, 200)}` : `내보내기 실패 (HTTP ${res.status})`
    );
  }
  saveTextFile(markdownFilename(slug), await res.text(), "text/markdown;charset=utf-8");
}

// ── PDF (인쇄 대화상자) ──

export interface PrintMeta {
  label: string;
  value: string;
}

export interface PrintDocumentInput {
  title: string;
  /** 렌더된 본문 HTML (화면에 이미 그려진 마크다운 노드의 innerHTML). */
  bodyHtml: string;
  meta?: PrintMeta[];
  /** 문서 출처 한 줄 (vault/slug). */
  source?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 인쇄 전용 스타일. 앱 화면 스타일(사이드바/버튼/다크모드)을 상대로 싸우지 않고
 * iframe 안에서 처음부터 종이 레이아웃을 세운다. 색은 인쇄 기준이라
 * 디자인 토큰이 아니라 잉크 기준 고정값을 쓴다 (§13.2 예외: 출력 매체 팔레트).
 */
const PRINT_CSS = `
@page { size: A4; margin: 18mm 16mm 20mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard",
    "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif;
  font-size: 10.5pt;
  line-height: 1.75;
  color: #1a1a1a;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.print-head { border-bottom: 1.5pt solid #1a1a1a; padding-bottom: 8pt; margin-bottom: 16pt; }
.print-title { font-size: 20pt; font-weight: 700; line-height: 1.3; margin: 0 0 6pt; letter-spacing: -0.4pt; }
.print-meta { font-size: 8.5pt; color: #5a5a5a; margin: 0; }
.print-meta span + span::before { content: " · "; }
.print-source { font-size: 8pt; color: #8a8a8a; margin-top: 3pt; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

/* 본문 — .wmde-markdown 이 iframe으로 따라오지만 화면용 색/배경은 종이 기준으로 덮는다. */
.print-body { color: #1a1a1a; background: transparent; font-size: 10.5pt; line-height: 1.75; }
.print-body h1, .print-body h2, .print-body h3, .print-body h4 {
  color: #111; line-height: 1.35; margin: 16pt 0 6pt; break-after: avoid; page-break-after: avoid;
}
.print-body h1 { font-size: 16pt; border-bottom: 0.5pt solid #d8d8d8; padding-bottom: 4pt; }
.print-body h2 { font-size: 13.5pt; }
.print-body h3 { font-size: 11.5pt; }
.print-body p, .print-body li { orphans: 3; widows: 3; }
.print-body ul, .print-body ol { padding-left: 18pt; margin: 6pt 0; }
.print-body li { margin: 2pt 0; }
.print-body a { color: #1a4fa0; text-decoration: none; border-bottom: 0.4pt solid #b8cbe8; }
.print-body img, .print-body svg { max-width: 100%; height: auto; }
.print-body hr { border: 0; border-top: 0.5pt solid #d8d8d8; margin: 12pt 0; }
.print-body blockquote {
  margin: 8pt 0; padding: 2pt 0 2pt 10pt; border-left: 2pt solid #d0d0d0;
  color: #4a4a4a; break-inside: avoid; page-break-inside: avoid;
}
.print-body pre {
  background: #f6f7f9 !important; border: 0.5pt solid #e0e2e6; border-radius: 3pt;
  padding: 7pt 9pt; margin: 8pt 0; font-size: 8.5pt; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word; break-inside: avoid; page-break-inside: avoid;
}
.print-body pre code { background: transparent !important; color: #1a1a1a !important; padding: 0; font-size: inherit; }
.print-body :not(pre) > code {
  background: #f0f1f4 !important; color: #b02a37 !important; border-radius: 2pt;
  padding: 0.5pt 3pt; font-size: 9pt;
}
.print-body table {
  width: 100%; border-collapse: collapse; margin: 8pt 0; font-size: 9pt;
  break-inside: avoid; page-break-inside: avoid;
}
.print-body th, .print-body td { border: 0.5pt solid #ccc; padding: 4pt 6pt; text-align: left; vertical-align: top; }
.print-body th { background: #f2f3f5 !important; font-weight: 700; }
.print-body table tr { break-inside: avoid; page-break-inside: avoid; }

/* 화면 전용 요소가 본문 HTML에 섞여 들어온 경우 정리.
   .anchor/.octicon = @uiw가 heading에 붙이는 링크 아이콘 (종이에선 무의미). */
.print-body button, .print-body [role="button"], .print-body .raven-no-print,
.print-body .anchor, .print-body .octicon { display: none !important; }
.print-body [data-color-mode] { background: transparent !important; color: inherit !important; }
`;

export function buildPrintDocument({ title, bodyHtml, meta = [], source }: PrintDocumentInput): string {
  const metaHtml = meta.length
    ? `<p class="print-meta">${meta
        .map((m) => `<span>${escapeHtml(m.label)}: ${escapeHtml(m.value)}</span>`)
        .join("")}</p>`
    : "";
  const sourceHtml = source ? `<p class="print-source">${escapeHtml(source)}</p>` : "";
  return `<!doctype html>
<html lang="ko" data-color-mode="light">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}</style></head>
<body>
<header class="print-head">
  <h1 class="print-title">${escapeHtml(title)}</h1>
  ${metaHtml}
  ${sourceHtml}
</header>
<article class="print-body">${bodyHtml}</article>
</body></html>`;
}

/** iframe 안 스타일시트(<link>)가 다 로드될 때까지 대기 — 안 기다리면 무스타일 인쇄. */
function waitForStyles(doc: Document, timeoutMs: number): Promise<void> {
  const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]')) as HTMLLinkElement[];
  const pending = links
    .filter((l) => !l.sheet)
    .map(
      (l) =>
        new Promise<void>((resolve) => {
          l.addEventListener("load", () => resolve(), { once: true });
          l.addEventListener("error", () => resolve(), { once: true });
        })
    );
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts?.ready) pending.push(fonts.ready.then(() => undefined));
  if (!pending.length) return Promise.resolve();
  return Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export interface PrintPageOptions extends PrintDocumentInput {
  /** 테스트에서 실제 인쇄 대화상자를 띄우지 않게 주입. */
  print?: (win: Window) => void;
  styleTimeoutMs?: number;
}

/**
 * 격리된 iframe에 인쇄 문서를 심고 인쇄 대화상자를 띄운다.
 * 반환 후 iframe은 스스로 정리된다 (인쇄 대화상자는 동기적으로 블록된다).
 */
export async function printPageAsPdf(options: PrintPageOptions): Promise<void> {
  const { print, styleTimeoutMs = 2000, ...docInput } = options;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.title = "인쇄 미리보기";
  // display:none 이면 일부 엔진이 인쇄를 건너뛴다 — 화면 밖으로 치운다.
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;";
  document.body.appendChild(iframe);

  try {
    const loaded = new Promise<void>((resolve) => {
      iframe.addEventListener("load", () => resolve(), { once: true });
      // jsdom 등 load를 안 쏘는 환경 대비.
      setTimeout(resolve, styleTimeoutMs);
    });
    iframe.srcdoc = buildPrintDocument(docInput);
    await loaded;
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error("인쇄용 프레임을 만들 수 없습니다.");
    await waitForStyles(doc, styleTimeoutMs);
    win.focus();
    if (print) print(win);
    else win.print();
  } finally {
    // 인쇄 대화상자가 닫힌 뒤 제거 (Safari는 print()가 바로 반환되기도 한다).
    setTimeout(() => iframe.remove(), 1000);
  }
}

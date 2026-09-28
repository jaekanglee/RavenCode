// pageExport — vault 문서를 파일로 내보내기 (v0.7.184+).
//
// 공유 팝오버의 "내보내기"를 담당한다: API의 export.md를 받아 .md 파일로 저장.
// vault 원본 그대로(frontmatter 포함)이므로 다른 vault/Obsidian으로 되돌릴 수 있다.
//
// PDF(iframe + window.print)는 제거했다 — 데스크톱 WKWebView는 JS print()가 없고,
// Tauri는 최상위 window.print만 네이티브 인쇄로 바꿔 둬서 iframe 인쇄는 조용히
// 무시됐다. 브라우저에서는 ⌘P로 대체한다.
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

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** 데스크톱(Tauri) 웹뷰면 invoke 함수를, 아니면 null. */
function tauriInvoke(): TauriInvoke | null {
  if (typeof window === "undefined") return null;
  const internals = (window as unknown as Record<string, any>).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" ? internals.invoke.bind(internals) : null;
}

/** 저장 결과 — 데스크톱은 실제 저장 경로를 돌려준다 (브라우저는 알 수 없음). */
export interface SavedFile {
  filename: string;
  /** 데스크톱에서 저장된 절대 경로. 브라우저 다운로드면 null. */
  path: string | null;
}

/**
 * 파일 저장. 브라우저는 Blob + a[download], 데스크톱은 Rust 커맨드.
 *
 * 데스크톱을 따로 두는 이유: wry 0.55의 navigation_policy는 다운로드
 * 내비게이션을 만나면 웹뷰에 on_download 훅이 없을 때 Cancel로 답한다
 * (`WKNavigationActionPolicy::Cancel`). Raven의 창은 tauri.conf.json이
 * 만들어 빌더 훅을 걸 수 없어서, Blob 저장이 **조용히 아무 일도 안 했다**.
 * save_download_file 커맨드가 ~/Downloads에 쓰고 경로를 돌려준다.
 */
export async function saveTextFile(
  filename: string,
  text: string,
  mime: string
): Promise<SavedFile> {
  const invoke = tauriInvoke();
  if (invoke) {
    const path = await invoke("save_download_file", { filename, contents: text });
    return { filename, path: typeof path === "string" ? path : null };
  }
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
  return { filename, path: null };
}

export async function downloadPageMarkdown(
  vault: string,
  slug: string,
  opts: { frontmatter?: boolean } = {}
): Promise<SavedFile> {
  const res = await apiFetch(pageMarkdownUrl(vault, slug, opts));
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      detail ? `내보내기 실패 (HTTP ${res.status}): ${detail.slice(0, 200)}` : `내보내기 실패 (HTTP ${res.status})`
    );
  }
  return saveTextFile(markdownFilename(slug), await res.text(), "text/markdown;charset=utf-8");
}

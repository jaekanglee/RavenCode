/**
 * Issue #17: what raw HTML in a vault page may become in the dashboard.
 *
 * `MDEditor.Markdown` (@uiw/react-markdown-preview) always parses raw HTML — its
 * default entry adds rehype-raw whatever `skipHtml` says — and its only filter is a
 * tag-name regex. So `<iframe srcdoc>`, `<embed>`, `<object>`, `<form>`, `<base>`,
 * `<style>` and `style=` reached the DOM. A srcdoc iframe runs with this page's
 * origin; in the desktop app that is the origin with IPC access. Vault pages are
 * written by people, sync, and agents over MCP, so they are not trusted markup.
 *
 * Every `MDEditor.Markdown` gets `SAFE_MARKDOWN_PROPS`:
 *  - `allowElement`: only the elements Markdown/GFM produce, the library's own
 *    copy/anchor icons and a few harmless inline HTML elements survive; anything
 *    else is dropped with its content. `<input>` only as a GFM task checkbox.
 *  - `rehypeRewrite`: removes event handlers, `style`, `srcdoc`, form targets and
 *    any URL attribute whose scheme is not http(s)/mailto/tel/relative (images may
 *    also use raster `data:` URLs).
 *  - `skipHtml: true` is set explicitly (the library default) so a future default
 *    change cannot add another raw-HTML path.
 * React already refuses `javascript:` URLs and string event handlers; this does not
 * rely on that. The webview CSP (tauri.conf.json) is the second line.
 */
import type { Element, ElementContent, Root, RootContent } from "hast";

const ALLOWED_TAGS = new Set([
  // Markdown + GFM output
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "input", "li",
  "ol", "p", "pre", "section", "span", "strong", "sup", "table", "tbody", "td", "th", "thead", "tr", "ul", "div",
  // harmless inline / structural HTML people write in notes
  "abbr", "b", "caption", "col", "colgroup", "dd", "details", "dl", "dt", "figcaption", "figure", "i", "ins", "kbd",
  "mark", "q", "rp", "rt", "ruby", "s", "samp", "small", "strike", "sub", "summary", "tfoot", "u", "var",
  "picture", "source", "audio", "video",
  // the library's copy button and heading anchor icons
  "svg", "path",
]);

const URL_ATTRIBUTES = new Set(["href", "src", "srcset", "cite", "poster", "background", "longdesc", "xlinkhref"]);
const DROPPED_ATTRIBUTES = new Set(["style", "srcdoc", "action", "formaction", "ping", "manifest", "is"]);
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const RASTER_DATA_URL = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i;

/** The URL's scheme, ignoring whitespace and control characters browsers skip; null if relative. */
function schemeOf(url: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = url.replace(/[\u0000- \u007f-\u009f]/g, "");
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  return match ? match[1].toLowerCase() : null;
}

export function isSafeUrl(url: unknown, tagName: string, attribute: string): boolean {
  if (typeof url !== "string") return Array.isArray(url) ? url.every((u) => isSafeUrl(u, tagName, attribute)) : true;
  const scheme = schemeOf(url);
  if (scheme === null || SAFE_SCHEMES.has(scheme)) return true;
  return scheme === "data" && attribute === "src" && (tagName === "img" || tagName === "source") && RASTER_DATA_URL.test(url.trim());
}

/** rehype-rewrite callback: strip what a raw HTML element must not carry. */
export function sanitizeNode(node: Root | RootContent | ElementContent): void {
  if (node.type !== "element") return;
  const element = node as Element;
  const properties = element.properties ?? {};
  for (const key of Object.keys(properties)) {
    const name = key.toLowerCase().replace(/[-_:]/g, "");
    if (name.startsWith("on") || DROPPED_ATTRIBUTES.has(name)) {
      delete properties[key];
    } else if (URL_ATTRIBUTES.has(name) && !isSafeUrl(properties[key], element.tagName, name)) {
      delete properties[key];
    }
  }
}

export function allowElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) return false;
  if (tag === "input") return element.properties?.type === "checkbox";
  return true;
}

export const SAFE_MARKDOWN_PROPS = {
  skipHtml: true,
  allowElement,
  rehypeRewrite: sanitizeNode,
} as const;

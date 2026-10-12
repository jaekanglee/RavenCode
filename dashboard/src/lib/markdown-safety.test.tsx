import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownView } from "../components/MarkdownView";
import { isSafeUrl } from "./markdown-safety";

/** Issue #17: raw HTML in a vault page must not bring active content into the dashboard. */
function html(source: string): string {
  const { container } = render(<MarkdownView content={source} vault="v" />);
  return (container.querySelector(".wmde-markdown") ?? container).innerHTML;
}

function dom(source: string): HTMLElement {
  const { container } = render(<MarkdownView content={source} vault="v" />);
  return (container.querySelector(".wmde-markdown") ?? container) as HTMLElement;
}

describe("raw HTML in vault pages (Issue #17)", () => {
  it.each([
    ["iframe with srcdoc", '<iframe srcdoc="<b>x</b>"></iframe>', "iframe"],
    ["iframe with src", '<iframe src="https://example.invalid/"></iframe>', "iframe"],
    ["frame", '<frameset><frame src="x"></frameset>', "frame"],
    ["object", '<object data="x"></object>', "object"],
    ["embed", '<embed src="x">', "embed"],
    ["form", '<form action="https://example.invalid/"><button>b</button></form>', "form"],
    ["button", "<button>b</button>", "button"],
    ["text input", '<input type="text" value="x">', "input"],
    ["base", '<base href="https://example.invalid/">', "base"],
    ["meta", '<meta http-equiv="refresh" content="0">', "meta"],
    ["link", '<link rel="stylesheet" href="https://example.invalid/x.css">', "link"],
    ["style element", "<style>body{display:none}</style>", "style"],
    ["script", "<script>window.__x = 1</script>", "script"],
    ["template", "<template><b>x</b></template>", "template"],
    ["math", "<math><mi>x</mi></math>", "math"],
  ])("drops %s", (_name, source, tag) => {
    expect(dom(source).querySelector(tag)).toBeNull();
  });

  it.each([
    ["onerror on img", '<img src="x.png" onerror="window.__x=1">', "img", "onerror"],
    ["onload on svg", '<svg onload="window.__x=1"></svg>', "svg", "onload"],
    ["onclick on div", '<div onclick="window.__x=1">x</div>', "div", "onclick"],
    ["style attribute", '<div style="position:fixed;inset:0">x</div>', "div", "style"],
    ["javascript href", '<a href="javascript:alert(1)">l</a>', "a", "href"],
    ["obfuscated javascript href", '<a href=" jav&#x09;ascript:alert(1)">l</a>', "a", "href"],
    ["vbscript href", '<a href="vbscript:x">l</a>', "a", "href"],
    ["data html href", '<a href="data:text/html,x">l</a>', "a", "href"],
    ["svg data image", '<img src="data:image/svg+xml,<svg/>">', "img", "src"],
    ["javascript in markdown link", "[m](javascript:alert(1))", "a", "href"],
  ])("removes %s", (_name, source, tag, attribute) => {
    const element = dom(source).querySelector(tag);
    expect(element).not.toBeNull();
    expect(element!.getAttribute(attribute)).toBeNull();
  });

  it("keeps ordinary Markdown and harmless HTML working", () => {
    const page = dom(
      [
        "# Title",
        "",
        "A [link](https://example.com) and [[other-page]] and **bold** <kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup>.",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "![img](https://example.com/a.png) ![local](assets/b.png) ![inline](data:image/png;base64,iVBORw0KGgo=)",
        "",
        "<details><summary>More</summary>hidden <mark>text</mark></details>",
        "",
        "Line<br>break",
      ].join("\n"),
    );
    expect(page.querySelector("h1")?.textContent).toContain("Title");
    expect(page.querySelector('a[href="https://example.com"]')).not.toBeNull();
    expect(page.querySelector('a[href="/page/v/other-page"]')).not.toBeNull();
    expect(page.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(page.querySelector("table td")?.textContent).toBe("1");
    expect(page.querySelector("pre code")?.textContent).toContain("const x = 1;");
    expect(page.querySelector("pre .copied")).not.toBeNull(); // the library's copy button
    expect(page.querySelectorAll("img")).toHaveLength(3);
    expect(page.querySelector('img[src^="data:image/png"]')).not.toBeNull();
    for (const tag of ["details", "summary", "mark", "kbd", "sub", "sup", "br", "strong"]) {
      expect(page.querySelector(tag), tag).not.toBeNull();
    }
  });

  it("keeps link targets people use", () => {
    for (const href of ["https://example.com/a?b#c", "http://127.0.0.1:8765/x", "mailto:a@b.c", "tel:+1", "/page/v/x", "#anchor", "relative/path"]) {
      expect(isSafeUrl(href, "a", "href"), href).toBe(true);
    }
  });

  it("is applied to every MDEditor.Markdown in the dashboard", () => {
    const sources = import.meta.glob("../**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    let renders = 0;
    for (const [file, text] of Object.entries(sources)) {
      if (file.endsWith(".test.tsx")) continue;
      const here = text.split("<MDEditor.Markdown").length - 1;
      renders += here;
      expect(text.split("{...SAFE_MARKDOWN_PROPS}").length - 1, file).toBe(here);
    }
    expect(renders).toBeGreaterThanOrEqual(3);
    expect(html('<iframe srcdoc="x"></iframe>')).not.toContain("iframe");
  });
});

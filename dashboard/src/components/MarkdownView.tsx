import MDEditor from "@uiw/react-md-editor";
import { SAFE_MARKDOWN_PROPS } from "../lib/markdown-safety";
import { useEffect, useState, type FC } from "react";
import { preprocessWikilinks } from "../lib/wikilink";

interface MarkdownViewProps {
    content: string;
    vault: string;
}

/**
 * v0.7.5+ — MarkdownView rewritten on @uiw/react-md-editor
 * (replaces react-markdown + remark/rehype stack).
 *
 * Why @uiw/react-md-editor:
 *   - WYSIWYG + Markdown source toggle → 사용자/에이전트 양쪽 친화
 *   - GitHub Markdown 스타일 기본 (Obsidian-like 가독성)
 *   - Active maintenance (2026년 기준 활발)
 *   - Plugin 시스템 (기존 wikilink 호환 유지)
 *
 * Wikilink 처리:
 *   - pre-process (string 변환): `[[slug]]` → `[slug](/page/{vault}/{slug})`
 *   - 의존성 0, @uiw/react-md-editor raw markdown 그대로 전달
 */
export const MarkdownView: FC<MarkdownViewProps> = ({ content, vault }) => {
    const [colorMode, setColorMode] = useState<"light" | "dark">(() => {
        if (typeof document === "undefined") return "light";
        return document.documentElement.classList.contains("dark") ? "dark" : "light";
    });

    useEffect(() => {
        if (typeof document === "undefined") return;
        const root = document.documentElement;
        const sync = () => setColorMode(root.classList.contains("dark") ? "dark" : "light");
        sync();
        const observer = new MutationObserver(sync);
        observer.observe(root, { attributes: true, attributeFilter: ["class"] });
        return () => observer.disconnect();
    }, []);

    // wikilink pre-process: [[slug]] → [slug](...)
    const processed = preprocessWikilinks(content ?? "", vault);

    // @uiw/react-md-editor는 data-color-mode="light|dark"를 읽는다.
    // Raven 디자인 토큰 (--color-body, --color-bg 등)은 globals.css에서 정의.
    return (
        <div className="raven-md-view" data-color-mode={colorMode}>
            <MDEditor.Markdown
                {...SAFE_MARKDOWN_PROPS}
                source={processed}
                style={{
                    backgroundColor: "transparent",
                    color: "var(--color-body)",
                }}
            />
        </div>
    );
};

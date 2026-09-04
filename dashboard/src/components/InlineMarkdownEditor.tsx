/**
 * InlineMarkdownEditor — inline MD split-view editor (v0.7.51+, AGENTS.md §6 인라인 편집 우선)
  * InlineMarkdownEditor — inline MD split-view editor (v0.7.51+, AGENTS.md §6 인라인 편집 우선)
  *
  * v0.7.51+ UX 재설계 — 의존성 0, Raven 디자인 토큰 일치:
  *   - view mode: MDEditor.Markdown preview (wikilink 전처리)
  *   - edit mode: 커스텀 toolbar (우리가 만든 <Button>) + textarea (monospace) + live preview
  *   - MDEditor full editor는 v0.7.5+ 도입했으나 toolbar/색상/border 모두 라이브러리 기본 —
  *     AGENTS.md §13 (재사용 컴포넌트, CSS 토큰) 위반. v0.7.51+에서 완전 제거.
  *   - 아이콘: 이모지 ❌ (OS별 렌더링 차이, 다크모드 깨짐) → inline SVG (Lucide-style,
  *     MIT, 디자인 톤 통일, currentColor → var(--color-ink) 자동 적용).
  *
  * v0.7.51+ 기능:
  *   - viewContent prop: view mode 정돈된 본문 (related.body), edit mode는 content
  *   - onSaved/onDeleted: 저장/삭제 콜백
  *   - deletePage는 InlineMarkdownEditor 내부 호출 (Jira/Notion-style 일관성)
  *
  * UX (v0.7.51+ 버튼 일관성):
  *   - 모든 액션 = <Button> 컴포넌트 (variant/size 통일)
  *   - 아이콘 = inline SVG (Lucide, MIT) — view: ✏ 🗑, edit: 💾 ✕
  *   - [✏] [🗑] / [💾] [✕] 순서 (primary → 보조, 왼쪽 → 오른쪽)
  *   - dirty = "● 저장 안 됨" indicator
  *   - Cmd+E / Ctrl+E → mode toggle
  *   - Esc (edit mode) → 취소
  *   - Cmd+S (edit mode) → 저장
  */
 import { useCallback, useEffect, useRef, useState } from "react";
 import MDEditor from "@uiw/react-md-editor";
 import { useNavigate } from "react-router-dom";
 import { deletePage, updatePage } from "../lib/api";
 import { preprocessWikilinks } from "../lib/wikilink";
 import { Button } from "./ui/Button";
 import { TextField } from "./ui/TextField";
 import { Toast } from "./ui/Toast";
 import { AITagSuggestion } from "./AITagSuggestion";
import { ShareButton } from "./ShareButton";

 // Lucide-style SVG icons (MIT, public domain). 16x16 viewBox, currentColor 사용
 // → var(--color-ink) / hover 시 var(--color-accent) 자동 적용.
 const Icon = {
   Edit: () => (
     <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
       aria-hidden="true" style={{ display: "block" }}>
       <path d="M12 20h9" />
       <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
     </svg>
   ),
   Trash: () => (
     <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
       aria-hidden="true" style={{ display: "block" }}>
       <polyline points="3 6 5 6 21 6" />
       <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
       <path d="M10 11v6" />
       <path d="M14 11v6" />
       <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
     </svg>
   ),
   Save: () => (
     <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
       aria-hidden="true" style={{ display: "block" }}>
       <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
       <polyline points="17 21 17 13 7 13 7 21" />
       <polyline points="7 3 7 8 15 8" />
     </svg>
   ),
   X: () => (
     <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
       aria-hidden="true" style={{ display: "block" }}>
       <line x1="18" y1="6" x2="6" y2="18" />
       <line x1="6" y1="6" x2="18" y2="18" />
     </svg>
   ),
   Eye: () => (
     <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
       aria-hidden="true" style={{ display: "block" }}>
       <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
       <circle cx="12" cy="12" r="3" />
     </svg>
   ),
   EyeOff: () => (
     <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
       aria-hidden="true" style={{ display: "block" }}>
       <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
       <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
       <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
       <line x1="1" y1="1" x2="23" y2="23" />
     </svg>
   ),
   Link: () => (
     <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
       aria-hidden="true" style={{ display: "block" }}>
       <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
       <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
     </svg>
   ),
   };

  interface InlineMarkdownEditorProps {
   vault: string;
   slug: string;
   title: string;
   content: string;
   /** view mode일 때 표시할 정돈된 본문 (예: related.body). 없으면 content 사용. */
   viewContent?: string;
   /** 저장 후 콜백 (백엔드 + UI 갱신). */
   onSaved?: () => void;
   /** 삭제 후 콜백 (백엔드 deletePage + navigate). */
   onDeleted?: () => void;
   /** 이 본부를 읽은 시점의 on-disk 상태 토큰 (v0.7.178).
    *  전달하면 저장 시 그 상태가 아지 유효한지 서버가 검사해 lost update를 막는다. */
   precondition?: string;
   metaRow?: React.ReactNode;
   filePathRow?: React.ReactNode;
 }
 
 export function InlineMarkdownEditor({
   vault,
   slug,
   title,
   content,
   viewContent,
   onSaved,
   onDeleted,
   precondition,
   metaRow,
   filePathRow,
 }: InlineMarkdownEditorProps) {
   const [mode, setMode] = useState<"view" | "edit">("view");
   // edit 모드 draft = 전체 MD 원본 (content).
   const [draft, setDraft] = useState(content);
   // edit 모드 title draft.
   const [titleVal, setTitleVal] = useState(title);
   const [busy, setBusy] = useState(false);
   const [toast, setToast] = useState<string | null>(null);
   const [toastType, setToastType] = useState<"success" | "error">("success");
   const [showPreview, setShowPreview] = useState<boolean>(true);
   const draftKey = `raven:draft:${vault}:${slug}`;
   const [recoverableDraft, setRecoverableDraft] = useState<string | null>(null);
   const savedDraftRef = useRef<string | null>(null);
   const [colorMode, setColorMode] = useState<"light" | "dark">(() => {
     if (typeof document === "undefined") return "light";
     return document.documentElement.classList.contains("dark") ? "dark" : "light";
   });
   const textareaRef = useRef<HTMLTextAreaElement>(null);
   const navigate = useNavigate();
   const containerRef = useRef<HTMLDivElement>(null);

   // 외부 content/title 변경 (다른 vault에서 페이지 fetch) 시 draft/titleVal reset
   useEffect(() => {
     setDraft(content);
     setTitleVal(title);
     setMode("view");
   }, [content, title, vault, slug]);

   // dark mode sync
   useEffect(() => {
     if (typeof document === "undefined") return;
     const root = document.documentElement;
     const sync = () => setColorMode(root.classList.contains("dark") ? "dark" : "light");
     sync();
     const observer = new MutationObserver(sync);
     observer.observe(root, { attributes: true, attributeFilter: ["class"] });
     return () => observer.disconnect();
   }, []);

   // Cmd+E / Ctrl+E → mode toggle
   useEffect(() => {
     const onKey = (e: KeyboardEvent) => {
       if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
         e.preventDefault();
         setMode((m) => (m === "view" ? "edit" : "view"));
       } else if (e.key === "Escape" && mode === "edit") {
         e.preventDefault();
         cancel();
       } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && mode === "edit") {
         // Cmd+S → 저장 (브라우저 기본 "페이지 저장" 방지)
         e.preventDefault();
         if (dirty) save();
       }
     };
     document.addEventListener("keydown", onKey);
     return () => document.removeEventListener("keydown", onKey);
     // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [mode, draft, titleVal]);

   const dirty = draft !== content || titleVal !== title;

   useEffect(() => {
     savedDraftRef.current = null;
     let stored: string | null = null;
     try {
       stored = localStorage.getItem(draftKey);
     } catch {
       stored = null;
     }
     setRecoverableDraft(stored !== null && stored !== content ? stored : null);
   }, [draftKey, content]);

   useEffect(() => {
     if (mode !== "edit") return;
     if (draft === savedDraftRef.current) return;
     try {
       if (dirty) localStorage.setItem(draftKey, draft);
       else localStorage.removeItem(draftKey);
     } catch {
       setRecoverableDraft(null);
     }
   }, [mode, draft, dirty, draftKey]);

   useEffect(() => {
     if (!dirty) return;
     const warn = (e: BeforeUnloadEvent) => {
       e.preventDefault();
       e.returnValue = "";
     };
     window.addEventListener("beforeunload", warn);
     return () => window.removeEventListener("beforeunload", warn);
   }, [dirty]);

   const recoverDraft = useCallback(() => {
     setRecoverableDraft((pending) => {
       if (pending !== null) {
         setDraft(pending);
         setMode("edit");
       }
       return null;
     });
   }, []);

   const discardDraft = useCallback(() => {
     try {
       localStorage.removeItem(draftKey);
     } catch {
       setRecoverableDraft(null);
     }
     setRecoverableDraft(null);
   }, [draftKey]);

   const cancel = useCallback(() => {
     setDraft(content);
     setTitleVal(title);
     setMode("view");
   }, [content, title]);

   const save = async () => {
     if (busy) return;
     setBusy(true);
     setToast(null);
     try {
       await updatePage(vault, slug, { content: draft, title: titleVal, precondition });
      savedDraftRef.current = draft;
      try {
        localStorage.removeItem(draftKey);
      } catch {
        setRecoverableDraft(null);
      }
      setRecoverableDraft(null);
       setToast("✅ 저장 완료");
      setToastType("success");
       setTimeout(() => {
         setMode("view");
         setToast(null);
         onSaved?.();
       }, 2400);
     } catch (e) {
       const msg = e instanceof Error ? e.message : String(e);
       setToast(`❌ 저장 실패: ${msg}`);
      setToastType("error");
     } finally {
       setBusy(false);
     }
   };

   const remove = async () => {
     if (busy) return;
     if (!window.confirm(`'${slug}'을(를) 삭제(아카이빙)할까요?`)) return;
     setBusy(true);
     setToast(null);
     try {
       await deletePage(vault, slug);
       setToast("🗑 삭제(아카이빙) 완료");
      setToastType("success");
       setTimeout(() => {
         onDeleted?.();
         navigate("/");
       }, 2400);
     } catch (e) {
       const msg = e instanceof Error ? e.message : String(e);
       setToast(`❌ 삭제 실패: ${msg}`);
      setToastType("error");
     } finally {
       setBusy(false);
     }
   };

   // toolbar 액션: textarea에 텍스트 삽입 (selection 유지)
   const insertText = useCallback(
     (before: string, after: string = before, placeholder: string = "") => {
       const ta = textareaRef.current;
       if (!ta) return;
       const start = ta.selectionStart;
       const end = ta.selectionEnd;
       const selected = draft.slice(start, end) || placeholder;
       const next = draft.slice(0, start) + before + selected + after + draft.slice(end);
       setDraft(next);
       // selection을 삽입된 텍스트 끝으로
       requestAnimationFrame(() => {
         if (!ta) return;
         const cursorStart = start + before.length;
         const cursorEnd = cursorStart + selected.length;
         ta.focus();
         ta.setSelectionRange(cursorStart, cursorEnd);
       });
     },
     [draft]
   );

   const toolbarActions: Array<{
    label: string;
    icon: React.ReactNode;
    title: string;
    run: () => void;
  }> = [
    { label: "H1", icon: <span style={{ fontWeight: 700 }}>H1</span>, title: "제목 1", run: () => insertText("\n# ") },
    { label: "H2", icon: <span style={{ fontWeight: 700 }}>H2</span>, title: "제목 2", run: () => insertText("\n## ") },
    { label: "H3", icon: <span style={{ fontWeight: 700 }}>H3</span>, title: "제목 3", run: () => insertText("\n### ") },
    { label: "굵게", icon: <span style={{ fontWeight: 800 }}>B</span>, title: "굵게 (Cmd+B)", run: () => insertText("**", "**", "굵은 텍스트") },
    { label: "기울임", icon: <span style={{ fontStyle: "italic", fontWeight: 600 }}>I</span>, title: "기울임 (Cmd+I)", run: () => insertText("*", "*", "기울임") },
    { label: "코드", icon: <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{"</>"}</span>, title: "인라인 코드", run: () => insertText("`", "`", "code") },
    { label: "블록", icon: <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{"▤"}</span>, title: "코드 블록", run: () => insertText("\n```\n", "\n```\n", "code block") },
    { label: "링크", icon: <Icon.Link />, title: "링크", run: () => insertText("[", "](https://)", "텍스트") },
    { label: "wikilink", icon: <span style={{ fontSize: 11, fontWeight: 700 }}>{"[[ ]]"}</span>, title: "위키링크", run: () => insertText("[[", "]]", "slug") },
    { label: "목록", icon: <span style={{ fontWeight: 700 }}>≡</span>, title: "순서 없는 목록", run: () => insertText("\n- ", "", "항목") },
    { label: "인용", icon: <span style={{ fontWeight: 700 }}>❮</span>, title: "인용", run: () => insertText("\n> ", "", "인용 텍스트") },
  ];

   // view mode에서 보여줄 본문: viewContent (정돈) > content (raw)
   const displayContent = viewContent ?? content;
   // edit mode preview: wikilink 전처리 (MDEditor.Markdown에 넘김)
   const previewSource = preprocessWikilinks(draft, vault);

   return (
      <div ref={containerRef} data-color-mode={colorMode}>
     {/* 타이틀과 액션 버튼을 가로 한 줄에 좌측 정렬 배치 */}
     <div
       style={{
         display: "flex",
         justifyContent: "flex-start",
         alignItems: "center",
         gap: 16,
         marginBottom: 8,
         flexWrap: "wrap",
       }}
     >
       {/* Title - Left */}
       <div style={{ flex: mode === "edit" ? 1 : "0 0 auto", minWidth: 0 }}>
         {mode === "view" ? (
           <h1
             style={{
               margin: 0,
               fontSize: 32,
               fontWeight: 800,
               lineHeight: 1.25,
               letterSpacing: "-0.5px",
               color: "var(--color-ink)",
             }}
           >
             {titleVal}
           </h1>
         ) : (
           <TextField
             label=""
             value={titleVal}
             onChange={(e) => setTitleVal(e.target.value)}
             placeholder="문서 제목"
             disabled={busy}
             style={{ fontSize: 24, fontWeight: 800 }}
           />
         )}
       </div>

       {/* Actions - Right */}
       <div
         className="inline-md-actions"
         style={{
           display: "flex",
           alignItems: "center",
           gap: 6,
           flexShrink: 0,
           paddingTop: 4,
         }}
       >
         {mode === "view" ? (
           <>
             <ShareButton vault={vault} slug={slug} />
             <Button
               type="button"
               variant="primary"
               size="sm"
               onClick={() => setMode("edit")}
               title="편집 (Cmd+E)"
               aria-label="편집"
               style={{ minWidth: 36, padding: "0 8px" }}
             >
               <Icon.Edit />
             </Button>
             <Button
               type="button"
               variant="ghost"
               size="sm"
               onClick={remove}
               title="삭제 (아카이빙)"
               aria-label="삭제"
               disabled={busy}
               style={{ minWidth: 36, padding: "0 8px" }}
             >
               <Icon.Trash />
             </Button>
           </>
         ) : (
           <>
             <Button
               type="button"
               variant="primary"
               size="sm"
               onClick={save}
               disabled={busy || !dirty}
               title="저장 (Cmd+S)"
               aria-label="저장"
               style={{ minWidth: 36, padding: "0 8px" }}
             >
               <Icon.Save />
             </Button>
             <Button
               type="button"
               variant="ghost"
               size="sm"
               onClick={cancel}
               disabled={busy}
               title="취소 (Esc)"
               aria-label="취소"
               style={{ minWidth: 36, padding: "0 8px" }}
             >
               <Icon.X />
             </Button>
             {dirty && (
               <span
                 style={{
                   fontSize: 12,
                   color: "var(--color-warning, #c00)",
                   fontWeight: 700,
                   padding: "0 8px",
                   marginLeft: 4,
                 }}
                 title="저장되지 않은 변경"
                 aria-label="저장되지 않은 변경"
               >
                 ● 저장 안 됨
               </span>
             )}
           </>
         )}
       </div>
     </div>

     {/* Meta & Path Sub-header (타이틀과 본문 사이에 깔끔하게 배치) */}
     {(metaRow || filePathRow) && (
       <div
         style={{
           display: "flex",
           flexDirection: "column",
           gap: 8,
           marginTop: 4,
           marginBottom: 20,
         }}
       >
         {filePathRow}
         {metaRow}
       </div>
     )}

     {/* Toast */}
     <Toast open={Boolean(toast)} message={toast ?? ""} type={toastType} />

    {recoverableDraft !== null && mode === "view" && (
      <div
        role="status"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "10px 14px",
          marginBottom: 16,
          border: "1px solid var(--color-hairline)",
          borderRadius: "var(--radius-md)",
          background: "var(--color-surface)",
          color: "var(--color-body)",
          fontSize: 14,
        }}
      >
        <span>저장하지 않은 초안이 남아 있습니다.</span>
        <Button type="button" variant="primary" size="sm" onClick={recoverDraft} aria-label="초안 복구">
          초안 복구
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={discardDraft} aria-label="초안 버리기">
          버리기
        </Button>
      </div>
    )}

    {/* Body: view vs edit */}
    <div className="inline-md-body">
         {mode === "view" ? (
           <MDEditor.Markdown
             source={displayContent ?? ""}
             style={{
               backgroundColor: "transparent",
               color: "var(--color-body)",
             }}
           />
         ) : (
           <div
             className="inline-md-editor"
             style={{
               border: "1px solid var(--color-hairline)",
               borderRadius: 8,
               overflow: "hidden",
               background: "var(--color-canvas)",
             }}
           >
             {/* Toolbar (v0.7.51+: MDEditor toolbar 제거, 우리 <Button>으로 통일) */}
             <div
               className="inline-md-toolbar"
               style={{
                 display: "flex",
                 alignItems: "center",
                 gap: 4,
                 padding: "8px 10px",
                 background: "var(--color-surface-soft, var(--color-canvas))",
                 borderBottom: "1px solid var(--color-hairline)",
                 flexWrap: "wrap",
               }}
             >
               {toolbarActions.map((a) => (
                 <button
                   key={a.label}
                   type="button"
                   onClick={a.run}
                   title={a.title}
                   aria-label={a.label}
                   style={{
                     height: 28,
                     minWidth: 28,
                     padding: "0 8px",
                     background: "transparent",
                     border: "1px solid transparent",
                     borderRadius: 4,
                     cursor: "pointer",
                     fontSize: 12,
                     color: "var(--color-ink)",
                     fontFamily: "var(--font-display, system-ui)",
                     fontWeight: 600,
                     transition: "background 100ms ease-out, border-color 100ms ease-out",
                   }}
                   onMouseEnter={(e) => {
                     e.currentTarget.style.background = "var(--btn-ghost-bg-hover)";
                     e.currentTarget.style.borderColor = "var(--color-hairline)";
                   }}
                   onMouseLeave={(e) => {
                     e.currentTarget.style.background = "transparent";
                     e.currentTarget.style.borderColor = "transparent";
                   }}
                 >
                   {a.icon}
                 </button>
               ))}
               <div style={{ flex: 1 }} />
               <Button
                 type="button"
                 variant="ghost"
                 size="sm"
                 onClick={() => setShowPreview((s) => !s)}
                 title="미리보기 토글"
                 style={{ minWidth: 36, padding: "0 8px" }}
               >
                 {showPreview ? <Icon.Eye /> : <Icon.EyeOff />}
               </Button>
               </div>

              {/* AI tag suggestion */}
              <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--color-hairline)" }}>
                <AITagSuggestion
                  vault={vault}
                  content={draft.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)?.[2] || draft}
                  title={titleVal}
                  onAccept={(newTags) => {
                    const match = draft.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
                    if (!match) {
                      const fm = `---\ntags: [${newTags.join(", ")}]\n---\n`;
                      setDraft(fm + draft);
                      return;
                    }
                    const fmText = match[1];
                    const bodyText = match[2];
                    const tagsMatch = fmText.match(/tags:\s*\[(.*?)\]/);
                    let existingTags: string[] = [];
                    if (tagsMatch) {
                      existingTags = tagsMatch[1].split(",").map(t => t.trim()).filter(Boolean);
                    } else {
                      const multilineMatch = fmText.match(/tags:\r?\n((?:\s*-\s*\S+\r?\n?)*)/);
                      if (multilineMatch) {
                        existingTags = multilineMatch[1].split("\n").map(l => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
                      }
                    }
                    const mergedTags = Array.from(new Set([...existingTags, ...newTags]));
                    let newFmText = fmText;
                    if (tagsMatch) {
                      newFmText = fmText.replace(/tags:\s*\[.*?\]/, `tags: [${mergedTags.join(", ")}]`);
                    } else if (fmText.match(/tags:\r?\n((?:\s*-\s*\S+\r?\n?)*)/)) {
                      newFmText = fmText.replace(/tags:\r?\n((?:\s*-\s*\S+\r?\n?)*)/, `tags: [${mergedTags.join(", ")}]\n`);
                    } else {
                      newFmText = fmText.trim() + `\ntags: [${mergedTags.join(", ")}]`;
                    }
                    setDraft(`---\n${newFmText}\n---\n${bodyText}`);
                  }}
                />
              </div>

             {/* Editor + (optional) Preview split */}
             <div
               className="inline-md-split"
               style={{
                 display: "grid",
                 gridTemplateColumns: showPreview ? "minmax(0, 1fr) minmax(0, 1fr)" : "1fr",
                 minHeight: 400,
                 background: "var(--color-canvas)",
               }}
             >
               {/* Source textarea */}
               <textarea
                 ref={textareaRef}
                 value={draft}
                 onChange={(e) => setDraft(e.target.value)}
                 disabled={busy}
                 spellCheck={false}
                 style={{
                   width: "100%",
                   minHeight: 400,
                   maxHeight: "70vh",
                   padding: "16px 20px",
                   fontSize: 14,
                   lineHeight: 1.65,
                   fontFamily:
                     "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                   color: "var(--color-ink)",
                   background: "var(--color-canvas)",
                   border: 0,
                   borderRight: showPreview ? "1px solid var(--color-hairline)" : "none",
                   outline: "none",
                   resize: "vertical",
                   whiteSpace: "pre-wrap",
                   wordBreak: "break-word",
                   tabSize: 2,
                 }}
               />

               {/* Live preview (MDEditor.Markdown wikilink 전처리) */}
               {showPreview && (
                 <div
                   className="inline-md-preview"
                   style={{
                     padding: "16px 20px",
                     maxHeight: "70vh",
                     overflowY: "auto",
                     background: "var(--color-surface-soft, var(--color-canvas))",
                   }}
                 >
                   <MDEditor.Markdown
                     source={previewSource}
                     style={{
                       backgroundColor: "transparent",
                       color: "var(--color-body)",
                       fontSize: 14,
                       lineHeight: 1.65,
                     }}
                   />
                 </div>
               )}
             </div>
           </div>
         )}
       </div>
     </div>
   );
 }

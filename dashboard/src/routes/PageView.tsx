import { useEffect, useMemo, useState } from "react";
import { useParams, useOutletContext, useNavigate } from "react-router-dom";
import { MarkdownView } from "../components/MarkdownView";
import { FloatingGraphPanel } from "../components/FloatingGraphPanel";
import { FullscreenGraphModal } from "../components/FullscreenGraphModal";
import { BacklinksPanel } from "../components/BacklinksPanel";
import { InlineMarkdownEditor } from "../components/InlineMarkdownEditor";
import { PageMetaRow } from "../components/PageMetaRow";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { EmptyIcon } from "../lib/emptyIcons";
import { deletePage, fetchPage, getActiveVault, sendPageFeedback, updatePage, deletePageFeedback, updatePageFeedback, fetchRecommendations, commitDraft, deleteDraft , apiFetch} from "../lib/api";
import { PropertiesPanel } from "../components/PropertiesPanel";
import type { Graph, Page, Recommendation } from "../types";

interface Ctx {
  vault: string;
  refresh: () => void;
}

export function buildLocalGraph(graph: Graph, centerSlug: string): Graph {
  const center = resolveGraphId(graph, centerSlug);
  if (!center) return { nodes: [], edges: [] };

  const localIds = new Set<string>([center]);
  const localEdges = graph.edges.filter((edge) => {
    const source = edge.source;
    const target = edge.target;
    const connected = source === center || target === center;
    if (connected) {
      localIds.add(source);
      localIds.add(target);
    }
    return connected;
  });

  return {
    nodes: graph.nodes.filter((node) => localIds.has(node.id)),
    edges: localEdges,
  };
}


// Raven page bodies conventionally start with "# {title}" (see `raven page new`)
// so the raw .md file stays self-contained for CLI/git readers. The dashboard
// already renders `page.title` as its own <h1>, so strip that duplicate leading
// heading here before the body reaches MarkdownView — otherwise the title shows
// twice on every page.
export function stripLeadingTitleHeading(content: string, title: string): string {
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const heading = lines[i]?.trim().replace(/^#\s+/, "");
  if (i >= lines.length || heading !== title.trim()) return content;
  return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
}

export function splitRelatedSection(content: string): { body: string; links: string[] } {
  const extractLinks = (text: string): string[] => {
    const links: string[] = [];
    const seen = new Set<string>();
    const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
    for (const match of text.matchAll(re)) {
      let slug = match[1].trim();
      if (slug.endsWith(".md")) slug = slug.slice(0, -3);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      links.push(slug);
    }
    return links;
  };

  const lines = content.split(/\r?\n/);
  const idx = lines.findIndex((line) => line.trim().replace(/^#+\s*/, "") === "관련");
  if (idx >= 0) {
    const body = lines.slice(0, idx).join("\n").trimEnd();
    return { body, links: extractLinks(lines.slice(idx + 1).join("\n")) };
  }

  // Some Raven pages end with a wikilink-only paragraph instead of an explicit
  // "관련" heading. Treat that trailing paragraph as structured related data.
  const paragraphs = content.trimEnd().split(/\n\s*\n/);
  const tail = paragraphs[paragraphs.length - 1] ?? "";
  const tailLinks = extractLinks(tail);
  const tailWithoutLinks = tail
    .replace(/\[\[[^\]]+\]\]/g, "")
    .replace(/[·,|\-–—\s]/g, "")
    .trim();
  if (tailLinks.length > 0 && tailWithoutLinks.length === 0) {
    return {
      body: paragraphs.slice(0, -1).join("\n\n").trimEnd(),
      links: tailLinks,
    };
  }

  return { body: content, links: [] };
}

export interface FeedbackItem {
  timestamp: string;
  actor: string;
  feedback: string;
}

export function splitFeedbackSection(content: string): { body: string; feedbacks: FeedbackItem[] } {
  const lines = content.split(/\r?\n/);
  const idx = lines.findIndex((line) => line.trim() === "## 피드백");
  if (idx === -1) {
    return { body: content, feedbacks: [] };
  }
  const body = lines.slice(0, idx).join("\n").trimEnd();
  const feedbacks: FeedbackItem[] = [];
  const feedbackLines = lines.slice(idx + 1);

  // Parse items like: * **2026-07-09 17:37 (user)**: 피드백 내용
  const re = /^\*\s+\*\*([^*]+)\s+\(([^)]+)\)\*\*:\s+(.*)$/;
  for (const line of feedbackLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(re);
    if (match) {
      feedbacks.push({
        timestamp: match[1].trim(),
        actor: match[2].trim(),
        feedback: match[3].trim(),
      });
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      feedbacks.push({
        timestamp: "",
        actor: "unknown",
        feedback: trimmed.replace(/^[-*]\s+/, ""),
      });
    }
  }
  return { body, feedbacks };
}

// Match a graph node id by suffix of path segments. Both "users" and
// "concept/users" should resolve to id "concept/users" so URL slugs that
// carry an extra prefix (e.g. "content/concept/users") still find a node.
export function resolveGraphId(graph: Graph, slug: string): string | null {
  const ids = graph.nodes.map((n) => n.id);
  if (ids.includes(slug)) return slug;
  const segments = slug.split("/");
  const matches = ids.filter((id) => {
    const idSegs = id.split("/");
    // id is a suffix of slug: idSegs == last N segments of slug
    if (idSegs.length <= segments.length) {
      return segments.slice(-idSegs.length).every((s, i) => s === idSegs[i]);
    }
    // slug is a suffix of id: slug == last N segments of id
    return idSegs.slice(-segments.length).every((s, i) => s === segments[i]);
  });
  if (matches.length === 0) return null;
  return matches.sort((a, b) => a.length - b.length)[0];
}

export function buildRelatedGraph(graph: Graph, centerSlug: string, relatedLinks: string[]): Graph {
  const center = resolveGraphId(graph, centerSlug);
  if (!center) return { nodes: [], edges: [] };

  const ids = new Set<string>([center]);
  for (const link of relatedLinks) {
    const resolved = resolveGraphId(graph, link);
    if (resolved) ids.add(resolved);
  }

  const edges = graph.edges.filter((edge) => {
    const source = edge.source;
    const target = edge.target;
    return ids.has(source) && ids.has(target);
  });

  return {
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges,
  };
}

export function PageView() {
  console.log("[Raven-Debug] PageView mount");
  const navigate = useNavigate();
  const params = useParams();
  const slug = params["*"];
  // v0.6.9 (P15 fix): URL의 :vault 파라미터를 SOT로 사용. Layout의 ctx.vault가
  // Wizard 후 stale여도 URL 우선이면 stale race 차단.
  const vaultFromUrl = params.vault;
  const ctx = useOutletContext<Ctx>();
  const vault = vaultFromUrl || ctx?.vault || getActiveVault() || "default";
  console.log("[Raven-Debug] PageView vault=", vault, "slug=", slug);
  const [page, setPage] = useState<Page | null | undefined>(undefined);
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [err, setErr] = useState<string | null>(null);
  const [showFullGraph, setShowFullGraph] = useState(false);
  const isDraft = typeof slug === "string" && slug.startsWith("drafts/");
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftToast, setDraftToast] = useState<{ msg: string; ok: boolean } | null>(null);
  // Bumped after a save so the fetchPage effect below re-runs even though
  // slug/vault haven't changed — otherwise the article stays stale until
  // the user navigates away and back.
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [hoveredRelKey, setHoveredRelKey] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  
  const [feedbackText, setFeedbackText] = useState("");
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [feedbackErr, setFeedbackErr] = useState<string | null>(null);

  const [editingFeedbackIdx, setEditingFeedbackIdx] = useState<number | null>(null);
  const [editingFeedbackText, setEditingFeedbackText] = useState("");

  const handleDeleteFeedback = async (idx: number) => {
    if (!window.confirm("이 피드백을 삭제하시겠습니까?")) return;
    try {
      await deletePageFeedback(vault, slug!, idx, page?.precondition);
      setReloadKey((k) => k + 1);
      ctx?.refresh?.();
    } catch (err: any) {
      alert(`삭제 실패: ${err.message || err}`);
    }
  };

  const handleSaveFeedback = async (idx: number) => {
    if (!editingFeedbackText.trim()) return;
    try {
      await updatePageFeedback(vault, slug!, idx, {
        feedback: editingFeedbackText.trim(),
        precondition: page?.precondition,
      });
      setEditingFeedbackIdx(null);
      setReloadKey((k) => k + 1);
      ctx?.refresh?.();
    } catch (err: any) {
      alert(`수정 실패: ${err.message || err}`);
    }
  };

  const handleSubmitFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedbackText.trim() || !slug) return;
    setIsSubmittingFeedback(true);
    setFeedbackErr(null);
    try {
      await sendPageFeedback(vault, slug, {
        feedback: feedbackText.trim(),
        actor: "user",
        precondition: page?.precondition,
      });
      setFeedbackText("");
      setReloadKey((k) => k + 1);
      ctx?.refresh?.();
    } catch (err: any) {
      setFeedbackErr(err.message || String(err));
    } finally {
      setIsSubmittingFeedback(false);
    }
  };

  const handleCopy = () => {
    if (page?.filePath) {
      navigator.clipboard.writeText(page.filePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    if (!slug) {
      console.log("[Raven-Debug] useEffect early return (no slug)");
      return;
    }
    console.log("[Raven-Debug] useEffect fetchPage start");
    setPage(undefined);
    setErr(null);
    setRecommendations([]);
    fetchPage(vault, slug)
      .then((d) => {
        console.log("[Raven-Debug] fetchPage OK, slug=", d.slug);
        const fm = d.frontmatter || {};
        const tags = (fm.tags || "").replace(/[\[\]]/g, "").trim();
        setPage({
          slug: d.slug,
          title: fm.title || d.slug,
          type: fm.type || "?",
          path: d.slug,
          filePath: d.file_path,
          created: fm.created || "",
          updated: fm.updated || "",
          tags,
          content: d.content,
          backlinks: d.backlinks || [],
          issueStatus: fm.issue_status || "",
          relations: fm.relations || [],
          precondition: d.precondition || "",
        });
        console.log("[Raven-Debug] setPage done");

        // Fetch related recommendations
        fetchRecommendations(vault, d.slug)
          .then((recData) => {
            setRecommendations(recData.recommendations || []);
          })
          .catch((e) => {
            console.log("[Raven-Debug] fetchRecommendations CATCH:", e);
            setRecommendations([]);
          });
      })
      .catch((e) => {
        console.log("[Raven-Debug] fetchPage CATCH:", e);
        setErr(String(e.message || e));
        setPage(null);
      });
  }, [slug, vault, reloadKey]);

  useEffect(() => {
    if (!vault) return;
    apiFetch(`/api/vaults/${encodeURIComponent(vault)}/graph`)
      .then((r) => (r.ok ? r.json() : { nodes: [], edges: [] }))
      .then((d) => setGraph({ nodes: d.nodes ?? [], edges: d.edges ?? [] }))
      .catch(() => setGraph({ nodes: [], edges: [] }));
  }, [vault]);

  const parsedData = useMemo(() => {
    if (!page) return { body: "", links: [], feedbacks: [] };
    const cleaned = stripLeadingTitleHeading(page.content, page.title);
    const rel = splitRelatedSection(cleaned);
    const fb = splitFeedbackSection(rel.body);
    return {
      body: fb.body,
      links: rel.links,
      feedbacks: fb.feedbacks,
    };
  }, [page]);

  const localGraph = useMemo(() => {
    if (!page) return { nodes: [], edges: [] };
    const relatedGraph = buildRelatedGraph(graph, page.slug, parsedData.links);
    return relatedGraph.nodes.length > 1 ? relatedGraph : buildLocalGraph(graph, page.slug);
  }, [graph, page, parsedData.links]);

  const currentGraphNodeId = useMemo(
    () => (page ? resolveGraphId(graph, page.slug) : null),
    [graph, page]
  );

  if (page === undefined) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: "48px 24px",
          color: "var(--color-muted)",
          fontFamily: "var(--font-display)",
          fontSize: 14,
        }}
      >
        문서를 불러오는 중입니다...
      </div>
    );
  }
  if (page === null) {
    return (
      <EmptyState
        icon={<EmptyIcon.File />}
        title="문서를 찾을 수 없습니다"
        description={`보관소 '${vault}'에서 '${slug}' 문서를 불러오지 못했습니다. 경로가 올바른지 확인해주세요.`}
        action={
          <Button type="button" variant="primary" size="sm" onClick={() => navigate("/")}>
            홈으로 가기
          </Button>
        }
      />
    );
  }

  return (
    <div className="page-grid">
      <article style={{ minWidth: 0 }}>
        {/* 초안 배너: drafts/ slug일 때 커밋/삭제 액션 제공 */}
        {isDraft && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 16px",
            marginBottom: 16,
            borderRadius: 8,
            background: "rgba(234, 179, 8, 0.08)",
            border: "1px solid rgba(234, 179, 8, 0.3)",
            fontSize: 13,
          }}>
            <span style={{ fontSize: 16 }}>📋</span>
            <span style={{ flex: 1, color: "var(--color-ink)", fontWeight: 500 }}>
              에이전트가 작성한 초안입니다. 검토 후 vault에 커밋하거나 삭제하세요.
            </span>
            {draftToast && (
              <span style={{ color: draftToast.ok ? "var(--color-success-text)" : "var(--color-danger)", fontWeight: 600, fontSize: 12 }}>
                {draftToast.msg}
              </span>
            )}
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={draftBusy}
              onClick={async () => {
                if (!slug) return;
                setDraftBusy(true);
                try {
                  const draftName = slug.replace(/^drafts\//, "");
                  await commitDraft(vault, { draft_slug: slug });
                  setDraftToast({ msg: "✅ 커밋 완료", ok: true });
                  setTimeout(() => setDraftToast(null), 2400);
                  ctx?.refresh?.();
                  window.dispatchEvent(new CustomEvent("raven-draft-changed"));
                  navigate(`/page/${vault}/content/${draftName}`);
                } catch (e: any) {
                  setDraftToast({ msg: `오류: ${e.message}`, ok: false });
                  setTimeout(() => setDraftToast(null), 2400);
                } finally {
                  setDraftBusy(false);
                }
              }}
            >
              vault에 커밋
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={draftBusy}
              onClick={async () => {
                if (!slug || !window.confirm("이 초안을 삭제하시겠습니까?")) return;
                setDraftBusy(true);
                try {
                  const draftName = slug.replace(/^drafts\//, "");
                  await deleteDraft(vault, draftName);
                  window.dispatchEvent(new CustomEvent("raven-draft-changed"));
                  navigate("/");
                } catch (e: any) {
                  setDraftToast({ msg: `오류: ${e.message}`, ok: false });
                  setTimeout(() => setDraftToast(null), 2400);
                } finally {
                  setDraftBusy(false);
                }
              }}
            >
              삭제
            </Button>
          </div>
        )}
        {/* Properties Panel — type/tags 편집 + 문서 연결 */}
        <PropertiesPanel
          vault={vault}
          page={page}
          onSaved={() => {
            setReloadKey((k) => k + 1);
            ctx?.refresh?.();
          }}
        />
        {/* Body — InlineMarkdownEditor (자체 title+actions+editor).
            v0.7.51+ viewContent = 정돈된 본문 (related.body), 편집 모드 전환 시
            전체 MD 원본(content) 안전 수정. onDeleted는 InlineMarkdownEditor
            내부에서 deletePage 호출 — 성공 시 navigate("/"). */}
        <InlineMarkdownEditor
          vault={vault}
          slug={page.slug}
          title={page.title}
          content={page.content}
          viewContent={parsedData.body}
          precondition={page.precondition}
          onSaved={() => {
            setReloadKey((k) => k + 1);
            ctx?.refresh?.();
          }}
          onDeleted={() => {
            ctx?.refresh?.();
          }}
          filePathRow={
            page.filePath ? (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: 11,
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  color: "var(--color-muted)",
                  wordBreak: "break-all",
                  backgroundColor: "var(--hover-overlay)",
                  padding: "4px 8px",
                  borderRadius: "4px",
                  maxWidth: "100%",
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0, color: "var(--color-muted)" }}
                >
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="2" y1="10" x2="22" y2="10" />
                  <line x1="6" y1="6" x2="6.01" y2="6" />
                  <line x1="10" y1="6" x2="10.01" y2="6" />
                </svg>
                <span>물리 파일 경로: {page.filePath}</span>
                <button
                  type="button"
                  onClick={handleCopy}
                  title="복사하기"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "none",
                    border: "none",
                    padding: "2px",
                    cursor: "pointer",
                    color: copied ? "var(--color-success-text)" : "var(--color-muted)",
                    borderRadius: "3px",
                    marginLeft: "4px",
                    flexShrink: 0,
                    transition: "color 0.2s, background-color 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "var(--hover-overlay)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  {copied ? (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            ) : null
          }
          metaRow={
            <PageMetaRow
              type={page.type}
              slug={page.slug || page.path}
              tags={page.tags || ""}
              updated={page.updated}
              issueStatus={page.issueStatus}
              onStatusChange={async (newStatus) => {
                try {
                  const tagArray = page.tags
                    ? page.tags.split(",").map((t) => t.trim()).filter(Boolean)
                    : [];
                  await updatePage(vault, page.slug, {
                    content: page.content,
                    title: page.title,
                    type: page.type,
                    tags: tagArray,
                    extra_meta: { issue_status: newStatus },
                    precondition: page.precondition,
                  });
                  setReloadKey((k) => k + 1);
                  ctx?.refresh?.();
                } catch (err: any) {
                  alert(`상태 변경 실패: ${err.message || err}`);
                }
              }}
            />
          }
        />

        {parsedData.links.length > 0 && (
          <div className="page-related-links" aria-label="관련 문서">
            {parsedData.links.map((link) => {
              const resolved = resolveGraphId(graph, link) ?? link;
              const node = graph.nodes.find((n) => n.id === resolved);
              return (
                <button
                  key={link}
                  type="button"
                  className="page-related-chip"
                  onClick={() => navigate(`/page/${vault}/${resolved}`)}
                >
                  {node?.title ?? link}
                </button>
              );
            })}
          </div>
        )}


        {/* 에이전트 수정 지시 / 피드백 입력 패널 (v0.7.127+, P1#27) */}
        {page.type.toLowerCase() === "issue" && (
          <div
            style={{
              marginTop: "32px",
              padding: "20px",
              border: "1px solid var(--border-subtle)",
              borderRadius: "8px",
              backgroundColor: "var(--bg-surface)",
              boxShadow: "var(--shadow-raised)",
            }}
          >
            <h3
              style={{
                margin: "0 0 12px 0",
                fontSize: "14px",
                fontWeight: 600,
                color: "var(--fg-ink)",
                fontFamily: "var(--font-display)",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ color: "var(--fg-muted)" }}
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              에이전트 수정 지시 및 피드백 (댓글)
            </h3>
            <form onSubmit={handleSubmitFeedback} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <textarea
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="에이전트에게 내릴 수정 지시사항이나 해결 방안 피드백을 입력하세요..."
                disabled={isSubmittingFeedback}
                style={{
                  width: "100%",
                  minHeight: "80px",
                  padding: "12px",
                  borderRadius: "6px",
                  border: "1px solid var(--border-subtle)",
                  fontSize: "13px",
                  fontFamily: "inherit",
                  backgroundColor: "var(--bg-surface)",
                  color: "var(--fg-ink)",
                  resize: "vertical",
                }}
              />
              {feedbackErr && (
                <div style={{ color: "var(--color-error-text)", fontSize: "12px" }}>
                  오류: {feedbackErr}
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={isSubmittingFeedback || !feedbackText.trim()}
                >
                  {isSubmittingFeedback ? "전송 중..." : "수정 요청 전송"}
                </Button>
              </div>
            </form>

            {/* 피드백 댓글 리스트 */}
            {parsedData.feedbacks.length > 0 && (
              <div style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "12px", borderTop: "1px solid var(--color-hairline)", paddingTop: "16px" }}>
                <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-muted)", marginBottom: "4px" }}>
                  피드백 내역 ({parsedData.feedbacks.length})
                </div>
                {parsedData.feedbacks.map((item, idx) => {
                  const isEditing = editingFeedbackIdx === idx;
                  return (
                    <div
                      key={idx}
                      style={{
                        padding: "12px 16px",
                        borderRadius: "6px",
                        backgroundColor: "var(--color-surface-soft)",
                        border: "1px solid var(--border-subtle)",
                        display: "flex",
                        gap: "16px",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "11px", color: "var(--color-muted)", marginBottom: "6px" }}>
                          <div>🕒 {item.timestamp || "날짜 없음"}</div>
                          <div style={{ fontWeight: 600, marginTop: "2px", color: "var(--fg-ink)" }}>
                            👤 ({item.actor === "user" ? "사람 운영자" : item.actor})
                          </div>
                        </div>
                        {isEditing ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "8px" }}>
                            <textarea
                              value={editingFeedbackText}
                              onChange={(e) => setEditingFeedbackText(e.target.value)}
                              style={{
                                width: "100%",
                                minHeight: "60px",
                                padding: "8px",
                                borderRadius: "4px",
                                border: "1px solid var(--border-subtle)",
                                fontSize: "13px",
                                fontFamily: "inherit",
                                backgroundColor: "var(--bg-surface)",
                                color: "var(--fg-ink)",
                                resize: "vertical",
                              }}
                            />
                            <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setEditingFeedbackIdx(null)}
                              >
                                취소
                              </Button>
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => handleSaveFeedback(idx)}
                              >
                                저장
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ fontSize: "13px", color: "var(--fg-ink)", whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
                            {item.feedback}
                          </div>
                        )}
                      </div>

                      {!isEditing && (
                        <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingFeedbackIdx(idx);
                              setEditingFeedbackText(item.feedback);
                            }}
                            style={{
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              fontSize: "11px",
                              color: "var(--color-primary)",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              transition: "background-color 0.2s",
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--hover-overlay)"}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                          >
                            편집
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteFeedback(idx)}
                            style={{
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              fontSize: "11px",
                              color: "var(--color-danger)",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              transition: "background-color 0.2s",
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--hover-overlay)"}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                          >
                            삭제
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 의미 관계 (Relations) 섹션 */}
        {page.relations && page.relations.length > 0 && (
          <div
            style={{
              marginTop: "32px",
              padding: "20px",
              border: "1px solid var(--border-subtle)",
              borderRadius: "8px",
              backgroundColor: "var(--bg-surface)",
              boxShadow: "var(--shadow-raised)",
            }}
          >
            <h3
              style={{
                margin: "0 0 16px 0",
                fontSize: "14px",
                fontWeight: 600,
                color: "var(--fg-ink)",
                fontFamily: "var(--font-display)",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                borderBottom: "1px solid var(--color-hairline)",
                paddingBottom: "8px",
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ color: "var(--fg-muted)" }}
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              문서 의미 관계 (Relations)
            </h3>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {(() => {
                const categories = [
                  { key: "uses", label: "Uses (사용함)" },
                  { key: "depends_on", label: "Depends on (의존함)" },
                  { key: "implements", label: "Implements (구현함)" },
                  { key: "implemented_by", label: "Implemented by (구현체)" },
                  { key: "related", label: "Related (연관)" }
                ];
                
                return categories.map(({ key, label }) => {
                  const filtered = page.relations!.filter(r => r.type === key);
                  if (filtered.length === 0) return null;
                  
                  return (
                    <div key={key} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div
                        style={{
                          fontSize: "12px",
                          fontWeight: 600,
                          color: "var(--color-primary)",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        {label}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
                        {filtered.map((rel, idx) => {
                          const resolved = resolveGraphId(graph, rel.target) ?? rel.target;
                          const node = graph.nodes.find((n) => n.id === resolved);
                          const title = node?.title ?? rel.target;
                          const evidenceStr = rel.evidence
                            ? (Array.isArray(rel.evidence) ? rel.evidence.join(", ") : rel.evidence)
                            : "";
                          const relKey = `${key}-${idx}`;
                          const isHovered = hoveredRelKey === relKey;
                          
                          return (
                            <div
                              key={idx}
                              style={{ position: "relative", display: "inline-block" }}
                              onMouseEnter={() => setHoveredRelKey(relKey)}
                              onMouseLeave={() => setHoveredRelKey(null)}
                            >
                              <button
                                type="button"
                                className="page-related-chip"
                                onClick={() => navigate(`/page/${vault}/${resolved}`)}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  padding: "6px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid var(--border-subtle)",
                                  backgroundColor: "var(--color-surface-soft)",
                                  fontSize: "13px",
                                  color: "var(--fg-ink)",
                                  cursor: "pointer",
                                  transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.backgroundColor = "var(--hover-overlay)";
                                  e.currentTarget.style.transform = "translateY(-1px)";
                                  e.currentTarget.style.boxShadow = "var(--shadow-raised)";
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.backgroundColor = "var(--color-surface-soft)";
                                  e.currentTarget.style.transform = "none";
                                  e.currentTarget.style.boxShadow = "none";
                                }}
                              >
                                <span>{title}</span>
                              </button>
                              
                              {/* Hover tooltip for evidence & reason */}
                              {(evidenceStr || rel.reason) && (
                                <div
                                  style={{
                                    visibility: isHovered ? "visible" : "hidden",
                                    width: "280px",
                                    backgroundColor: "#1f2937",
                                    color: "#fff",
                                    textAlign: "left",
                                    borderRadius: "8px",
                                    padding: "12px",
                                    position: "absolute",
                                    zIndex: 100,
                                    bottom: "125%",
                                    left: "50%",
                                    marginLeft: "-140px",
                                    opacity: isHovered ? 1 : 0,
                                    transition: "opacity 0.2s, visibility 0.2s",
                                    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                                    fontSize: "12px",
                                    pointerEvents: "none",
                                    lineHeight: "1.4",
                                  }}
                                >
                                  {rel.reason && (
                                    <div style={{ marginBottom: evidenceStr ? "6px" : "0" }}>
                                      <strong style={{ color: "#93c5fd" }}>이유:</strong> {rel.reason}
                                    </div>
                                  )}
                                  {evidenceStr && (
                                    <div>
                                      <strong style={{ color: "#34d399" }}>근거:</strong> {evidenceStr}
                                    </div>
                                  )}
                                  <div
                                    style={{
                                      position: "absolute",
                                      top: "100%",
                                      left: "50%",
                                      marginLeft: "-6px",
                                      borderWidth: "6px",
                                      borderStyle: "solid",
                                      borderColor: "#1f2937 transparent transparent transparent",
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}

        {/* 함께 읽어볼 만한 문서 (Related Pages) 섹션 */}
        {recommendations.length > 0 && (
          <div
            style={{
              marginTop: "2.5rem",
              paddingTop: "2rem",
              borderTop: "1px solid var(--color-hairline)",
            }}
          >
            <h3
              style={{
                fontSize: "1.25rem",
                fontWeight: 600,
                color: "var(--color-ink)",
                marginBottom: "1rem",
              }}
            >
              함께 읽어볼 만한 문서
            </h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                gap: "1rem",
              }}
            >
              {recommendations.map((rec) => (
                <div
                  key={rec.slug}
                  onClick={() => navigate(`/page/${encodeURIComponent(vault)}/${encodeURIComponent(rec.slug)}`)}
                  style={{
                    padding: "1rem",
                    borderRadius: "8px",
                    border: "1px solid var(--color-hairline)",
                    backgroundColor: "var(--bg-soft)",
                    cursor: "pointer",
                    transition: "transform 0.2s, box-shadow 0.2s, border-color 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = "translateY(-2px)";
                    e.currentTarget.style.boxShadow = "var(--shadow-raised)";
                    e.currentTarget.style.borderColor = "var(--color-primary)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = "translateY(0)";
                    e.currentTarget.style.boxShadow = "none";
                    e.currentTarget.style.borderColor = "var(--color-hairline)";
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        padding: "0.25rem 0.5rem",
                        borderRadius: "4px",
                        backgroundColor: "var(--color-surface-soft)",
                        color: "var(--color-muted)",
                      }}
                    >
                      {rec.type}
                    </span>
                    <span
                      style={{
                        fontSize: "0.875rem",
                        fontWeight: 700,
                        color: "var(--color-primary)",
                      }}
                      title="연관성 점수"
                    >
                      ★ {rec.score.toFixed(1)}
                    </span>
                  </div>
                  <h4
                    style={{
                      fontSize: "1rem",
                      fontWeight: 600,
                      color: "var(--color-ink)",
                      marginBottom: "0.75rem",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {rec.title}
                  </h4>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {rec.co_citation_score > 0 && (
                      <span
                        style={{
                          fontSize: "0.75rem",
                          padding: "0.15rem 0.4rem",
                          borderRadius: "4px",
                          backgroundColor: "rgba(59, 130, 246, 0.1)",
                          color: "var(--color-primary)",
                          border: "1px solid rgba(59, 130, 246, 0.2)",
                        }}
                      >
                        공동 인용 {rec.co_citation_score}회
                      </span>
                    )}
                    {rec.tag_overlap_score > 0 && (
                      <span
                        style={{
                          fontSize: "0.75rem",
                          padding: "0.15rem 0.4rem",
                          borderRadius: "4px",
                          backgroundColor: "rgba(16, 185, 129, 0.1)",
                          color: "var(--color-success-text)",
                          border: "1px solid rgba(16, 185, 129, 0.2)",
                        }}
                      >
                        중복 태그 {rec.tag_overlap_score}개
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 백링크 섹션 */}
        <BacklinksPanel backlinks={page.backlinks ?? []} vault={vault} vertical={true} />
      </article>

      {/* Floating overlay panel — bottom-right. Hidden automatically on /graph. */}
      <FloatingGraphPanel
        vault={vault}
        nodes={localGraph.nodes}
        edges={localGraph.edges}
        currentNodeId={currentGraphNodeId}
        onOpenFullGraph={() => setShowFullGraph(true)}
      />

      {showFullGraph && localGraph.nodes.length > 0 && (
        <FullscreenGraphModal
          vault={vault}
          nodes={localGraph.nodes}
          edges={localGraph.edges}
          currentNodeId={currentGraphNodeId}
          centerTitle={`${page.title} 관련 그래프`}
          onClose={() => setShowFullGraph(false)}
        />
      )}
    </div>
  );
}

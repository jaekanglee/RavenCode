import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createPage, fetchPages } from "../lib/api";
import { TextField } from "./ui/TextField";
import { SelectField } from "./ui/SelectField";
import { Button } from "./ui/Button";
import { AITagSuggestion } from "./AITagSuggestion";

/**
 * NewPageInline — Plan v1 묶음 B (Tasks 5-7).
 *
 * 메인 영역 안 inline form. modal ❌.
 * - Tasks 5: 인라인 패널 (close 버튼 + Esc 키)
 * - Task 6: path select (GET /api/vaults/{vault}/pages → 디렉토리 추출) +
 *           "+ 새 디렉토리" 옵션 → sub-input (kebab-case validate)
 * - Task 7: title text input (필수) + type select (8종) + tags (선택)
 *
 * 본문(markdown)은 인라인 폼에서는 빼고 단순화 — slug 정규화가 핵심이고
 * 본문은 페이지 진입 후 페이지 뷰의 인라인 편집으로 작성하는 흐름.
 */

const TYPES = [
  "concept",
  "person",
  "comparison",
  "project",
  "tool",
  "rule",
  "query",
  "journal",
  "issue",
] as const;

const TYPE_OPTIONS = TYPES.map((t) => ({ value: t, label: t }));

const NEW_DIR = "__new__";

function isKebabCase(s: string): boolean {
  // 소문자 + 숫자 + 단일 hyphen, 시작/끝 hyphen ❌, 연속 hyphen ❌.
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
}

export interface NewPageInlineProps {
  vault: string;
  onClose: () => void;
  /** Optional callback after successful create (for tree refresh). */
  onCreated?: () => void;
}

export function NewPageInline({ vault, onClose, onCreated }: NewPageInlineProps) {
  const nav = useNavigate();

  // ─── path state ──────────────────────────────────────
  const [paths, setPaths] = useState<string[]>([]);
  const [pathLoading, setPathLoading] = useState(true);
  const [path, setPath] = useState<string>(""); // "" = 미선택, "__new__" = 새 dir
  const [newDir, setNewDir] = useState<string>("");
  const [newDirErr, setNewDirErr] = useState<string | null>(null);

  // ─── form state ──────────────────────────────────────
  const [title, setTitle] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("concept");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ─── fetch directories from existing pages ───────────
  useEffect(() => {
    let cancelled = false;
    setPathLoading(true);
    (async () => {
      try {
        const pages = await fetchPages(vault);
        if (cancelled) return;
        const set = new Set<string>();
        for (const p of pages) {
          const parts = (p.slug || "").split("/").filter(Boolean);
          // 누적 prefix만 등록 (예: "content", "content/concept")
          for (let i = 1; i < parts.length; i++) {
            set.add(parts.slice(0, i).join("/"));
          }
        }
        const list = Array.from(set).sort();
        setPaths(list);
        // 첫 항목 자동 선택 (단, "content"가 있으면 우선)
        if (!path) {
          const root = list.includes("content") ? "content" : list[0] || "";
          if (root) setPath(root);
        }
      } catch {
        // ignore — paths 비어 있어도 새 디렉토리 옵션은 동작
      } finally {
        if (!cancelled) setPathLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault]);

  // ─── Esc close ───────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // ─── resolved path ───────────────────────────────────
  const resolvedPath = useMemo(() => {
    if (path === NEW_DIR) {
      return newDir.trim();
    }
    return path;
  }, [path, newDir]);

  const resolvedSlug = useMemo(() => {
    // slug = {path}/{kebab(title)}
    const t = title.trim().toLowerCase();
    const kebab = t
      .replace(/[^a-z0-9\s-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!kebab) return "";
    return resolvedPath ? `${resolvedPath}/${kebab}` : kebab;
  }, [title, resolvedPath]);

  // ─── submit ──────────────────────────────────────────
  async function submit() {
    setErr(null);
    if (!title.trim()) {
      setErr("title은 필수입니다.");
      return;
    }
    if (path === NEW_DIR && !isKebabCase(newDir.trim())) {
      setNewDirErr("kebab-case만 가능 (소문자/숫자, 단일 hyphen).");
      return;
    }
    if (!resolvedSlug) {
      setErr("slug가 비어 있습니다. title에 영문/숫자를 포함해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const body =
        `# ${title.trim()}\n\n본문을 작성하세요.\n` +
        (tags
          ? `\n---\ntags: [${tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
              .join(", ")}]\n`
          : "");
      await createPage(vault, {
        slug: resolvedSlug,
        title: title.trim(),
        type,
        content: body,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      onCreated?.();
      nav(`/page/${encodeURIComponent(vault)}/${resolvedSlug}`);
      // reload for tree/refresh — matches NewPageButton 흐름
      window.location.reload();
    } catch (e: any) {
      setErr(`❌ ${e?.message ?? "create failed"}`);
      setBusy(false);
    }
  }

  return (
    <section
      role="region"
      aria-label={`새 페이지 (${vault})`}
      className="card"
      style={{
        padding: isMobileWidth() ? 16 : 24,
        marginBottom: 24,
        border: "1.5px solid var(--color-primary)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-canvas)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700 }}>
          ✚ 새 페이지{" "}
          <span
            style={{
              fontSize: 12,
              fontWeight: 400,
              color: "var(--color-muted)",
              marginLeft: 6,
            }}
          >
            in {vault}
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onClose}
          disabled={busy}
          aria-label="닫기"
          title="닫기 (Esc)"
          style={{ height: 32, padding: "4px 12px", fontSize: 13 }}
        >
          ✕
        </Button>
      </div>

      <p
        className="text-muted"
        style={{ fontSize: 12, marginBottom: 16, marginTop: 0 }}
      >
        title 필수 · path는 기존 디렉토리 선택 또는 새 디렉토리 생성.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginBottom: 12,
        }}
      >
        {/* ─── path select ─── */}
        <label style={{ display: "block" }}>
          <FieldLabel>path</FieldLabel>
          <select
            className="input-base"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setNewDir("");
              setNewDirErr(null);
            }}
            disabled={pathLoading || busy}
            style={fieldStyle}
          >
            {pathLoading && <option value="">불러오는 중…</option>}
            {!pathLoading && paths.length === 0 && (
              <option value="">디렉토리 없음</option>
            )}
            {!pathLoading &&
              paths.map((p) => (
                <option key={p} value={p}>
                  {p}/
                </option>
              ))}
            {!pathLoading && <option value={NEW_DIR}>+ 새 디렉토리…</option>}
          </select>
          {path === NEW_DIR && (
            <div style={{ marginTop: 6 }}>
              <input
                className="input-base"
                type="text"
                placeholder="new-dir (kebab-case)"
                value={newDir}
                onChange={(e) => {
                  setNewDir(e.target.value);
                  setNewDirErr(null);
                }}
                disabled={busy}
                style={fieldStyle}
              />
              {newDirErr && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--color-error-text)",
                    marginTop: 4,
                  }}
                >
                  {newDirErr}
                </div>
              )}
              <div
                style={{
                  fontSize: 11,
                  color: "var(--color-muted)",
                  marginTop: 4,
                }}
              >
                소문자/숫자 + 단일 hyphen. 예: <code>agent-notes</code>
              </div>
            </div>
          )}
        </label>

        {/* ─── type select ─── */}
        <SelectField
          label="type"
          value={type}
          onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
          disabled={busy}
          options={TYPE_OPTIONS}
          style={fieldStyle}
        />
      </div>

      {/* ─── title ─── */}
      <TextField
        label="title"
        required
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={busy}
        autoFocus
        placeholder="페이지 제목"
        style={fieldStyle}
      />

      {/* ─── tags ─── */}
      <TextField
        label="tags (선택, 쉼표 구분)"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        disabled={busy}
        placeholder="ai, llm"
        style={fieldStyle}
      />

      <AITagSuggestion
        vault={vault}
        content=""
        title={title}
        onAccept={(newTags) => {
          const existingList = tags.split(",").map((t) => t.trim()).filter(Boolean);
          const updatedList = Array.from(new Set([...existingList, ...newTags]));
          setTags(updatedList.join(", "));
        }}
        style={{ marginBottom: 12 }}
      />


      {/* ─── slug preview ─── */}
      <div
        style={{
          fontSize: 11,
          color: "var(--color-muted)",
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          marginBottom: 12,
          wordBreak: "break-all",
        }}
      >
        slug: <code>{resolvedSlug || <em>title 입력 필요</em>}</code>
      </div>

      {err && (
        <div
          role="alert"
          style={{
            marginBottom: 12,
            padding: 10,
            background: "var(--color-surface-soft)",
            fontSize: 13,
            borderRadius: "var(--radius-sm)",
            color: "var(--color-error-text)",
          }}
        >
          {err}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button
          variant="secondary"
          onClick={onClose}
          disabled={busy}
        >
          취소
        </Button>
        <Button
          onClick={submit}
          disabled={busy || !title.trim()}
        >
          {busy ? "저장 중…" : "만들기"}
        </Button>
      </div>
    </section>
  );
}

// ─── helpers ──────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "block",
        fontSize: 12,
        fontWeight: 600,
        marginBottom: 4,
        color: "var(--color-ink)",
      }}
    >
      {children}
    </span>
  );
}

const fieldStyle = {
  height: 40,
  fontSize: 14,
  width: "100%",
} as const;

function isMobileWidth(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 744px)").matches;
}
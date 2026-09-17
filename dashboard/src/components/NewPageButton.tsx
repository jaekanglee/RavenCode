import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { createPage, fetchTree, getActiveVault } from "../lib/api";
import type { TreeNode } from "../types";
import { TextField } from "./ui/TextField";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { SelectField } from "./ui/SelectField";
import { AITagSuggestion } from "./AITagSuggestion";

const TYPE_OPTIONS = [
  { value: "concept", label: "일반 노트" },
  { value: "person", label: "사람" },
  { value: "comparison", label: "비교" },
  { value: "project", label: "프로젝트" },
  { value: "tool", label: "도구" },
  { value: "rule", label: "규칙" },
  { value: "query", label: "질문/검색" },
  { value: "journal", label: "기록" },
  // v0.7.181: issue 추가. SCHEMA type인데 여기 빠져 있어서, 사이드바 issue
  // 그룹 "＋"로 만든 페이지의 분류를 issue로 맞출 수가 없었다. 템플릿이 붙는
  // 발행 폼은 여전히 NewIssueButton(⚠) 쪽.
  { value: "issue", label: "이슈" },
];

// v0.7.181: 제출 전 slug 유효성 (defense-in-depth layer 2).
//
// raven/core/slug.py의 거부 규칙을 클라이언트에서 미러링한다. 이유 둘:
//  1) 사이드바 canonical 그룹 "＋"가 `__canonical/issue`를 프리필하던 버그처럼
//     UI 내부 sentinel이 vault 파일시스템으로 새는 걸 한 겹 더 막는다.
//  2) 폴더까지만 적고 저장하면 백엔드가 400 + 영문 detail("slug contains
//     empty/'. ' segment")을 주는데, 사용자에겐 무슨 말인지 안 보인다.
//
// 통과면 null, 막을 이유가 있으면 사용자에게 보여줄 한국어 문장을 반환.
export function validatePageSlug(slug: string): string | null {
  const s = slug.trim();
  if (!s) return "경로를 입력해 주세요.";
  if (s.startsWith("/") || s.startsWith("~")) return "경로는 vault 기준 상대경로여야 합니다.";
  if (s.includes(":")) return "경로에 ':' 는 쓸 수 없습니다.";
  const segments = s.split("/");
  if (segments.some((seg) => seg === "" || seg === ".")) {
    return "경로 마지막에 파일명을 입력해 주세요.";
  }
  if (segments.includes("..")) return "경로에 '..' 는 쓸 수 없습니다.";
  if (segments.includes("__canonical")) {
    return "__canonical 은 사이드바 분류용 내부 이름입니다. 실제 폴더 경로를 입력해 주세요.";
  }
  return null;
}

interface NewPageButtonProps {
  vault?: string;
  variant?: "pill" | "icon";
  label?: string;
  initialSlug?: string;
  /** v0.7.181: 모달 열 때 프리필할 문서 분류. TYPE_OPTIONS에 없는 값은 무시. */
  initialType?: string;
  /** Called once when the trigger button is clicked, before the modal opens.
   *  Used by mobile sidebar to auto-close the drawer so the modal isn't
   *  covered by it. Optional — omit to keep old behavior (regression safe). */
  onOpen?: () => void;
}

export function NewPageButton({
  vault: vaultProp,
  variant = "pill",
  label = "새 페이지",
  initialSlug = "",
  initialType,
  onOpen,
}: NewPageButtonProps) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const vault = vaultProp || getActiveVault() || "default";

  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("concept");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState("# 새 페이지\n\n");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // v0.6.19+: 경로 피커 — modal 열릴 때 vault 트리 fetch, 폴더 클릭 시 slug prefix 주입
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [treeErr, setTreeErr] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchTree(vault)
      .then((t) => {
        if (!cancelled) setTree(t);
      })
      .catch(() => {
        if (!cancelled) setTreeErr(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, vault]);

  function pickFolder(folderPath: string) {
    // 기존 slug에 다른 prefix가 있으면 제거하고 새 prefix 적용
    // 사용자가 파일명을 이어서 입력할 수 있도록 trailing slash 유지
    setSlug((prev) => {
      const trimmed = prev.replace(/^content\//, "").replace(/\/[^/]*$/, "");
      if (folderPath === "content") return trimmed ? `content/${trimmed}` : "content/";
      return `${folderPath}/${trimmed}`.replace(/\/+$/, "/");
    });
  }

  async function submit() {
    setErr(null);
    if (!slug || !title) {
      setErr("파일 경로와 제목을 입력해 주세요.");
      return;
    }
    const slugErr = validatePageSlug(slug);
    if (slugErr) {
      setErr(slugErr);
      return;
    }
    setBusy(true);
    try {
      await createPage(vault, {
        slug,
        title,
        type,
        content,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setOpen(false);
      nav(`/page/${encodeURIComponent(vault)}/${slug}`);
      window.location.reload();
    } catch (e: any) {
      setErr(`❌ ${e.message}`);
      setBusy(false);
    }
  }

  return (
    <>
      {/* Trigger — sidebar explorer action. Default is full pill; icon variant is used in Vault row. */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (initialSlug && !slug) setSlug(initialSlug);
          if (initialType && TYPE_OPTIONS.some((o) => o.value === initialType)) {
            setType(initialType);
          }
          onOpen?.();
          setOpen(true);
        }}
        className={variant === "icon" ? "sidebar-icon-action" : "btn-pill-primary"}
        style={variant === "pill" ? { width: "100%" } : undefined}
        aria-label={`${vault}에 ${label} 만들기`}
        title={`${vault}에 ${label} 만들기`}
      >
        {variant === "icon" ? "＋" : `➕ ${label}`}
      </button>

      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        maxWidth={880}
        disableBackdropClose={busy}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <h2 style={{ marginBottom: 8 }}>
            새 페이지 만들기{" "}
            <span style={{ fontSize: 14, fontWeight: 400, color: "var(--color-muted)" }}>
              in {vault}
            </span>
          </h2>
          <p className="text-muted" style={{ fontSize: 13, marginBottom: 24 }}>
            제목과 저장 위치만 정하면 바로 만들 수 있습니다.
          </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(180px, 240px) 1fr",
                gap: 24,
                overflowY: "auto",
                flex: 1,
                minHeight: 0,
              }}
            >
              {/* 좌측: 경로 피커 (vault 트리) */}
              <div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    marginBottom: 8,
                    color: "var(--color-ink)",
                  }}
                >
                  저장 위치
                </div>
                {treeErr ? (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--color-muted)",
                      padding: "12px 8px",
                      border: "1px solid var(--color-hairline)",
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    트리를 불러올 수 없습니다. 우측에서 직접 입력해 주세요.
                  </div>
                ) : tree ? (
                  <PathPicker tree={tree} currentPrefix={slug} onPick={pickFolder} />
                ) : (
                  <div style={{ fontSize: 12, color: "var(--color-muted)" }}>트리 불러오는 중…</div>
                )}
              </div>

              {/* 우측: 폼 */}
              <div>
                <TextField
                  label="경로"
                  required
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="content/my-concept"
                  helper="좌측에서 폴더를 클릭하거나 직접 입력하세요. 마지막 segment가 파일명입니다."
                />

                <TextField
                  label="제목"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="내 컨셉"
                />

            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowAdvanced((v) => !v)}
              style={{ height: 34, padding: "6px 12px", fontSize: 13, marginBottom: 16 }}
            >
              {showAdvanced ? "세부 옵션 숨기기" : "세부 옵션"}
            </button>

            {showAdvanced && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 16,
                  marginBottom: 16,
                }}
              >
                <SelectField
                  label="문서 분류"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  options={TYPE_OPTIONS}
                />
                <label style={{ display: "block" }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: 13,
                      fontWeight: 500,
                      marginBottom: 6,
                      color: "var(--color-ink)",
                    }}
                  >
                    태그 (쉼표 구분)
                  </span>
                  <input
                    className="input-base"
                    style={{ height: 48 }}
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="ai, llm"
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
                    style={{ marginTop: 8 }}
                  />
                </label>
              </div>
            )}

            <label style={{ display: "block", marginBottom: 16 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 500,
                  marginBottom: 6,
                  color: "var(--color-ink)",
                }}
              >
                본문
              </span>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={10}
                style={{
                  width: "100%",
                  border: "1px solid var(--color-hairline-strong)",
                  borderRadius: "var(--radius-sm)",
                  padding: 12,
                  fontSize: 13,
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  outline: "none",
                  resize: "vertical",
                  background: "var(--color-canvas)",
                  color: "var(--color-ink)",
                }}
              />
            </label>

            {err && (
              <div
                style={{
                  marginBottom: 16,
                  padding: 12,
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
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                취소
              </Button>
              <Button variant="primary" onClick={submit} disabled={busy}>
                {busy ? "저장 중…" : "저장"}
              </Button>
            </div>
              </div>{/* 우측 폼 닫기 */}
            </div>{/* grid 닫기 */}
          </div>{/* outer flex column wrapper 닫기 */}
        </Modal>
    </>
  );
}

// ─── PathPicker — vault 트리에서 폴더 클릭 → slug prefix 주입 ────────
// v0.6.19+: 페이지 생성 모달 좌측에 표시. 빈 폴더도 포함 (ADR 05311e0).
function PathPicker({
  tree,
  currentPrefix,
  onPick,
}: {
  tree: TreeNode;
  currentPrefix: string;
  onPick: (folderPath: string) => void;
}) {
  // 현재 slug의 prefix가 어떤 폴더에 해당하는지 하이라이트용
  const activePrefix = currentPrefix.replace(/\/[^/]*$/, "").replace(/\/+$/, "");
  return (
    <div
      style={{
        border: "1px solid var(--color-hairline)",
        borderRadius: "var(--radius-sm)",
        padding: 8,
        maxHeight: 360,
        overflowY: "auto",
        background: "var(--color-canvas)",
        fontSize: 13,
      }}
    >
      <PickerNode node={tree} depth={0} activePrefix={activePrefix} onPick={onPick} />
    </div>
  );
}

function PickerNode({
  node,
  depth,
  activePrefix,
  onPick,
}: {
  node: TreeNode;
  depth: number;
  activePrefix: string;
  onPick: (folderPath: string) => void;
}) {
  if (node.type === "page") return null;
  const isActive = activePrefix === node.path;
  const label = node.path.split("/").pop() || node.path;
  return (
    <div>
      <button
        type="button"
        onClick={() => onPick(node.path)}
        data-path={node.path}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          background: isActive ? "var(--color-surface-soft)" : "transparent",
          border: "none",
          padding: `6px 8px 6px ${8 + depth * 12}px`,
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
          fontSize: 13,
          color: "var(--color-ink)",
          fontFamily: "var(--font-display)",
        }}
      >
        📁 {label}
      </button>
      {(node.children ?? [])
        .filter((c) => c.type === "dir")
        .map((c) => (
          <PickerNode
            key={c.path}
            node={c}
            depth={depth + 1}
            activePrefix={activePrefix}
            onPick={onPick}
          />
        ))}
    </div>
  );
}
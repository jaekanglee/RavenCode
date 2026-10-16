import { useEffect, useState, type JSX } from "react";
import { useNavigate } from "react-router-dom";
import { createPage, fetchTree, getActiveVault } from "../lib/api";
import { canGuest, useGuestMe } from "../lib/guest";
import type { TreeNode } from "../types";
import { TextField } from "./ui/TextField";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { SelectField } from "./ui/SelectField";

type IssueSeverity = "high" | "medium" | "low";
type IssueKind = "bug" | "broken-link" | "orphan" | "stale" | "lint" | "spec-gap" | "other";

const SEVERITY_OPTIONS: { value: IssueSeverity; label: string; helper: string }[] = [
  { value: "high", label: "높음", helper: "데이터 손실 / 차단 / 명백한 버그" },
  { value: "medium", label: "중간", helper: "사용성 저하 / 후속 작업 필요" },
  { value: "low", label: "낮음", helper: "개선 아이디어 / 다이어트 / 폴리시" },
];

const KIND_OPTIONS: { value: IssueKind; label: string }[] = [
  { value: "bug", label: "🐞 버그" },
  { value: "broken-link", label: "🔗 깨진 링크" },
  { value: "orphan", label: "🪙 고아 페이지" },
  { value: "stale", label: "🕰 90일+ 미갱신" },
  { value: "lint", label: "🧹 lint 위반" },
  { value: "spec-gap", label: "📐 정책 / 스키마 미흡" },
  { value: "other", label: "기타" },
];

interface NewIssueButtonProps {
  vault?: string;
  /** Suggested slug prefix — Sidebar에서 호출 시 현재 vault의 issues/ 폴더 기본값. */
  initialSlug?: string;
  /** Called once on trigger click, before modal opens. Mobile sidebar uses this to auto-close. */
  onOpen?: () => void;
  /** ADR-2026-07-08: 기본 사람 트리거. agent 호출 시 명시 (lint #18 audit log 기록). */
  actor?: "human" | "agent";
}

const ISO_TODAY = () => new Date().toISOString().slice(0, 10);

function buildIssueContent(args: {
  title: string;
  severity: IssueSeverity;
  kind: IssueKind;
  summary: string;
  problem: string;
  rootCause: string;
  resolution: string;
  related: string;
}): string {
  const lines: string[] = [];
  lines.push(`# ${args.title}`);
  lines.push("");
  if (args.summary) {
    lines.push(`> ${args.summary}`);
    lines.push("");
  }
  lines.push(`## 상태`);
  lines.push(`- 심각도: ${args.severity}`);
  lines.push(`- 종류: ${args.kind}`);
  lines.push("- 진행: 열림 (Open)");
  lines.push("");
  lines.push("## 문제 상황");
  lines.push(args.problem.trim() || "_재현 경로/관찰 사실을 적어 주세요._");
  lines.push("");
  lines.push("## 원인 분석");
  lines.push(args.rootCause.trim() || "_근본 원인 가설을 적어 주세요._");
  lines.push("");
  if (args.resolution.trim()) {
    lines.push("## 해결 방안");
    lines.push(args.resolution.trim());
    lines.push("");
  }
  lines.push("## 관련");
  if (args.related.trim()) {
    for (const slug of args.related.split(",").map((s) => s.trim()).filter(Boolean)) {
      lines.push(`- [[${slug}]] — 관련 페이지`);
    }
  } else {
    lines.push("- _관련 페이지를 wikilink로 추가해 주세요._");
  }
  return lines.join("\n") + "\n";
}

function buildIssueSlug(args: { folder: string; title: string }): string {
  const base = args.title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w가-힣\-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = base || "untitled-issue";
  const prefix = args.folder.replace(/\/+$/, "");
  const today = ISO_TODAY();
  return `${prefix}/${today}-${safe}`;
}

// 손님 입장 (spec 2026-10-16-guest-access-design): 작성 권한 없는 손님에겐 버튼을 숨긴다.
export function NewIssueButton(props: NewIssueButtonProps) {
  const me = useGuestMe();
  if (!canGuest(me, props.vault || getActiveVault() || "default", "create")) return null;
  return <NewIssueButtonInner {...props} />;
}

function NewIssueButtonInner({
  vault: vaultProp,
  initialSlug = "content/issues",
  onOpen,
  actor = "human",
}: NewIssueButtonProps) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const vault = vaultProp || getActiveVault() || "default";

  const [folder, setFolder] = useState(initialSlug);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<IssueSeverity>("medium");
  const [kind, setKind] = useState<IssueKind>("bug");
  const [summary, setSummary] = useState("");
  const [problem, setProblem] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [resolution, setResolution] = useState("");
  const [related, setRelated] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [tree, setTree] = useState<TreeNode | null>(null);
  const [treeErr, setTreeErr] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchTree(vault)
      .then((t) => { if (!cancelled) setTree(t); })
      .catch(() => { if (!cancelled) setTreeErr(true); });
    return () => { cancelled = true; };
  }, [open, vault]);

  function pickFolder(folderPath: string) {
    setFolder(folderPath);
  }

  async function submit() {
    setErr(null);
    if (!title.trim()) {
      setErr("제목을 입력해 주세요.");
      return;
    }
    if (!folder.trim()) {
      setErr("저장 위치를 선택해 주세요.");
      return;
    }
    setBusy(true);
    const slug = buildIssueSlug({ folder, title });
    const content = buildIssueContent({
      title: title.trim(),
      severity,
      kind,
      summary: summary.trim(),
      problem,
      rootCause,
      resolution,
      related,
    });
    try {
      // ADR-2026-07-08: agent도 자율 발행. status=draft default.
      // actor는 frontmatter agents: 라인에 stamp (lint #18 audit).
      const stamp = `\n\n<!-- actor=${actor} published_at=${new Date().toISOString()} -->\n`;
      await createPage(vault, {
        slug,
        title: title.trim(),
        type: "issue",
        content: content + stamp,
        tags: ["issue", severity, kind, "draft"],
        extra_meta: { issue_status: "open" },
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
      <button
        onClick={(e) => {
          e.stopPropagation();
          onOpen?.();
          setOpen(true);
        }}
        className="sidebar-icon-action"
        aria-label={`${vault} 보관소에 새 이슈 발행`}
        title={`새 이슈 발행 (${actor === "human" ? "사람 운영자" : "agent 자율"} — ADR-2026-07-08)`}
      >
        ⚠
      </button>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        maxWidth={880}
        disableBackdropClose={busy}
      >
        <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <h2 style={{ marginBottom: 4 }}>
            새 이슈 발행{" "}
            <span style={{ fontSize: 14, fontWeight: 400, color: "var(--color-muted)" }}>
              in {vault}
            </span>
          </h2>
          <p className="text-muted" style={{ fontSize: 12, marginBottom: 16 }}>
            사람 운영자 전용 발행 폼. 백링크/상태/심각도를 정해 발행하면 lint #4/#7/#8 백로그로 잡힙니다.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 240px) 1fr", gap: 20, overflowY: "auto", flex: 1, minHeight: 0 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: "var(--color-ink)" }}>
                저장 위치
              </div>
              {treeErr ? (
                <div style={{ fontSize: 12, color: "var(--color-muted)", padding: "12px 8px", border: "1px solid var(--color-hairline)", borderRadius: "var(--radius-sm)" }}>
                  트리를 불러올 수 없습니다. 우측에서 직접 입력해 주세요.
                </div>
              ) : tree ? (
                <IssueFolderPicker tree={tree} currentFolder={folder} onPick={pickFolder} />
              ) : (
                <div style={{ fontSize: 12, color: "var(--color-muted)" }}>트리 불러오는 중…</div>
              )}
              <TextField
                label="폴더 경로"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                helper="기본 content/issues. 다른 위치 가능."
                style={{ marginTop: 12 }}
              />
            </div>

            <div>
              <TextField
                label="제목"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: sidebar raw 경로에서 viewer가 좁게 잡힘"
                helper="slug는 제목 + 오늘 날짜로 자동 생성됩니다."
              />

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
                <SelectField
                  label="심각도"
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as IssueSeverity)}
                  options={SEVERITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                  helper={SEVERITY_OPTIONS.find((o) => o.value === severity)?.helper}
                />
                <SelectField
                  label="종류"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as IssueKind)}
                  options={KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>

              <TextField
                label="BLUF (1줄 요약)"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="이 이슈의 핵심 원인/상태 1줄"
                style={{ marginTop: 12 }}
              />

              <TextField
                label="문제 상황"
                multiline
                rows={4}
                value={problem}
                onChange={(e) => setProblem(e.target.value)}
                placeholder="재현 경로/관찰 사실"
                style={{ marginTop: 12 }}
              />

              <TextField
                label="원인 분석"
                multiline
                rows={4}
                value={rootCause}
                onChange={(e) => setRootCause(e.target.value)}
                placeholder="근본 원인 가설"
                style={{ marginTop: 12 }}
              />

              <TextField
                label="해결 방안 (Optional)"
                multiline
                rows={3}
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                placeholder="적용했거나 고려 중인 패치"
                style={{ marginTop: 12 }}
              />

              <TextField
                label="관련 wikilink (쉼표 구분)"
                value={related}
                onChange={(e) => setRelated(e.target.value)}
                placeholder="raw-panel-viewer, sidebar-canonical-tree"
                helper="slug 또는 페이지 제목. 빈 값이면 placeholder."
                style={{ marginTop: 12 }}
              />
            </div>
          </div>

          {err && (
            <div style={{ marginTop: 12, padding: "8px 12px", background: "var(--color-danger-bg)", color: "var(--color-danger)", borderRadius: 6, fontSize: 12 }}>
              {err}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              취소
            </Button>
            <Button variant="primary" onClick={submit} disabled={busy || !title.trim()}>
              {busy ? "발행 중…" : "이슈 발행"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function IssueFolderPicker({
  tree,
  currentFolder,
  onPick,
}: {
  tree: TreeNode;
  currentFolder: string;
  onPick: (folderPath: string) => void;
}) {
  const active = currentFolder.replace(/\/$/, "");
  function walk(node: TreeNode, depth: number, key: string): JSX.Element | null {
    if (node.type !== "dir") return null;
    const isActive = active === node.path || active.startsWith(`${node.path}/`);
    const label = node.path.split("/").pop() || node.path;
    const childDirs = (node.children ?? []).filter((c) => c.type === "dir");
    return (
      <div key={key}>
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
        {childDirs.map((c) => walk(c, depth + 1, c.path))}
      </div>
    );
  }
  return (
    <div style={{ border: "1px solid var(--color-hairline)", borderRadius: "var(--radius-sm)", padding: 8, maxHeight: 320, overflowY: "auto", background: "var(--color-canvas)", fontSize: 13 }}>
      {walk(tree, 0, tree.path)}
    </div>
  );
}

// 초안 검토 대기열 — 사이드바·검토 화면이 함께 쓰는 순수 함수
// (spec 2026-10-20-draft-review-queue-design).
import type { ApproveResult } from "./api";
import type { TreeNode } from "../types";

export function isDraftStatus(status: string | null | undefined): boolean {
  return (status ?? "").trim() === "draft";
}

/** 노드 아래(자신 포함)의 draft 문서 수. 트리가 없으면 0. */
export function countDrafts(node: TreeNode | null | undefined): number {
  if (!node) return 0;
  if (node.type === "page") return isDraftStatus(node.status) ? 1 : 0;
  return (node.children ?? []).reduce((n, child) => n + countDrafts(child), 0);
}

const SKIP_LABEL: Record<Exclude<ApproveResult, "approved">, string> = {
  not_draft: "이미 승인됨",
  stale_precondition: "내용 변경됨",
  not_found: "문서 없음",
  error: "쓰기 실패",
};

/** 일괄 승인 결과 한 줄. 예: "✅ 1건 승인 · 2건 건너뜀(이미 승인됨 2)" */
export function summarizeApproval(results: { result: ApproveResult }[]): string {
  const approved = results.filter((r) => r.result === "approved").length;
  const head = `✅ ${approved}건 승인`;
  const skipped = new Map<string, number>();
  for (const r of results) {
    if (r.result === "approved") continue;
    const label = SKIP_LABEL[r.result];
    skipped.set(label, (skipped.get(label) ?? 0) + 1);
  }
  if (skipped.size === 0) return head;
  const detail = [...skipped].map(([label, n]) => `${label} ${n}`).join(", ");
  return `${head} · ${results.length - approved}건 건너뜀(${detail})`;
}

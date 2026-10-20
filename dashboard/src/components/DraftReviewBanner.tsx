// 문서 상단 초안 배너 (spec 2026-10-20-draft-review-queue-design).
//
// status: draft 문서에서만 붙는다. 승인은 운영자만 — 읽을 때 받은 precondition을 실어 보내
// 그 뒤 에이전트가 내용을 바꿨으면 승인하지 않고 다시 확인하라고 알린다.
import { useState } from "react";

import { Button } from "./ui/Button";
import { approveDrafts, formatApiError, type ApproveResult } from "../lib/api";

const FAILURE_MESSAGE: Record<Exclude<ApproveResult, "approved">, string> = {
  stale_precondition: "읽은 뒤 내용이 바뀌었습니다. 새로고침해서 다시 확인한 뒤 승인하세요.",
  not_draft: "이미 승인된 문서입니다. 새로고침하세요.",
  not_found: "문서를 찾을 수 없습니다.",
  error: "승인하지 못했습니다. 잠시 뒤 다시 시도하세요.",
};

interface DraftReviewBannerProps {
  vault: string;
  slug: string;
  precondition?: string;
  canApprove: boolean;
  onApproved: () => void;
}

export function DraftReviewBanner({ vault, slug, precondition, canApprove, onApproved }: DraftReviewBannerProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const approve = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const [r] = await approveDrafts(vault, [{ slug, precondition }]);
      const result = r?.result ?? "error";
      if (result === "approved") {
        onApproved();
        return;
      }
      setMessage(FAILURE_MESSAGE[result]);
    } catch (e) {
      setMessage(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="draft-review-banner">
      <span className="draft-review-banner-text">에이전트가 쓴 초안입니다 · 검토 대기</span>
      {message && (
        <span className="draft-review-banner-message" role="alert">
          {message}
        </span>
      )}
      {canApprove && (
        <Button size="sm" onClick={approve} disabled={busy}>
          승인
        </Button>
      )}
    </div>
  );
}

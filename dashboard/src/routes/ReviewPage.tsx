// 초안 검토 대기 화면 (spec 2026-10-20-draft-review-queue-design).
//
// status: draft 문서를 모아 보고 골라서 승인한다(→ current, draft 태그 제거).
// 일괄 승인은 precondition 없이 보낸다 — 본문을 보지 않고 승인하겠다는 운영자의 선택이다.
// 승인은 운영자 전용이라 손님 탭에서는 안내만 보이고 API를 부르지 않는다.
import { useEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";

import { typeLabel } from "../components/GraphCanvas";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { PageHeader } from "../components/ui/PageHeader";
import { Toast } from "../components/ui/Toast";
import { approveDrafts, fetchReviewQueue, formatApiError, type ReviewDraft } from "../lib/api";
import { isGuestTab } from "../lib/guest";
import { summarizeApproval } from "../lib/review";

export function ReviewPage() {
  const { vault = "" } = useParams();
  const ctx = useOutletContext<{ refresh?: () => void } | undefined>();
  const guest = isGuestTab();
  const [drafts, setDrafts] = useState<ReviewDraft[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const load = async () => {
    setError(null);
    try {
      setDrafts(await fetchReviewQueue(vault));
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  useEffect(() => {
    setDrafts(null);
    setSelected(new Set());
    if (!guest) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, guest]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (guest) {
    return (
      <EmptyState
        title="검토와 승인은 운영자만 할 수 있습니다"
        description="초안 문서는 사이드바에서 열어 볼 수 있습니다."
      />
    );
  }

  const allSelected = !!drafts && drafts.length > 0 && selected.size === drafts.length;

  const toggle = (slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected || !drafts ? new Set() : new Set(drafts.map((d) => d.slug)));
  };

  const approveSelected = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const results = await approveDrafts(vault, [...selected].map((slug) => ({ slug })));
      const anyApproved = results.some((r) => r.result === "approved");
      setToast({ message: summarizeApproval(results), type: anyApproved ? "success" : "error" });
      setSelected(new Set());
      ctx?.refresh?.();
      await load();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={drafts ? `검토 대기 ${drafts.length}` : "검토 대기"}
        contextLabel={`in ${vault}`}
        subtitle="에이전트가 status: draft로 쓴 문서입니다. 승인하면 current가 되고 draft 태그가 빠집니다."
        actions={
          <Button onClick={approveSelected} disabled={busy || selected.size === 0}>
            {`선택 승인 (${selected.size})`}
          </Button>
        }
      />
      {error && (
        <p role="alert" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      )}
      {drafts === null && !error && <p className="text-muted">불러오는 중…</p>}
      {drafts && drafts.length === 0 && (
        <EmptyState
          title="검토할 초안이 없습니다"
          description="에이전트가 status: draft로 쓴 문서가 여기에 모입니다."
        />
      )}
      {drafts && drafts.length > 0 && (
        <div className="review-list">
          <div className="review-row review-row-head">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="전체 선택" />
            <span>전체 선택</span>
          </div>
          {drafts.map((d) => (
            <div key={d.slug} className="review-row">
              <input
                type="checkbox"
                checked={selected.has(d.slug)}
                onChange={() => toggle(d.slug)}
                aria-label={`${d.title} 선택`}
              />
              <Link className="review-row-title" to={`/page/${vault}/${d.slug.replace(/^content\//, "")}`}>
                {d.title}
              </Link>
              <span className="sidebar-tree-page-pill" data-type={d.type}>
                {typeLabel(d.type) || d.type}
              </span>
              <span className="review-row-meta">{d.last_agent ?? "—"}</span>
              <span className="review-row-meta">{d.updated || "—"}</span>
            </div>
          ))}
        </div>
      )}
      <Toast open={!!toast} message={toast?.message ?? ""} type={toast?.type} />
    </div>
  );
}

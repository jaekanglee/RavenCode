// vault 운영 지침 편집 화면 (ADR 2026-09-25 3단계).
//
// 지침 내용은 사용자 소유다. 이 화면은 `_meta/policy/VAULT-POLICY.md`를 읽고
// 사람이 쓴 그대로 저장할 뿐, 스스로 파일을 만들지 않는다 — 템플릿은 사람이
// "템플릿에서 시작"을 눌렀을 때만 편집기에 채워지고, 저장해야 파일이 생긴다.
// 에이전트는 이 파일을 MCP `wiki_get_policy`로 읽는다(쓰기 불가).
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { MarkdownView } from "../components/MarkdownView";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { PageHeader } from "../components/ui/PageHeader";
import { TextField } from "../components/ui/TextField";
import { Toast } from "../components/ui/Toast";
import {
  PolicyConflictError,
  formatApiError,
  getVaultPolicy,
  putVaultPolicy,
  type VaultPolicy,
} from "../lib/api";

export function VaultPolicyPage() {
  const { vault = "" } = useParams();
  const [policy, setPolicy] = useState<VaultPolicy | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      setPolicy(await getVaultPolicy(vault));
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const save = async () => {
    if (draft === null || !policy) return;
    setSaving(true);
    setError(null);
    try {
      const r = await putVaultPolicy(vault, { content: draft, precondition: policy.precondition });
      setPolicy({ ...policy, content: draft, precondition: r.precondition, template: undefined });
      setDraft(null);
      setToast("✅ 저장 완료");
    } catch (e) {
      // 초안은 그대로 둔다 — 새로 불러온 뒤 사람이 직접 합친다.
      setError(
        e instanceof PolicyConflictError
          ? "다른 곳에서 먼저 저장됐습니다. 내 초안을 복사해 두고 새로 불러오세요."
          : formatApiError(e),
      );
    } finally {
      setSaving(false);
    }
  };

  const discardAndReload = async () => {
    setDraft(null);
    await load();
  };

  const meta = policy && (
    <span style={{ fontSize: 12, color: "var(--color-muted)", fontFamily: "var(--font-mono)" }}>
      {policy.path}
      {policy.modified ? ` · 수정 ${policy.modified.replace("T", " ")}` : ""}
    </span>
  );

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: "24px 16px" }}>
      <PageHeader
        title="운영 지침"
        contextLabel={`in ${vault}`}
        subtitle="이 vault를 맡은 에이전트가 따를 지침입니다. 에이전트는 MCP로 이 문서를 읽기만 합니다."
        meta={meta}
        actions={
          policy?.content != null && draft === null ? (
            <Button variant="secondary" size="sm" onClick={() => setDraft(policy.content ?? "")}>
              편집
            </Button>
          ) : null
        }
      />

      {error && (
        <div role="alert" style={{ marginBottom: 16, color: "var(--color-error-text)", fontSize: 13 }}>
          {error}{" "}
          <Button variant="ghost" size="sm" onClick={() => void discardAndReload()}>
            새로 불러오기
          </Button>
        </div>
      )}

      {draft !== null ? (
        <div>
          <TextField
            label="지침 본문 (Markdown)"
            hideLabel
            multiline
            rows={24}
            // .input-base가 height: 56px로 고정해 rows가 무시된다 — 이 화면에서만 푼다.
            style={{ height: "auto" }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="secondary" size="sm" disabled={saving} onClick={() => setDraft(null)}>
              취소
            </Button>
            <Button variant="primary" size="sm" disabled={saving} onClick={() => void save()}>
              저장
            </Button>
          </div>
        </div>
      ) : policy?.content != null ? (
        <MarkdownView content={policy.content} vault={vault} />
      ) : policy ? (
        <EmptyState
          title="아직 운영 지침이 없습니다"
          description="에이전트는 MCP로 이 지침을 읽습니다. 지침이 없으면 사용자의 명시적 지시만 수행합니다."
          action={
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <Button variant="primary" size="sm" onClick={() => setDraft(policy.template ?? "")}>
                템플릿에서 시작
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setDraft("")}>
                빈 문서로 시작
              </Button>
            </div>
          }
        />
      ) : null}

      <Toast open={toast !== null} message={toast ?? ""} />
    </div>
  );
}

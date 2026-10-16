// GuestEntryForm — 내부망 손님의 입장 요청 (spec 2026-10-16-guest-access-design).
//
// 토큰 없이 Core API에 닿은 손님에게 AuthTokenDialog가 기본으로 보여 준다.
// 이름을 적어 요청하면 확인 코드를 띄우고 2초마다 상태를 조회한다. 운영자가 데스크톱 앱에서
// 승인하면 첫 조회에 한 번 내려오는 손님 토큰을 저장하고 onEntered (기본: 새로고침 → 원래 URL).
//
// Contract:
//  - 상태 조회는 claim secret(이 탭 메모리에만)·기기 ID 헤더로만 — URL에 넣지 않는다.
//  - 404는 "요청이 사라짐"(Core 재시작·만료 정리)으로 보고 다시 요청하게 한다.
import { useEffect, useRef, useState } from "react";
import { TextField } from "./ui/TextField";
import { Button } from "./ui/Button";
import { deviceId, setGuestToken } from "../lib/host-auth";

export const GUEST_REFUSAL_TEXT: Record<string, string> = {
  revoked: "입장 승인이 해제됐어요. 다시 요청해 주세요.",
  expired: "입장 기간이 끝났어요. 다시 요청해 주세요.",
  device_mismatch: "다른 기기에서 승인된 입장이에요. 이 기기로 다시 요청해 주세요.",
  ip_changed: "IP가 바뀌었어요. 다시 요청해 주세요.",
};

export const POLL_MS = 2000;

type Phase =
  | { kind: "idle" }
  | { kind: "waiting"; requestId: string; claim: string; code: string }
  | { kind: "ended"; message: string };

export interface GuestEntryFormProps {
  base: string;
  /** 직전 손님 토큰이 거부된 이유 (revoked/expired/device_mismatch/ip_changed). */
  refusal?: string | null;
  onEntered?: () => void;
  onUseToken: () => void;
}

export function GuestEntryForm({ base, refusal, onEntered = () => window.location.reload(), onUseToken }: GuestEntryFormProps) {
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const entered = useRef(onEntered);
  entered.current = onEntered;

  async function submit(e?: { preventDefault(): void }) {
    e?.preventDefault();
    const value = name.trim();
    if (!value) {
      setError("이름을 입력해 주세요.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const r = await fetch(`${base}/api/guest/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: value, device_id: deviceId() }),
      });
      if (r.status === 429) {
        setError("요청이 너무 많아요. 잠시 후 다시 시도해 주세요.");
        return;
      }
      if (!r.ok) {
        setError(r.status === 422 ? "이름은 1~40자로 입력해 주세요." : `요청 실패 (HTTP ${r.status})`);
        return;
      }
      const d = await r.json();
      setPhase({ kind: "waiting", requestId: d.request_id, claim: d.claim_secret, code: d.code });
    } catch {
      setError("호스트에 연결하지 못했습니다.");
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (phase.kind !== "waiting") return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await fetch(`${base}/api/guest/requests/${encodeURIComponent(phase.requestId)}`, {
          headers: { "X-Raven-Claim": phase.claim, "X-Raven-Device": deviceId() },
        });
        if (stopped) return;
        if (r.status === 404) {
          setPhase({ kind: "ended", message: "요청이 사라졌어요. 다시 요청해 주세요." });
          return;
        }
        if (!r.ok) return; // 일시 오류 — 다음 주기에 다시
        const d = await r.json();
        if (d.status === "approved" && typeof d.token === "string") {
          if (!setGuestToken(base, d.token)) {
            setPhase({ kind: "ended", message: "승인됐지만 이 브라우저가 저장을 거부했어요 (사생활 보호 모드·저장소 차단 확인)." });
            return;
          }
          entered.current();
        } else if (d.status === "denied") {
          setPhase({ kind: "ended", message: "입장 요청이 거절됐어요." });
        } else if (d.status === "expired" || d.status === "claimed") {
          setPhase({ kind: "ended", message: "요청 시간이 지났어요. 다시 요청해 주세요." });
        }
      } catch {
        /* 네트워크 일시 오류 — 다음 주기에 다시 */
      }
    };
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [base, phase]);

  if (phase.kind === "waiting") {
    return (
      <div role="status" style={{ display: "grid", gap: 12, textAlign: "center" }}>
        <p style={{ fontSize: 13, color: "var(--color-muted)", margin: 0 }}>
          호스트 운영자에게 아래 확인 코드를 알려 주세요. 승인되면 자동으로 들어갑니다.
        </p>
        <div data-testid="guest-code" style={{ fontSize: 32, fontWeight: 700, letterSpacing: 4, fontFamily: "var(--font-mono)" }}>
          {phase.code}
        </div>
        <p style={{ fontSize: 13, color: "var(--color-muted)", margin: 0 }}>승인 대기 중… (10분이 지나면 만료돼요)</p>
      </div>
    );
  }

  const notice = phase.kind === "ended" ? phase.message : refusal ? GUEST_REFUSAL_TEXT[refusal] ?? null : null;
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      <p style={{ fontSize: 13, color: "var(--color-muted)", margin: 0 }}>
        {base ? <code>{base}</code> : "이 호스트"}에 들어가려면 운영자 승인이 필요해요. 이름을 적어 입장을 요청하세요.
      </p>
      {notice && (
        <div role="alert" style={{ fontSize: 13, color: "var(--color-danger-text)" }}>
          {notice}
        </div>
      )}
      <TextField label="이름" maxLength={40} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      {error && (
        <div role="alert" style={{ fontSize: 13, color: "var(--color-danger-text)" }}>
          {error}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <Button type="button" variant="pill" onClick={onUseToken}>
          토큰 직접 입력
        </Button>
        <Button type="submit" variant="pillPrimary" disabled={sending}>
          {sending ? "요청 중..." : "입장 요청"}
        </Button>
      </div>
    </form>
  );
}

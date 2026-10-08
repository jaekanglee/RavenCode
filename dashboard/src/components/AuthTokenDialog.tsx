// AuthTokenDialog — Core API 토큰 입력 (Issue #24).
//
// loopback이 아닌 모든 출처(tailnet 포함)는 Core API에 Bearer 토큰이 필요하다.
// api-base.ts의 fetch 래퍼가 게이트 401을 받으면 `raven:auth-required`를 쏘고, 이
// 대화상자가 그 호스트(base URL)의 토큰을 받는다.
//
// Contract:
//  - 입력은 password 필드. 저장 전에 `<base>/api/vaults`로 검증한다 (헤더로만 전송).
//  - 통과한 토큰만 host-auth(sessionStorage)에 저장 → onVerified (기본: 새로고침).
//    저장이 거부되면(사생활 보호 모드 등) 성공으로 처리하지 않는다.
//  - 거절되면 저장하지 않고, 오류 문구에 입력값을 넣지 않는다.
import { useEffect, useState } from "react";
import { Modal } from "./ui/Modal";
import { TextField } from "./ui/TextField";
import { Button } from "./ui/Button";
import { AUTH_REQUIRED_EVENT, setHostToken, takePendingAuth } from "../lib/host-auth";

export interface AuthTokenDialogProps {
  /** 토큰이 검증·저장된 뒤 호출. 기본은 화면 새로고침. */
  onVerified?: () => void;
}

export function AuthTokenDialog({ onVerified = () => window.location.reload() }: AuthTokenDialogProps) {
  const [base, setBase] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    // A 401 may have landed before this mounted (first /api call races the render).
    const pending = takePendingAuth();
    if (pending !== null) setBase(pending);
    const onRequired = (e: Event) => {
      const detail = (e as CustomEvent<{ base: string }>).detail;
      takePendingAuth();
      setBase((current) => current ?? detail?.base ?? "");
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired);
  }, []);

  function close() {
    takePendingAuth();
    setBase(null);
    setToken("");
    setError(null);
  }

  async function submit(e?: { preventDefault(): void }) {
    e?.preventDefault();
    if (base === null) return;
    const value = token.trim();
    if (!value) {
      setError("토큰을 입력하세요.");
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const r = await fetch(`${base}/api/vaults`, { headers: { Authorization: `Bearer ${value}` } });
      if (r.ok) {
        if (!setHostToken(base, value)) {
          setError("토큰은 맞지만 이 브라우저가 저장을 거부했습니다 (사생활 보호 모드·저장소 차단 확인).");
          return;
        }
        close();
        onVerified();
        return;
      }
      setError(r.status === 401 ? "토큰이 맞지 않습니다." : `확인 실패 (HTTP ${r.status})`);
    } catch {
      setError("호스트에 연결하지 못했습니다.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <Modal open={base !== null} onClose={close} maxWidth={440} zIndex={1100}>
      <form onSubmit={submit} role="dialog" aria-labelledby="auth-token-title" style={{ display: "grid", gap: 12 }}>
        <h2 id="auth-token-title" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
          접근 토큰이 필요합니다
        </h2>
        <p style={{ fontSize: 13, color: "var(--color-muted)", margin: 0 }}>
          {base ? <code>{base}</code> : "이 호스트"}는 같은 PC가 아닌 곳(tailnet·내부망)에서의 접근에 토큰을 요구합니다.
          호스트 PC에서 <code>raven mcp token add &lt;이름&gt;</code>으로 발급하세요. 토큰은 이 창을 닫으면 지워집니다.
        </p>
        <TextField
          label="토큰"
          type="password"
          autoComplete="off"
          placeholder="rvn_..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
        {error && (
          <div role="alert" style={{ fontSize: 13, color: "var(--color-danger-text)" }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button type="button" variant="pill" onClick={close}>
            닫기
          </Button>
          <Button type="submit" variant="pillPrimary" disabled={checking}>
            {checking ? "확인 중..." : "확인"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

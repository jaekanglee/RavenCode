// LanAccessPanel — 관리 화면 "내부망 공개" 스위치 (spec 2026-10-16-desktop-lan-toggle-design).
//
// 데스크톱 앱 + 로컬 호스트에서만 렌더한다. 스위치를 바꾸면 셸이 설정을 저장하고 Core를
// 재시작한다(`set_lan_access`). 엔드포인트가 바뀌면 백엔드 재시작 버튼처럼 새로고침한다.
// 켜져 있으면 Core가 알려 주는 내부망 주소(`lan_api`)를 복사할 수 있게 보여 준다.
// RAVEN_DESKTOP_HOST/RAVEN_HOST가 설정돼 있으면 그 값이 이기므로 스위치를 끈다.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./ui/Button";
import { fetchSystemInfo } from "../lib/api";
import { getApiBase } from "../lib/api-base";
import { coreEndpointMoved } from "../lib/core-endpoint";

interface LanAccessStatus {
  enabled: boolean;
  env_override: boolean;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<any>;

function tauriInvoke(): Invoke | null {
  const internals = (window as any).__TAURI_INTERNALS__;
  return internals?.invoke ? (cmd, args) => internals.invoke(cmd, args) : null;
}

export interface LanAccessPanelProps {
  /** 테스트 주입용. 없으면 Tauri IPC. */
  invoke?: Invoke;
  /** 엔드포인트가 바뀐 뒤 호출. 기본은 새로고침. */
  onEndpointMoved?: () => void;
}

export function LanAccessPanel({ invoke, onEndpointMoved = () => window.location.reload() }: LanAccessPanelProps) {
  // tauriInvoke()는 부를 때마다 새 함수다. 렌더마다 바뀌면 refresh와 아래 effect가 매 렌더 다시 돌아
  // IPC+fetch가 끝없이 반복된다 (2026-10-19: WebKit에 요청 65만 건, 36GB).
  const call = useMemo(() => invoke ?? tauriInvoke(), [invoke]);
  const [status, setStatus] = useState<LanAccessStatus | null>(null);
  const [lanApi, setLanApi] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!call) return;
    try {
      setStatus(await call("lan_access_status"));
    } catch {
      setStatus(null);
    }
    const info = await fetchSystemInfo();
    setLanApi(info?.bind_host === "0.0.0.0" ? info.lan_api : null);
  }, [call]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!call || !status) return null;

  async function toggle(next: boolean) {
    if (!call) return;
    const prompt = next
      ? "내부망에 공개할까요? 같은 망의 다른 PC가 이 주소로 접속할 수 있게 되고(토큰 또는 손님 승인 필요), 백엔드가 재시작됩니다."
      : "내부망 공개를 끌까요? 이 PC에서만 접속할 수 있게 되고, 백엔드가 재시작됩니다.";
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setMessage(null);
    try {
      await call("set_lan_access", { enabled: next });
      const endpoint = await call("core_endpoint").catch(() => null);
      if (coreEndpointMoved(getApiBase(), endpoint)) {
        onEndpointMoved();
        return;
      }
      setMessage(next ? "✅ 내부망에 공개했습니다" : "✅ 이 PC 전용으로 돌렸습니다");
      await refresh();
    } catch (e) {
      setMessage(`❌ 바꾸지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="내부망 공개" style={{ marginTop: 32, borderTop: "2px solid var(--color-hairline)", paddingTop: 24 }}>
      <h2 style={{ fontSize: 17, margin: "0 0 4px" }}>내부망 공개</h2>
      <p style={{ fontSize: 13, margin: "0 0 12px", color: "var(--color-muted)" }}>
        켜면 같은 망의 동료가 링크로 대시보드에 들어올 수 있습니다. 들어오려면 토큰이나 손님 입장 승인이 필요하고,
        MCP는 이 PC에만 열려 있습니다.
      </p>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14 }}>
        <input
          type="checkbox"
          role="switch"
          aria-label="내부망 공개"
          checked={status.enabled && !status.env_override}
          disabled={busy || status.env_override}
          onChange={(e) => void toggle(e.target.checked)}
        />
        {busy ? "적용 중… (백엔드 재시작)" : status.env_override ? "환경변수로 고정됨" : status.enabled ? "켜짐" : "꺼짐 (이 PC 전용)"}
      </label>
      {status.env_override && (
        <p style={{ fontSize: 12, margin: "8px 0 0", color: "var(--color-muted)" }}>
          RAVEN_DESKTOP_HOST 또는 RAVEN_HOST가 설정돼 있어 그 값으로 바인딩합니다. 스위치를 쓰려면 환경변수를 지우세요.
        </p>
      )}
      {lanApi && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>동료에게 줄 주소</span>
          <code data-testid="lan-api" style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>
            {lanApi}
          </code>
          <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(lanApi).then(() => setMessage("✅ 주소를 복사했습니다"))}>
            복사
          </Button>
        </div>
      )}
      {message && <p style={{ fontSize: 13, margin: "10px 0 0", color: "var(--color-muted)" }}>{message}</p>}
    </section>
  );
}

// useLanAccess — 데스크톱 "내부망 공개" 스위치의 셸 쪽 상태와 전환 (spec 2026-10-16-desktop-lan-toggle-design).
//
// 관리 화면(LanAccessPanel)과 공유 팝오버(ShareButton)가 함께 쓴다. 셸이 설정을 저장하고 Core를
// 재시작한다(`set_lan_access`). 엔드포인트가 바뀌면 onEndpointMoved(기본: 새로고침).
// 브라우저(데스크톱 앱이 아님)에서는 supported=false — 호출하는 쪽이 스위치를 그리지 않는다.
// 관리 화면·공유 창·상단 표시가 각자 이 훅을 쓰므로, 한 곳에서 바꾸면 이벤트로 나머지도 다시 묻는다.
import { useCallback, useEffect, useMemo, useState } from "react";
import { getApiBase } from "./api-base";
import { coreEndpointMoved } from "./core-endpoint";

/** 내부망 공개를 바꾼 뒤 window에 쏘는 이벤트 — 다른 화면의 훅이 상태를 다시 묻는다. */
export const LAN_ACCESS_CHANGED_EVENT = "raven:lan-access-changed";

export interface LanAccessStatus {
  enabled: boolean;
  env_override: boolean;
}

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<any>;

/** 바꾼 결과. failed의 error는 셸이 준 사유 그대로. */
export type LanChange = { kind: "changed" } | { kind: "moved" } | { kind: "cancelled" } | { kind: "failed"; error: string };

export interface UseLanAccessOptions {
  /** 테스트 주입용. 없으면 Tauri IPC. */
  invoke?: Invoke;
  /** 엔드포인트가 바뀐 뒤 호출. 기본은 새로고침. */
  onEndpointMoved?: () => void;
  /** false면 상태를 묻지 않는다 (공유 팝오버는 열릴 때만 묻는다). 기본 true. */
  load?: boolean;
}

export interface LanAccess {
  /** 데스크톱 앱(셸 IPC 있음)일 때만 true. */
  supported: boolean;
  /** 셸이 알려 준 상태. 아직 모르거나 물을 수 없으면 null. */
  status: LanAccessStatus | null;
  busy: boolean;
  refresh: () => Promise<void>;
  /** 확인창 → 셸이 저장하고 Core 재시작. */
  setEnabled: (next: boolean) => Promise<LanChange>;
}

function tauriInvoke(): Invoke | null {
  const internals = (window as any).__TAURI_INTERNALS__;
  return internals?.invoke ? (cmd, args) => internals.invoke(cmd, args) : null;
}

function isStatus(value: unknown): value is LanAccessStatus {
  const s = value as LanAccessStatus | null;
  return !!s && typeof s.enabled === "boolean" && typeof s.env_override === "boolean";
}

export function useLanAccess({ invoke, onEndpointMoved = () => window.location.reload(), load = true }: UseLanAccessOptions = {}): LanAccess {
  // tauriInvoke()는 부를 때마다 새 함수다. 렌더마다 바뀌면 refresh와 아래 effect가 매 렌더 다시 돌아
  // IPC+fetch가 끝없이 반복된다 (2026-10-19: WebKit에 요청 65만 건, 36GB).
  const call = useMemo(() => invoke ?? tauriInvoke(), [invoke]);
  const [status, setStatus] = useState<LanAccessStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!call) return;
    try {
      const next = await call("lan_access_status");
      setStatus(isStatus(next) ? next : null);
    } catch {
      setStatus(null);
    }
  }, [call]);

  useEffect(() => {
    if (load) void refresh();
  }, [load, refresh]);

  useEffect(() => {
    if (!call) return;
    const onChanged = () => void refresh();
    window.addEventListener(LAN_ACCESS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(LAN_ACCESS_CHANGED_EVENT, onChanged);
  }, [call, refresh]);

  const setEnabled = async (next: boolean): Promise<LanChange> => {
    if (!call) return { kind: "failed", error: "데스크톱 앱에서만 바꿀 수 있습니다" };
    const prompt = next
      ? "내부망에 공개할까요? 같은 망의 다른 PC가 이 주소로 접속할 수 있게 되고(토큰 또는 손님 승인 필요), 백엔드가 재시작됩니다."
      : "내부망 공개를 끌까요? 이 PC에서만 접속할 수 있게 되고, 백엔드가 재시작됩니다.";
    if (!window.confirm(prompt)) return { kind: "cancelled" };
    setBusy(true);
    try {
      await call("set_lan_access", { enabled: next });
      const endpoint = await call("core_endpoint").catch(() => null);
      if (coreEndpointMoved(getApiBase(), endpoint)) {
        onEndpointMoved();
        return { kind: "moved" };
      }
      await refresh();
      window.dispatchEvent(new CustomEvent(LAN_ACCESS_CHANGED_EVENT));
      return { kind: "changed" };
    } catch (e) {
      return { kind: "failed", error: e instanceof Error ? e.message : String(e) };
    } finally {
      setBusy(false);
    }
  };

  return { supported: call !== null, status, busy, refresh, setEnabled };
}

// LanAccessIndicator — 상단 "🌐 내부망 공개 중" 표시 (2026-10-19).
//
// 내부망 공개는 문서 단위가 아니라 Raven 전체 단위다. 켜져 있는 동안 어느 화면에서든 보이게 해서,
// 무엇이 열려 있고(주소) 누가 들어올 수 있는지(승인된 손님 · vault 권한)를 확인하고 바로 끌 수 있게 한다.
// 데스크톱 앱에서, 실제 바인딩이 loopback이 아닐 때만 그린다 (환경변수로 연 경우 포함).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { fetchSystemInfo, type SystemInfo } from "../lib/api";
import { describeBindExposure } from "../lib/bind-exposure";
import { GUEST_PERM_LABEL, listGuestGrants, type GuestGrant } from "../lib/guest";
import { useLanAccess, type Invoke } from "../lib/useLanAccess";
import { Button } from "./ui/Button";

const POPOVER_WIDTH = 320;
const VIEWPORT_MARGIN = 8;

/** `rider-app(읽기), hub-control-room(읽기·작성)` */
function vaultScope(grant: GuestGrant): string {
  return Object.entries(grant.vaults)
    .map(([vault, perms]) => `${vault}(${perms.map((perm) => GUEST_PERM_LABEL[perm]).join("·")})`)
    .join(", ");
}

export interface LanAccessIndicatorProps {
  /** 테스트 주입용. 없으면 Tauri IPC. */
  invoke?: Invoke;
}

export function LanAccessIndicator({ invoke }: LanAccessIndicatorProps) {
  const lan = useLanAccess({ invoke });
  const status = lan.status;
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [grants, setGrants] = useState<GuestGrant[] | null>(null);
  const [grantsFailed, setGrantsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // 셸 상태가 바뀔 때마다(처음, 켬/끔, 다른 화면에서 바꿈) 실제 바인딩을 다시 본다.
  useEffect(() => {
    if (!status) return;
    let alive = true;
    void fetchSystemInfo().then((next) => {
      if (alive) setSysInfo(next);
    });
    return () => {
      alive = false;
    };
  }, [status]);

  // 열 때마다 승인된 손님을 새로 받는다 — 관리 화면에서 승인·회수했을 수 있다.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setGrants(null);
    setGrantsFailed(false);
    setError(null);
    listGuestGrants()
      .then((list) => alive && setGrants(list))
      .catch(() => alive && setGrantsFailed(true));
    return () => {
      alive = false;
    };
  }, [open]);

  // 버튼 아래 오른쪽 맞춤. 바깥 클릭과 Esc로 닫는다.
  useEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
      setPos({ top: rect.bottom + 6, left: Math.max(VIEWPORT_MARGIN, Math.min(rect.right - POPOVER_WIDTH, maxLeft)) });
    }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const exposed = !!status && !!sysInfo && describeBindExposure(sysInfo.bind_host).kind !== "loopback";
  if (!status || !sysInfo || !exposed) return null;

  async function turnOff() {
    setError(null);
    const change = await lan.setEnabled(false);
    if (change.kind === "changed") setOpen(false);
    else if (change.kind === "failed") setError(`❌ 끄지 못했습니다: ${change.error}`);
  }

  const muted = { fontSize: 11, color: "var(--color-muted)", lineHeight: 1.5 } as const;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="lan-indicator"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        🌐 내부망 공개 중
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="내부망 공개 상태"
            style={{
              position: "fixed",
              top: pos?.top ?? 60,
              left: pos?.left ?? VIEWPORT_MARGIN,
              width: POPOVER_WIDTH,
              background: "var(--color-canvas)",
              border: "1px solid var(--color-hairline-strong)",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--shadow-overlay)",
              padding: 14,
              zIndex: 100,
              display: "grid",
              gap: 10,
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>🌐 이 PC의 Raven이 같은 망에 열려 있습니다</div>
              <div style={muted}>
                문서 하나가 아니라 Raven 전체가 열려 있습니다. 들어올 수 있는 건 승인된 손님뿐이고, 손님이 볼 수 있는 범위는 승인할 때 고른 vault입니다.
              </div>
            </div>
            <div style={{ display: "grid", gap: 2, fontSize: 12 }}>
              {sysInfo.lan_api && (
                <div>
                  내부망 <code style={{ fontFamily: "var(--font-mono)" }}>{sysInfo.lan_api}</code>
                </div>
              )}
              {sysInfo.tailscale_api && (
                <div>
                  Tailscale <code style={{ fontFamily: "var(--font-mono)" }}>{sysInfo.tailscale_api}</code>
                </div>
              )}
            </div>
            <div style={{ fontSize: 12 }}>
              {grantsFailed ? (
                <div style={muted}>승인된 손님 목록을 불러오지 못했습니다.</div>
              ) : grants === null ? (
                <div style={muted}>승인된 손님 확인 중…</div>
              ) : grants.length === 0 ? (
                <div style={muted}>승인된 손님 없음 — 링크를 받은 동료는 입장을 요청하고, 승인해야 들어옵니다.</div>
              ) : (
                <>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>승인된 손님 {grants.length}명</div>
                  <ul style={{ margin: 0, paddingLeft: 16, display: "grid", gap: 2 }}>
                    {grants.map((grant) => (
                      <li key={grant.id}>
                        {grant.name} — {vaultScope(grant)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <Link to="/vault/manage" onClick={() => setOpen(false)} style={{ fontSize: 12, display: "inline-block", marginTop: 4 }}>
                손님 관리 →
              </Link>
            </div>
            {status.env_override ? (
              <div style={muted}>환경변수(RAVEN_DESKTOP_HOST 또는 RAVEN_HOST)로 열려 있어 여기서 끌 수 없습니다.</div>
            ) : (
              <div style={{ textAlign: "right" }}>
                <Button type="button" size="sm" variant="secondary" disabled={lan.busy} onClick={() => void turnOff()}>
                  {lan.busy ? "끄는 중… (백엔드 재시작)" : "공개 끄기"}
                </Button>
              </div>
            )}
            {error && <div style={{ fontSize: 11, color: "var(--color-danger-text)" }}>{error}</div>}
          </div>,
          document.body,
        )}
    </>
  );
}

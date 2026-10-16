// GuestBanner — 손님 모드 한 줄 안내 (spec 2026-10-16-guest-access-design).
// "손님으로 접속 중 · rider-app(읽기·수정) · 2026-11-15까지". 손님이 아니면 아무것도 그리지 않는다.
import { GUEST_PERM_LABEL, type GuestMe } from "../lib/guest";

export function describeGuest(me: GuestMe): string {
  const vaults = Object.entries(me.vaults)
    .map(([name, perms]) => `${name}(${perms.map((p) => GUEST_PERM_LABEL[p]).join("·")})`)
    .join(", ");
  const until = me.expires ? ` · ${me.expires.slice(0, 10)}까지` : "";
  return `손님으로 접속 중 · ${vaults}${until}`;
}

export function GuestBanner({ me }: { me: GuestMe | null }) {
  if (!me) return null;
  return (
    <div
      role="note"
      style={{
        padding: "6px 20px",
        fontSize: 12,
        color: "var(--color-muted)",
        background: "var(--color-surface-soft)",
        borderBottom: "1px solid var(--color-hairline)",
        flexShrink: 0,
      }}
    >
      {describeGuest(me)}
    </div>
  );
}

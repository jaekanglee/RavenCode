// GuestAccessPanel — 관리 화면 "손님 입장" 섹션 (spec 2026-10-16-guest-access-design).
//
// 운영자 탭에서만 렌더한다. 대기 중인 입장 요청을 5초마다 새로 받고, 요청마다 vault별
// 읽기/작성/수정과 기간(7일/30일/무기한)을 골라 승인하거나 거절한다. 승인된 기기는
// 이름·IP·권한·만료·마지막 접속과 함께 보여 주고 내보낼 수 있다.
// 확인 코드는 손님 화면의 코드와 같은지 운영자가 직접 대조하라고 크게 보여 준다.
import { useCallback, useEffect, useState } from "react";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/EmptyState";
import { SelectField } from "./ui/SelectField";
import {
  GUEST_PERMS,
  GUEST_PERM_LABEL,
  PENDING_POLL_MS,
  approveGuestRequest,
  denyGuestRequest,
  listGuestGrants,
  listGuestRequests,
  normalizeGuestPerms,
  revokeGuestGrant,
  type GuestGrant,
  type GuestPerm,
  type GuestRequest,
  type GuestTtl,
  type GuestVaults,
} from "../lib/guest";

const TTL_OPTIONS = [
  { value: "7", label: "7일" },
  { value: "30", label: "30일" },
  { value: "none", label: "무기한" },
];

function ttlOf(value: string): GuestTtl {
  return value === "7" ? 7 : value === "30" ? 30 : null;
}

function describeVaults(vaults: GuestVaults): string {
  return Object.entries(vaults)
    .map(([name, perms]) => `${name}(${perms.map((p) => GUEST_PERM_LABEL[p]).join("·")})`)
    .join(", ");
}

function formatTime(iso: string | null): string {
  return iso ? iso.replace("T", " ").slice(0, 16) : "—";
}

function ApproveForm({ request, vaults, onDone }: { request: GuestRequest; vaults: string[]; onDone: () => void }) {
  const [perms, setPerms] = useState<Record<string, GuestPerm[]>>({});
  const [ttl, setTtl] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(vault: string, perm: GuestPerm, on: boolean) {
    setPerms((cur) => {
      const now = new Set(cur[vault] ?? []);
      if (on) now.add(perm);
      else {
        now.delete(perm);
        // 읽기를 끄면 작성·수정도 끈다 (작성·수정은 읽기를 포함)
        if (perm === "read") now.clear();
      }
      return { ...cur, [vault]: normalizeGuestPerms([...now]) };
    });
  }

  const selected: GuestVaults = Object.fromEntries(Object.entries(perms).filter(([, p]) => p.length > 0));

  async function act(kind: "approve" | "deny") {
    setBusy(true);
    setError(null);
    try {
      if (kind === "approve") await approveGuestRequest(request.request_id, selected, ttlOf(ttl));
      else await denyGuestRequest(request.request_id);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      aria-label={`${request.name}의 입장 요청`}
      style={{ border: "1px solid var(--color-hairline)", borderRadius: 8, padding: 12, display: "grid", gap: 10 }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12 }}>
        <strong>{request.name}</strong>
        <span style={{ fontSize: 12, color: "var(--color-muted)", fontFamily: "var(--font-mono)" }}>{request.ip}</span>
        <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: 3, fontFamily: "var(--font-mono)" }}>{request.code}</span>
        <span style={{ fontSize: 12, color: "var(--color-muted)" }}>{Math.ceil(request.expires_in / 60)}분 남음</span>
      </div>
      <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>vault</th>
            {GUEST_PERMS.map((p) => (
              <th key={p} style={{ padding: "2px 8px" }}>
                {GUEST_PERM_LABEL[p]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {vaults.map((v) => (
            <tr key={v}>
              <td style={{ padding: "2px 8px 2px 0", fontFamily: "var(--font-mono)" }}>{v}</td>
              {GUEST_PERMS.map((p) => (
                <td key={p} style={{ textAlign: "center", padding: "2px 8px" }}>
                  <input
                    type="checkbox"
                    aria-label={`${v} ${GUEST_PERM_LABEL[p]}`}
                    checked={(perms[v] ?? []).includes(p)}
                    onChange={(e) => toggle(v, p, e.target.checked)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
        <div style={{ width: 140 }}>
          <SelectField label="기간" options={TTL_OPTIONS} value={ttl} onChange={(e) => setTtl(e.target.value)} />
        </div>
        <Button size="sm" disabled={busy || Object.keys(selected).length === 0} onClick={() => void act("approve")}>
          승인
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act("deny")}>
          거절
        </Button>
      </div>
      {error && <p style={{ fontSize: 13, margin: 0, color: "var(--color-danger)" }}>❌ {error}</p>}
    </li>
  );
}

export function GuestAccessPanel({ vaults }: { vaults: string[] }) {
  const [requests, setRequests] = useState<GuestRequest[]>([]);
  const [grants, setGrants] = useState<GuestGrant[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadRequests = useCallback(
    () =>
      listGuestRequests()
        .then(setRequests)
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [],
  );
  const loadGrants = useCallback(
    () =>
      listGuestGrants()
        .then(setGrants)
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [],
  );

  useEffect(() => {
    void loadRequests();
    void loadGrants();
    const timer = window.setInterval(() => void loadRequests(), PENDING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadRequests, loadGrants]);

  async function revoke(id: string) {
    try {
      await revokeGuestGrant(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    void loadGrants();
  }

  return (
    <section id="guests" aria-label="손님 입장" style={{ marginTop: 32, borderTop: "2px solid var(--color-hairline)", paddingTop: 24 }}>
      <h2 style={{ fontSize: 17, margin: "0 0 4px" }}>손님 입장</h2>
      <p style={{ fontSize: 13, margin: "0 0 12px", color: "var(--color-muted)" }}>
        내부망 동료가 링크를 열면 여기로 입장 요청이 옵니다. 확인 코드가 동료 화면과 같은지 확인하고 승인하세요.
        삭제와 관리 작업은 손님에게 열리지 않습니다.
      </p>
      {error && <p style={{ fontSize: 13, margin: "0 0 12px", color: "var(--color-danger)" }}>❌ {error}</p>}

      <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>대기 중인 요청</h3>
      {requests.length === 0 ? (
        <EmptyState title="대기 중인 입장 요청이 없습니다" description="동료가 링크를 열고 입장을 요청하면 여기에 나타납니다." />
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
          {requests.map((r) => (
            <ApproveForm
              key={r.request_id}
              request={r}
              vaults={vaults}
              onDone={() => {
                void loadRequests();
                void loadGrants();
              }}
            />
          ))}
        </ul>
      )}

      <h3 style={{ fontSize: 14, margin: "20px 0 8px" }}>승인된 기기</h3>
      {grants.length === 0 ? (
        <p style={{ fontSize: 13, margin: 0, color: "var(--color-muted)" }}>승인된 기기가 없습니다.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--color-hairline)" }}>
              {["이름", "IP", "권한", "만료", "마지막 접속", ""].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: "4px 6px" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.id} style={{ borderBottom: "1px solid var(--color-hairline)" }}>
                <td style={{ padding: "4px 6px" }}>{g.name}</td>
                <td style={{ padding: "4px 6px", fontFamily: "var(--font-mono)" }}>{g.ip}</td>
                <td style={{ padding: "4px 6px" }}>{describeVaults(g.vaults)}</td>
                <td style={{ padding: "4px 6px" }}>{g.expires ? formatTime(g.expires) : "무기한"}</td>
                <td style={{ padding: "4px 6px" }}>{formatTime(g.last_seen)}</td>
                <td style={{ padding: "4px 6px", textAlign: "right" }}>
                  <Button size="sm" variant="danger" onClick={() => void revoke(g.id)}>
                    내보내기
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

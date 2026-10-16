/**
 * 손님 입장 — 대시보드 쪽 상태와 API (spec 2026-10-16-guest-access-design).
 *
 * 이 탭이 손님 토큰(`rvg_`)으로 붙어 있으면 손님 모드: `/api/guest/me`의 vault별 권한으로
 * 할 수 없는 버튼을 숨긴다. 서버(게이트)의 403이 원칙이고 숨김은 편의다.
 * 운영자(데스크톱 세션 · `rvn_` 토큰)는 관리 탭에서 입장 요청을 승인·거절하고 승인된 기기를 내보낸다.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import { getActiveTargetBaseUrl } from "./api-base";
import { authHeaderFor, isGuestAuth } from "./host-auth";

export type GuestPerm = "read" | "create" | "update";
export const GUEST_PERMS: GuestPerm[] = ["read", "create", "update"];
export const GUEST_PERM_LABEL: Record<GuestPerm, string> = { read: "읽기", create: "작성", update: "수정" };
export type GuestVaults = Record<string, GuestPerm[]>;
export type GuestTtl = 7 | 30 | null;

export interface GuestMe {
  name: string;
  vaults: GuestVaults;
  expires: string | null;
}

export interface GuestRequest {
  request_id: string;
  name: string;
  ip: string;
  code: string;
  created: string;
  expires_in: number;
}

export interface GuestGrant {
  id: string;
  name: string;
  device_id: string;
  ip: string;
  vaults: GuestVaults;
  created: string;
  expires: string | null;
  last_seen: string | null;
}

/** 이 탭이 손님 토큰으로 붙어 있는가. */
export function isGuestTab(): boolean {
  return isGuestAuth(authHeaderFor(getActiveTargetBaseUrl()));
}

/** 이 탭이 운영자 자격(데스크톱 세션 또는 발급 토큰)을 가졌는가. 토큰이 없으면 false. */
export function isOwnerTab(): boolean {
  const auth = authHeaderFor(getActiveTargetBaseUrl());
  return !!auth && !isGuestAuth(auth);
}

/** 손님이 `vault`에서 `perm`을 할 수 있는가. 손님이 아니면(me=null) 항상 true. */
export function canGuest(me: GuestMe | null, vault: string, perm: GuestPerm): boolean {
  return me === null || (me.vaults[vault] ?? []).includes(perm);
}

/** 체크된 권한을 서버 규칙대로 정리: 작성·수정이 있으면 읽기도. 아무것도 없으면 []. */
export function normalizeGuestPerms(perms: GuestPerm[]): GuestPerm[] {
  const chosen = new Set(perms);
  if (chosen.has("create") || chosen.has("update")) chosen.add("read");
  return GUEST_PERMS.filter((p) => chosen.has(p));
}

let mePromise: Promise<GuestMe | null> | null = null;

export function fetchGuestMe(): Promise<GuestMe | null> {
  if (!isGuestTab()) return Promise.resolve(null);
  if (!mePromise) {
    mePromise = apiFetch("/api/guest/me")
      .then((r) => (r.ok ? (r.json() as Promise<GuestMe>) : null))
      .catch(() => null);
  }
  return mePromise;
}

/** 손님 모드면 내 권한, 아니면 null. */
export function useGuestMe(): GuestMe | null {
  const [me, setMe] = useState<GuestMe | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchGuestMe().then((m) => alive && setMe(m));
    return () => {
      alive = false;
    };
  }, []);
  return me;
}

export const PENDING_POLL_MS = 5000;

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* keep status */
    }
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
}

export async function listGuestRequests(): Promise<GuestRequest[]> {
  return (await json<{ requests: GuestRequest[] }>(await apiFetch("/api/guest/requests"))).requests;
}

export async function approveGuestRequest(id: string, vaults: GuestVaults, ttlDays: GuestTtl): Promise<void> {
  await json(await apiFetch(`/api/guest/requests/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vaults, ttl_days: ttlDays }),
  }));
}

export async function denyGuestRequest(id: string): Promise<void> {
  await json(await apiFetch(`/api/guest/requests/${encodeURIComponent(id)}/deny`, { method: "POST" }));
}

export async function listGuestGrants(): Promise<GuestGrant[]> {
  return (await json<{ grants: GuestGrant[] }>(await apiFetch("/api/guest/grants"))).grants;
}

export async function revokeGuestGrant(id: string): Promise<void> {
  await json(await apiFetch(`/api/guest/grants/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

/** 운영자 탭에서 대기 중인 입장 요청 수 (5초 폴링). 운영자가 아니면 0이고 요청하지 않는다. */
export function usePendingGuestCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!isOwnerTab()) return;
    let alive = true;
    const tick = () =>
      listGuestRequests()
        .then((rs) => alive && setCount(rs.length))
        .catch(() => {});
    void tick();
    const timer = window.setInterval(tick, PENDING_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  return count;
}

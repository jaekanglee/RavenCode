/**
 * Per-host Core API tokens (Issue #24).
 *
 * Every non-loopback source — tailnet included — needs `Authorization: Bearer`
 * on the Core API. The dashboard keeps the token the user entered for each host
 * here, keyed by the host's base URL ("" = the same origin the dashboard came from).
 *
 * Storage: sessionStorage only — it survives the reloads the host switcher does,
 * and is gone when the window closes. Never localStorage, never a URL, never a
 * log line. Revoke on the server with `raven mcp token revoke <name>`.
 */

const KEY_PREFIX = "raven:host-token:";

/**
 * Canonical form of a host base URL: a bare `http(s)://host:port` becomes its URL
 * origin (lower-cased host, default port dropped), so the stored key and the origin
 * the fetch wrapper computes for an absolute URL always match. "" and bases with a
 * path are only trimmed.
 */
export function canonicalBase(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.pathname === "/" && !url.search && !url.hash ? url.origin : trimmed;
  } catch {
    return trimmed;
  }
}

function keyFor(base: string): string {
  return KEY_PREFIX + canonicalBase(base);
}

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function getHostToken(base: string): string | null {
  try {
    return store()?.getItem(keyFor(base)) || null;
  } catch {
    return null;
  }
}

/** Stores the token; false when it was blank or the browser refused to keep it. */
export function setHostToken(base: string, token: string): boolean {
  const value = token.trim();
  if (!value) return false;
  try {
    const s = store();
    if (!s) return false;
    s.setItem(keyFor(base), value);
    return s.getItem(keyFor(base)) === value;
  } catch {
    // storage unavailable (private mode, quota) — the caller must not report success
    return false;
  }
}

export function clearHostToken(base: string): void {
  try {
    store()?.removeItem(keyFor(base));
  } catch {
    /* ignore */
  }
}

// Issue #67: the desktop shell's credential for its own Core (Tauri IPC
// `core_session_token`). Memory only — never storage, a URL or a log — and only for
// that one base, so it is never sent to another host the user registered.
let sessionCredential: { base: string; token: string } | null = null;

export function setSessionCredential(base: string, token: string): void {
  const value = token.trim();
  sessionCredential = value ? { base: canonicalBase(base), token: value } : null;
}

// Every Core start has its own credential (a restarted Core refuses the old one), so the
// desktop shell registers how to fetch the running Core's endpoint and credential
// (Tauri IPC `core_session_token`, one snapshot of both).
export type SessionSnapshot = { endpoint: string; token: string };
let sessionRefresher: (() => Promise<SessionSnapshot | null>) | null = null;
let refreshing: Promise<SessionSnapshot | null> | null = null;

export function setSessionRefresher(fn: (() => Promise<SessionSnapshot | null>) | null): void {
  sessionRefresher = fn;
}

/** True when `header` is the desktop credential this tab would send to `base`. */
export function isSessionAuth(base: string, header: string | null): boolean {
  return !!sessionCredential && sessionCredential.base === canonicalBase(base) && header === `Bearer ${sessionCredential.token}`;
}

/**
 * After the Core refused the desktop credential `sent`: make sure the current one is newer.
 * True → the caller retries once with `authHeaderFor(base)`; false → token dialog.
 *  - another request already rotated it (current ≠ sent): no IPC, just retry;
 *  - else ask the shell for its running Core (one shared call for concurrent 401s) and take
 *    the credential only if that Core still serves `base` — after a port move the old port
 *    may belong to another process, which must not receive the new credential.
 */
export async function refreshSessionCredential(base: string, sent: string | null): Promise<boolean> {
  const key = canonicalBase(base);
  if (!sessionCredential || sessionCredential.base !== key) return false;
  if (sent !== `Bearer ${sessionCredential.token}`) return true;
  if (!sessionRefresher) return false;
  const stale = sessionCredential.token;
  if (!refreshing) {
    refreshing = sessionRefresher()
      .catch(() => null)
      .finally(() => {
        refreshing = null;
      });
  }
  const snap = await refreshing;
  if (!snap || canonicalBase(snap.endpoint) !== key) return false;
  const fresh = snap.token.trim();
  if (!fresh || fresh === stale) return false;
  if (sessionCredential && sessionCredential.base === key) sessionCredential = { base: key, token: fresh };
  return sessionCredential?.token === fresh;
}

/**
 * A 401 for `refused` (the Authorization the request carried) at `base`:
 *  - "cleared": it was the current desktop credential — dropped, the token dialog takes over;
 *  - "stale": it was an older desktop credential that was already replaced — keep the new one;
 *  - "none": not the desktop credential (a stored host token, or none).
 */
export function releaseRefusedSession(base: string, refused: string | null): "cleared" | "stale" | "none" {
  if (!refused || !/^bearer rvs_/i.test(refused)) {
    return "none";
  }
  if (sessionCredential && sessionCredential.base === canonicalBase(base)) {
    if (refused === `Bearer ${sessionCredential.token}`) {
      sessionCredential = null;
      return "cleared";
    }
    return "stale";
  }
  return "stale";
}

/** Drops the desktop credential (e.g. the Core refused it) so the token dialog can take over. */
export function clearSessionCredential(base: string): boolean {
  if (sessionCredential && sessionCredential.base === canonicalBase(base)) {
    sessionCredential = null;
    return true;
  }
  return false;
}

/** `Bearer <token>` for a host, or null: the desktop credential for its own Core, else the stored token. */
export function authHeaderFor(base: string): string | null {
  if (sessionCredential && sessionCredential.base === canonicalBase(base)) {
    return `Bearer ${sessionCredential.token}`;
  }
  const token = getHostToken(base);
  return token ? `Bearer ${token}` : null;
}

export const AUTH_REQUIRED_EVENT = "raven:auth-required";

// The first /api call can 401 before React mounts AuthTokenDialog, so the request
// is remembered here as well as broadcast; the dialog picks it up on mount.
let pendingAuthBase: string | null = null;

export function requestAuth(base: string): void {
  if (pendingAuthBase === null) pendingAuthBase = base;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT, { detail: { base } }));
  }
}

/** Returns and clears the pending auth request, if any. */
export function takePendingAuth(): string | null {
  const base = pendingAuthBase;
  pendingAuthBase = null;
  return base;
}

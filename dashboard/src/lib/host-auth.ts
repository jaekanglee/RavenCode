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

/** `Bearer <token>` for a host, or null. */
export function authHeaderFor(base: string): string | null {
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

/**
 * API base URL for the Raven Dashboard.
 *
 * Browser mode (vite dev / static serve): empty string — relative /api/...
 * URLs are proxied by vite or served by the same origin.
 *
 * Tauri desktop mode: set to the Python Core endpoint
 * (e.g. http://127.0.0.1:54321) before React renders.
 *
 * Auth (Issue #24): `/api/*` requests carry the per-host Bearer token from
 * host-auth.ts; a gate 401 raises `raven:auth-required` (AuthTokenDialog).
 *
 * Multi-host mode (v0.8.0+): if an active remote host is selected,
 * the fetch/sendBeacon wrappers below dynamically prepend the active host's
 * endpoint to every /api/... request so the whole dashboard smoothly
 * switches target server context.
 */

import { authHeaderFor, requestAuth } from "./host-auth";

let apiBase = "";

export function setApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, "");
}

export function getApiBase(): string {
  return apiBase;
}

export function getActiveTargetBaseUrl(): string {
  if (typeof window === "undefined") return apiBase;
  try {
    const activeId = localStorage.getItem("raven:active_host") || "local";
    if (activeId === "local") return apiBase;
    const raw = localStorage.getItem("raven:hosts");
    if (!raw) return apiBase;
    const hosts = JSON.parse(raw);
    const found = hosts.find((h: any) => h.id === activeId);
    if (found && found.endpoint && !found.isLocal) {
      return found.endpoint.replace(/\/+$/, "");
    }
  } catch {}
  return apiBase;
}

// ─── install wrappers (module-load time, before any component mounts) ───
//
// Issue #24: the Core API needs `Authorization: Bearer` from every non-loopback
// source, tailnet included. The wrapper attaches the token the user entered for
// the host the request actually goes to (host-auth.ts, sessionStorage only) —
// to `/api/*` requests only, never in the URL, never over an explicit header.

function isApiPath(input: unknown): input is string {
  return typeof input === "string" && input.startsWith("/api/");
}

function withAuth(init: RequestInit | undefined, base: string): RequestInit | undefined {
  const auth = authHeaderFor(base);
  if (!auth) return init;
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization")) headers.set("Authorization", auth);
  return { ...init, headers };
}

function handleUnauthorized(res: Response, base: string): void {
  if (res.status !== 401) return;
  const challenge = res.headers.get("www-authenticate") || "";
  if (base === "" && challenge.startsWith('Session realm="raven-dashboard"')) {
    // Docker dashboard proxy: its own login page holds the session, not this tab.
    const next = window.location.pathname + window.location.search;
    window.location.assign(`/__raven/login?next=${encodeURIComponent(next)}`);
  } else if (challenge.startsWith("Bearer")) {
    requestAuth(base);
  }
}

/** Origin of an absolute `http(s)://host/api/...` URL, else null. */
function absoluteApiOrigin(input: unknown): string | null {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : null;
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.pathname.startsWith("/api/") ? url.origin : null;
  } catch {
    return null;
  }
}

if (typeof window !== "undefined") {
  const origFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (isApiPath(input)) {
      const targetBase = getActiveTargetBaseUrl();
      return origFetch(targetBase + input, withAuth(init, targetBase)).then((res) => {
        handleUnauthorized(res, targetBase);
        return res;
      });
    }
    // Absolute URLs (lib/api.ts apiFetch for a remote host): only the token stored
    // for exactly this origin is attached — never another host's.
    const origin = absoluteApiOrigin(input);
    if (origin !== null) {
      return origFetch(input, withAuth(init, origin)).then((res) => {
        // Only the active host prompts; a probe of another host (HostPicker test)
        // reports its own 401 instead of opening the global dialog.
        if (origin === getActiveTargetBaseUrl()) handleUnauthorized(res, origin);
        return res;
      });
    }
    return origFetch(input, init);
  };

  const origBeacon = navigator.sendBeacon?.bind(navigator);
  if (origBeacon) {
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      if (!isApiPath(url)) return origBeacon(url, data);
      const targetBase = getActiveTargetBaseUrl();
      const auth = authHeaderFor(targetBase);
      if (auth) {
        // Beacons cannot carry headers; keepalive fetch survives unload the same way.
        void origFetch(targetBase + url, {
          method: "POST",
          body: data ?? null,
          keepalive: true,
          headers: { Authorization: auth },
        }).catch(() => {});
        return true;
      }
      return origBeacon(targetBase + url, data);
    };
  }
}

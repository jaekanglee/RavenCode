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
 * the fetch/sendBeacon wrappers below prepend that host's endpoint to every
 * /api/... request.
 *
 * Issue #32: the host is fixed per tab when the document loads. The active host
 * lives in localStorage, which every tab shares — reading it on each request
 * sent this tab's saves and deletes to whatever host another tab had just
 * picked, while this tab still showed the old host's data. A host switch is
 * always a full reload (HostPicker), and another tab's switch is picked up by
 * watchTabHostChange → reload (tab-host-sync.ts), so the tab's requests,
 * tokens and screen always refer to one host.
 */

import { authHeaderFor, canonicalBase, clearHostToken, requestAuth } from "./host-auth";

let apiBase = "";

export function setApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, "");
}

export function getApiBase(): string {
  return apiBase;
}

const ACTIVE_HOST_KEY = "raven:active_host";
const HOSTS_KEY = "raven:hosts";

/**
 * Host the stored selection points at: its id and remote endpoint ("" = this dashboard's own Core).
 * `error` is set when a remote host is selected but its settings can't be used (list missing or
 * corrupt, id not listed, endpoint missing or not http(s)). Such a tab sends no /api request at
 * all — falling back to the local Core would silently write to a host the user didn't pick
 * (PR #35 review). HostConfigGate shows the error instead of the app.
 */
interface TabHost {
  id: string;
  endpoint: string;
  error: string | null;
}

function remoteEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Same string as before validation (token keys and cache keys are derived from it).
    return raw.trim().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function readStoredHost(): TabHost {
  const local: TabHost = { id: "local", endpoint: "", error: null };
  if (typeof window === "undefined") return local;
  let activeId: string;
  let raw: string | null;
  try {
    activeId = localStorage.getItem(ACTIVE_HOST_KEY) || "local";
    raw = localStorage.getItem(HOSTS_KEY);
  } catch {
    return local; // storage unavailable: no selection can exist, so this is the local Core
  }
  if (activeId === "local") return local;
  const broken = (why: string): TabHost => ({ id: activeId, endpoint: "", error: why });
  if (!raw) return broken("저장된 호스트 목록이 없습니다.");
  let hosts: unknown;
  try {
    hosts = JSON.parse(raw);
  } catch {
    return broken("저장된 호스트 목록이 손상되었습니다.");
  }
  if (!Array.isArray(hosts)) return broken("저장된 호스트 목록이 손상되었습니다.");
  const found = hosts.find((h: any) => h && h.id === activeId);
  if (!found) return broken("선택한 호스트가 목록에 없습니다.");
  if (found.isLocal) return local;
  const endpoint = remoteEndpoint(found.endpoint);
  if (!endpoint) return broken("선택한 호스트의 주소가 비어 있거나 올바르지 않습니다.");
  return { id: activeId, endpoint, error: null };
}

// Fixed once per document. Never re-read per request (see header).
const tabHost: TabHost = readStoredHost();

/** Id of the host this tab shows and talks to (fixed at load). */
export function getTabHostId(): string {
  return tabHost.id;
}

/** Remote endpoint of this tab's host, or "" for the dashboard's own Core. */
export function getTabHostEndpoint(): string {
  return tabHost.endpoint;
}

/** Why this tab's selected remote host can't be used, or null. When set, /api requests are refused. */
export function getTabHostError(): string | null {
  return tabHost.error;
}

export class HostConfigError extends Error {
  constructor(reason: string) {
    super(`원격 호스트 설정 오류로 요청을 보내지 않았습니다: ${reason}`);
    this.name = "HostConfigError";
  }
}

export function getActiveTargetBaseUrl(): string {
  return tabHost.endpoint || apiBase;
}

/**
 * Calls onChange when another tab changes the stored host selection so that it
 * no longer matches this tab's host (active id switched, this host's endpoint
 * edited or removed, storage cleared). Same-tab writes fire no storage event.
 */
export function watchTabHostChange(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== ACTIVE_HOST_KEY && e.key !== HOSTS_KEY) return;
    const stored = readStoredHost();
    if (stored.id === tabHost.id && stored.endpoint === tabHost.endpoint && stored.error === tabHost.error) return;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
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

// A request that carries an auto-attached token must not follow redirects: the token
// was meant for this host only, and stripping Authorization on a cross-origin hop is
// left to each browser engine (the Core API itself never redirects /api calls).
function withAuth(init: RequestInit | undefined, base: string): { init: RequestInit | undefined; auto: boolean } {
  const auth = authHeaderFor(base);
  if (!auth) return { init, auto: false };
  const headers = new Headers(init?.headers);
  if (headers.has("authorization")) return { init, auto: false };
  headers.set("Authorization", auth);
  return { init: { ...init, headers, redirect: init?.redirect ?? "error" }, auto: true };
}

function handleUnauthorized(res: Response, base: string, auto: boolean): void {
  if (res.status !== 401) return;
  const challenge = res.headers.get("www-authenticate") || "";
  if (base === "" && /^session\s+realm="raven-dashboard"/i.test(challenge)) {
    // Docker dashboard proxy: its own login page holds the session, not this tab.
    const next = window.location.pathname + window.location.search;
    window.location.assign(`/__raven/login?next=${encodeURIComponent(next)}`);
  } else if (/^bearer\b/i.test(challenge)) {
    // The stored token was refused (revoked or wrong): drop it, ask again.
    if (auto) clearHostToken(base);
    requestAuth(base);
  }
}

/** Token key of an absolute `/api/...` URL: "" for the dashboard's own origin, else the origin. */
function absoluteApiBase(raw: string): string | null {
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!url.pathname.startsWith("/api/")) return null;
    return typeof window !== "undefined" && url.origin === window.location.origin ? "" : url.origin;
  } catch {
    return null;
  }
}

if (typeof window !== "undefined") {
  const origFetch = window.fetch.bind(window);
  const isActive = (base: string) => base === canonicalBase(getActiveTargetBaseUrl());
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (isApiPath(input)) {
      if (tabHost.error) return Promise.reject(new HostConfigError(tabHost.error));
      const targetBase = getActiveTargetBaseUrl();
      const { init: authed, auto } = withAuth(init, targetBase);
      return origFetch(targetBase + input, authed).then((res) => {
        handleUnauthorized(res, targetBase, auto);
        return res;
      });
    }
    // Absolute URLs (lib/api.ts apiFetch for a remote host) and Request objects: only
    // the token stored for exactly the origin the request goes to — never another host's.
    if (typeof Request !== "undefined" && input instanceof Request) {
      const base = absoluteApiBase(input.url);
      if (base === null) return origFetch(input, init);
      const merged = new Request(input, init);
      let auto = false;
      let req = merged;
      const auth = authHeaderFor(base);
      if (auth && !merged.headers.has("authorization")) {
        const headers = new Headers(merged.headers);
        headers.set("Authorization", auth);
        req = new Request(merged, { headers, redirect: merged.redirect === "follow" ? "error" : merged.redirect });
        auto = true;
      }
      return origFetch(req).then((res) => {
        if (isActive(base)) handleUnauthorized(res, base, auto);
        return res;
      });
    }
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : null;
    const base = raw === null ? null : absoluteApiBase(raw);
    if (base !== null) {
      const { init: authed, auto } = withAuth(init, base);
      return origFetch(input, authed).then((res) => {
        // Only the active host prompts; a probe of another host (HostPicker test)
        // reports its own 401 instead of opening the global dialog.
        if (isActive(base)) handleUnauthorized(res, base, auto);
        return res;
      });
    }
    return origFetch(input, init);
  };

  const origBeacon = navigator.sendBeacon?.bind(navigator);
  if (origBeacon) {
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      if (!isApiPath(url)) return origBeacon(url, data);
      if (tabHost.error) return false;
      const targetBase = getActiveTargetBaseUrl();
      const auth = authHeaderFor(targetBase);
      if (auth) {
        // Beacons cannot carry headers; keepalive fetch survives unload the same way.
        void origFetch(targetBase + url, {
          method: "POST",
          body: data ?? null,
          keepalive: true,
          redirect: "error",
          headers: { Authorization: auth },
        }).catch(() => {});
        return true;
      }
      return origBeacon(targetBase + url, data);
    };
  }
}

/**
 * v0.6.10+ dashboard error reporter → `POST /api/debug-log` (tmp/dashboard-client.log).
 *
 * Mobile users without DevTools can read browser errors with `cat tmp/dashboard-client.log`.
 * Issue #19: the server only accepts entries when RAVEN_DEBUG_LOG=1 (404 otherwise, ignored).
 *
 * Issue #67: `/api` needs a Bearer token from this PC too, so entries go through the
 * authenticating `window.fetch` wrapper (lib/api-base.ts) — `sendBeacon` cannot carry
 * `Authorization`. The reporter captures that fetch *before* installing its own error
 * wrapper and never reports on `/api/debug-log` itself, so a refused or disabled
 * endpoint (404/401) cannot make it report its own failure in a loop.
 */

type Entry = {
  level: string;
  source: string;
  message: string;
  stack?: string;
  url?: string;
  vault?: string;
};

const DEBUG_LOG_PATH = "/api/debug-log";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

export function installClientDebugLog(win: Window & typeof globalThis): void {
  // The fetch this module sends with: the authenticating wrapper, never its own wrapper below.
  const send = win.fetch.bind(win);

  const post = (entry: Entry) => {
    try {
      // keepalive: still delivered while the page unloads.
      send(DEBUG_LOG_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // best-effort, silent
    }
  };

  const ctx = () => ({
    url: win.location?.href ?? "",
    vault: win.localStorage?.getItem("raven:active_vault") ?? "",
  });

  win.addEventListener("error", (e: ErrorEvent) => {
    post({
      level: "error",
      source: "window.error",
      message: e.message || String(e),
      stack: e.error && e.error.stack ? e.error.stack : "",
      ...ctx(),
    });
  });

  win.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const r: any = e.reason;
    post({
      level: "error",
      source: "unhandledrejection",
      message: r && r.message ? r.message : String(r),
      stack: r && r.stack ? r.stack : "",
      ...ctx(),
    });
  });

  // fetch throw 자동 catch (4xx/5xx도 포함) — the reporter's own endpoint excluded
  const inner = win.fetch.bind(win);
  win.fetch = async (...args: Parameters<typeof fetch>) => {
    const target = urlOf(args[0]);
    const own = target.includes(DEBUG_LOG_PATH);
    try {
      const res = await inner(...args);
      if (!own && !res.ok && res.status >= 400) {
        // eslint-disable-next-line no-console
        console.warn("[Raven-Debug] fetch non-ok:", res.status, target);
        post({ level: "warn", source: "fetch", message: `${res.status} ${res.statusText} ${target}`, ...ctx() });
      }
      return res;
    } catch (e: any) {
      if (!own) {
        // eslint-disable-next-line no-console
        console.warn("[Raven-Debug] fetch throw:", e?.message, target);
        post({ level: "error", source: "fetch", message: e?.message || String(e), stack: e?.stack || "", ...ctx() });
      }
      throw e; // 원래 throw 보존
    }
  };
}

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

// v0.7.175+: Tauri desktop mode — inject Core endpoint before React renders.
import { setApiBase } from "./lib/api-base";

// Detect Tauri webview and fetch the Python Core endpoint.
// Uses the internal invoke bridge (no @tauri-apps/api dependency needed).
// Retries with timeout to ensure Python Core readiness race condition is resolved.
async function initDesktopEndpoint(): Promise<void> {
  const tauriInternals = (window as any).__TAURI_INTERNALS__;
  if (!tauriInternals?.invoke) return;

  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const endpoint = await tauriInternals.invoke("core_endpoint");
      if (endpoint && typeof endpoint === "string" && endpoint.trim().length > 0) {
        setApiBase(endpoint.trim());
        return;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[Raven Desktop] Core endpoint query retry:", e);
    }
    await new Promise((res) => setTimeout(res, 200));
  }
}

const endpointReady: Promise<void> = initDesktopEndpoint().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[Raven Desktop] Failed to obtain core endpoint:", err);
});

// v0.6.10 (P16): PWA registerType="prompt" handler.
// v0.7.183: Tauri desktop mode bypasses PWA Service Worker to avoid cache locking issues.
import { registerSW } from "virtual:pwa-register";

if (!(window as any).__TAURI_INTERNALS__) {
  const updateSW = registerSW({
    onNeedRefresh() {
      if (
        window.confirm(
          "Raven에 새 버전이 있습니다. 지금 업데이트할까요?\n" +
            "(취소하면 다음 새로고침/앱 재실행 때 적용됩니다.)"
        )
      ) {
        updateSW(true);
      }
    },
    onOfflineReady() {
      // eslint-disable-next-line no-console
      console.info("[Raven] 오프라인 캐시 준비 완료 — 네트워크 없이도 동작합니다.");
    },
    onRegisterError(error: unknown) {
      // eslint-disable-next-line no-console
      console.warn("[Raven] SW 등록 오류:", error);
    },
  });
}

// ─── v0.6.10+ 개발 단계 throw/error catch (tmp/dashboard-client.log) ─────
// mobile DevTools 못 볼 때 사용자가 `cat tmp/dashboard-client.log`로 직접 진단.
// Issue #19: 서버가 RAVEN_DEBUG_LOG=1일 때만 받는다(아니면 404, 무시됨).
// ESbuild/Node 환경에서는 window 없음 → 가드.
if (typeof window !== "undefined") {
  const post = (entry: {
    level: string;
    source: string;
    message: string;
    stack?: string;
    url?: string;
    vault?: string;
  }) => {
    try {
      const body = JSON.stringify(entry);
      // sendBeacon 우선 (페이지 unload에도 안전), 미지원 시 fetch keepalive.
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon("/api/debug-log", blob);
      } else {
        fetch("/api/debug-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {
      // best-effort, silent
    }
  };

  const ctx = () => ({
    url: window.location?.href ?? "",
    vault: window.localStorage?.getItem("raven:active_vault") ?? "",
  });

  // unhandled error
  window.addEventListener("error", (e) => {
    post({
      level: "error",
      source: "window.error",
      message: e.message || String(e),
      stack: e.error && e.error.stack ? e.error.stack : "",
      ...ctx(),
    });
  });

  // unhandled promise rejection
  window.addEventListener("unhandledrejection", (e) => {
    const r: any = e.reason;
    post({
      level: "error",
      source: "unhandledrejection",
      message: r && r.message ? r.message : String(r),
      stack: r && r.stack ? r.stack : "",
      ...ctx(),
    });
  });

  // fetch throw 자동 catch (4xx/5xx도 포함)
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    try {
      const res = await origFetch(...args);
      if (!res.ok && res.status >= 400) {
        // eslint-disable-next-line no-console
        console.warn(
          "[Raven-Debug] fetch non-ok:",
          res.status,
          typeof args[0] === "string" ? args[0] : (args[0] as Request).url
        );
        post({
          level: "warn",
          source: "fetch",
          message: `${res.status} ${res.statusText} ${typeof args[0] === "string" ? args[0] : (args[0] as Request).url}`,
          ...ctx(),
        });
      }
      return res;
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn("[Raven-Debug] fetch throw:", e?.message, typeof args[0] === "string" ? args[0] : (args[0] as Request).url);
      post({
        level: "error",
        source: "fetch",
        message: e?.message || String(e),
        stack: e?.stack || "",
        ...ctx(),
      });
      throw e; // 원래 throw 보존
    }
  };
}

endpointReady.then(() => {
  document.getElementById("boot-loader")?.remove();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});

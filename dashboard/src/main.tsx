import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

// v0.7.175+: Tauri desktop mode — inject Core endpoint before React renders.
import { setApiBase } from "./lib/api-base";
import { canonicalBase, setSessionCredential, setSessionRefresher } from "./lib/host-auth";
import { installClientDebugLog } from "./lib/client-debug-log";

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
        // Issue #67: the Core API needs a Bearer token from loopback too. The running
        // Core's credential is kept in memory for this endpoint only; after a Core restart
        // the fetch wrapper asks the shell for the new one.
        const snapshot = async () => {
          const snap = await tauriInternals.invoke("core_session_token");
          return snap && typeof snap.endpoint === "string" && typeof snap.token === "string"
            ? { endpoint: snap.endpoint as string, token: snap.token as string }
            : null;
        };
        setSessionRefresher(snapshot);
        try {
          // endpoint and credential come from the same Core; take it only for this endpoint
          const snap = await snapshot();
          if (snap && canonicalBase(snap.endpoint) === canonicalBase(endpoint)) {
            setSessionCredential(endpoint.trim(), snap.token);
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("[Raven Desktop] no session credential; the token dialog will ask:", e);
        }
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
// Issue #19: 서버가 RAVEN_DEBUG_LOG=1일 때만 받는다(아니면 404, 무시됨). 구현: lib/client-debug-log.ts
if (typeof window !== "undefined") {
  installClientDebugLog(window);
}

endpointReady.then(() => {
  document.getElementById("boot-loader")?.remove();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});

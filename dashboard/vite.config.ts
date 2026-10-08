import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // v0.6.10 (P16): "autoUpdate" → "prompt".
      // - 이전: 새 SW 감지 시 page reload 강제 → 사용자가 앱 내렸다가 다시 켜면
      //   뜻하지 않게 페이지가 새로고침됨 ("쓸데없는 재로딩" 보고).
      // - 변경: 신 버전 발견 시 사용자에게 confirm → 승인 시에만 reload.
      //   onNeedRefresh handler는 main.tsx에서 등록 (vite-plugin-pwa virtual module).
      registerType: "prompt",
      // v0.6.9 (P14 fix): PWA 캐시로 인한 stale UI 봉인.
      // - navigateFallback: null → SPA 라우트가 캐시된 index.html로 fallback되지 않음
      // - /api/* NetworkFirst → API는 항상 네트워크 우선 (옛 JSON 봉인)
      workbox: {
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: /\/api\//,
            handler: "NetworkFirst",
            options: {
              cacheName: "api-cache",
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
      },
      manifest: {
        name: "Raven Dashboard",
        short_name: "Raven",
        theme_color: "#22d3ee",
        icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }],
      },
    }),
  ],
  server: {
    port: 5173,
    // RAVEN_DASHBOARD_HOST (repo-root .env, raven.sh가 source): 미설정 시 localhost만.
    host: process.env.RAVEN_DASHBOARD_HOST || "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
        // X-Forwarded-For로 실제 LAN 클라이언트 IP를 전달 — uvicorn은 127.0.0.1발 XFF만
        // 신뢰하므로, 이게 없으면 API는 프록시의 loopback 주소만 보고 LAN 요청을 loopback으로 오인한다.
        xfwd: true,
      },
    },
  },
  test: {
    globals: true,
    css: true,
    environment: "jsdom",
    // v0.7.102: vitest global setup — jsdom 한계 보완 (matchMedia/scrollTo stub).
    // v0.7.97 §6 Folder-hover-menu 회귀 가드 회복.
    setupFiles: ["./tests/setup.ts"],
  },
});

import { Suspense, useEffect, type ReactNode } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AuthTokenDialog } from "./components/AuthTokenDialog";
import { AppErrorBoundary, RouteErrorBoundary, lazyRoute } from "./components/RouteErrorBoundary";
import { installTabHostSync } from "./lib/tab-host-sync";
import { HostConfigGate } from "./components/HostConfigGate";

// ── 코드 스플리팅 (P1-a): 전 라우트 lazy ──
// force-graph(6.3MB)가 GraphPage 전용 청크로 분리되어 초기 번들 감소.
// Issue #1 A-1: lazyRoute = React.lazy + 청크 로딩 실패 후 "다시 시도" 시 재요청.
const HomePage = lazyRoute(() => import("./routes/HomePage").then((m) => ({ default: m.HomePage })));
const PageView = lazyRoute(() => import("./routes/PageView").then((m) => ({ default: m.PageView })));
const SearchPage = lazyRoute(() => import("./routes/SearchPage").then((m) => ({ default: m.SearchPage })));
const GraphPage = lazyRoute(() => import("./routes/GraphPage").then((m) => ({ default: m.GraphPage })));
const LogPage = lazyRoute(() => import("./routes/LogPage").then((m) => ({ default: m.LogPage })));
const LintPage = lazyRoute(() => import("./routes/LintPage").then((m) => ({ default: m.LintPage })));
const NewVaultPage = lazyRoute(() => import("./routes/NewVaultPage").then((m) => ({ default: m.NewVaultPage })));
const VaultManage = lazyRoute(() => import("./routes/VaultManage").then((m) => ({ default: m.VaultManage })));
const VaultPolicyPage = lazyRoute(() => import("./routes/VaultPolicyPage").then((m) => ({ default: m.VaultPolicyPage })));
const ArchivePage = lazyRoute(() => import("./routes/ArchivePage").then((m) => ({ default: m.ArchivePage })));
const GardenPage = lazyRoute(() => import("./routes/GardenPage").then((m) => ({ default: m.GardenPage })));
const RawPanel = lazyRoute(() => import("./routes/RawPanel").then((m) => ({ default: m.RawPanel })));
const WorkspacePage = lazyRoute(() => import("./routes/WorkspacePage").then((m) => ({ default: m.WorkspacePage })));

function RouteFallback() {
  return (
    <div style={{ padding: 40, textAlign: "center", color: "var(--color-muted)", fontSize: 14 }}>
      불러오는 중…
    </div>
  );
}

// Issue #1 A-1: 라우트 단위 ErrorBoundary — 렌더 오류·청크 실패를 Outlet 안에 가둬
// 사이드바·헤더를 남긴다. boundary가 Suspense 바깥이어야 lazy reject도 잡힌다.
function RouteSlot({ children }: { children: ReactNode }) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<RouteFallback />}>{children}</Suspense>
    </RouteErrorBoundary>
  );
}

export default function App() {
  // Issue #32: 다른 탭이 활성 호스트를 바꾸면 이 탭도 캐시를 비우고 "/"로 재로드한다.
  useEffect(() => installTabHostSync(), []);
  return (
    <BrowserRouter>
      {/* Issue #1 A-1: Layout 자체가 터져도 #root를 비우지 않는다 (셸 blank 복구 reload 방지) */}
      <AppErrorBoundary>
        {/* PR #35 review: 원격 호스트 설정이 깨졌으면 앱(요청) 대신 설정 오류 — 로컬로 조용히 보내지 않는다 */}
        <HostConfigGate>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<RouteSlot><HomePage /></RouteSlot>} />
              <Route path="/page/:vault/*" element={<RouteSlot><PageView /></RouteSlot>} />
              <Route path="/search" element={<RouteSlot><SearchPage /></RouteSlot>} />
              <Route path="/graph" element={<RouteSlot><GraphPage /></RouteSlot>} />
              <Route path="/log" element={<RouteSlot><LogPage /></RouteSlot>} />
              <Route path="/lint" element={<RouteSlot><LintPage /></RouteSlot>} />
              <Route path="/garden" element={<RouteSlot><GardenPage /></RouteSlot>} />
              <Route path="/workspace" element={<RouteSlot><WorkspacePage /></RouteSlot>} />
              <Route path="/vault/new" element={<RouteSlot><NewVaultPage /></RouteSlot>} />
              <Route path="/vault/manage" element={<RouteSlot><VaultManage /></RouteSlot>} />
              <Route path="/vault/policy/:vault" element={<RouteSlot><VaultPolicyPage /></RouteSlot>} />
              <Route path="/archive" element={<RouteSlot><ArchivePage /></RouteSlot>} />
              {/* v0.7.50+: raw/ folder panel */}
              <Route path="/raw/:vault/*" element={<RouteSlot><RawPanel /></RouteSlot>} />
            </Route>
          </Routes>
        </HostConfigGate>
      </AppErrorBoundary>
      {/* Issue #24: gate 401 from a remote/tailnet host → token prompt */}
      <AuthTokenDialog />
    </BrowserRouter>
  );
}

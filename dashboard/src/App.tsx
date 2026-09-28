import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";

// ── 코드 스플리팅 (P1-a): 전 라우트 lazy ──
// force-graph(6.3MB)가 GraphPage 전용 청크로 분리되어 초기 번들 감소.
const HomePage = lazy(() => import("./routes/HomePage").then((m) => ({ default: m.HomePage })));
const PageView = lazy(() => import("./routes/PageView").then((m) => ({ default: m.PageView })));
const SearchPage = lazy(() => import("./routes/SearchPage").then((m) => ({ default: m.SearchPage })));
const GraphPage = lazy(() => import("./routes/GraphPage").then((m) => ({ default: m.GraphPage })));
const LogPage = lazy(() => import("./routes/LogPage").then((m) => ({ default: m.LogPage })));
const LintPage = lazy(() => import("./routes/LintPage").then((m) => ({ default: m.LintPage })));
const NewVaultPage = lazy(() => import("./routes/NewVaultPage").then((m) => ({ default: m.NewVaultPage })));
const VaultManage = lazy(() => import("./routes/VaultManage").then((m) => ({ default: m.VaultManage })));
const VaultPolicyPage = lazy(() => import("./routes/VaultPolicyPage").then((m) => ({ default: m.VaultPolicyPage })));
const ArchivePage = lazy(() => import("./routes/ArchivePage").then((m) => ({ default: m.ArchivePage })));
const GardenPage = lazy(() => import("./routes/GardenPage").then((m) => ({ default: m.GardenPage })));
const RawPanel = lazy(() => import("./routes/RawPanel").then((m) => ({ default: m.RawPanel })));
const WorkspacePage = lazy(() => import("./routes/WorkspacePage").then((m) => ({ default: m.WorkspacePage })));

function RouteFallback() {
  return (
    <div style={{ padding: 40, textAlign: "center", color: "var(--color-muted)", fontSize: 14 }}>
      불러오는 중…
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Suspense fallback={<RouteFallback />}><HomePage /></Suspense>} />
          <Route path="/page/:vault/*" element={<Suspense fallback={<RouteFallback />}><PageView /></Suspense>} />
          <Route path="/search" element={<Suspense fallback={<RouteFallback />}><SearchPage /></Suspense>} />
          <Route path="/graph" element={<Suspense fallback={<RouteFallback />}><GraphPage /></Suspense>} />
          <Route path="/log" element={<Suspense fallback={<RouteFallback />}><LogPage /></Suspense>} />
          <Route path="/lint" element={<Suspense fallback={<RouteFallback />}><LintPage /></Suspense>} />
          <Route path="/garden" element={<Suspense fallback={<RouteFallback />}><GardenPage /></Suspense>} />
          <Route path="/workspace" element={<Suspense fallback={<RouteFallback />}><WorkspacePage /></Suspense>} />
          <Route path="/vault/new" element={<Suspense fallback={<RouteFallback />}><NewVaultPage /></Suspense>} />
          <Route path="/vault/manage" element={<Suspense fallback={<RouteFallback />}><VaultManage /></Suspense>} />
          <Route path="/vault/policy/:vault" element={<Suspense fallback={<RouteFallback />}><VaultPolicyPage /></Suspense>} />
          <Route path="/archive" element={<Suspense fallback={<RouteFallback />}><ArchivePage /></Suspense>} />
          {/* v0.7.50+: raw/ folder panel */}
          <Route path="/raw/:vault/*" element={<Suspense fallback={<RouteFallback />}><RawPanel /></Suspense>} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

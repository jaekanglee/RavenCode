// Issue #1 A-1 — 렌더 오류·lazy 청크 로딩 실패를 화면 단위로 가둔다.
//
// ErrorBoundary가 없으면 하위 라우트의 throw가 루트까지 올라가 React가 #root를 비운다.
// 데스크톱 셸(lib.rs RECOVER_IF_BLANK_JS)은 #root가 비면 location.reload()를 하므로
// 번들이 깨진 상태에서는 포커스마다 reload → crash → blank가 반복될 수 있다.
// 여기서는 오류 화면을 그려 #root를 비우지 않고, 복구는 사용자의 "다시 시도"로만 한다
// (자동 재시도·자동 새로고침 없음 → 반복 루프 없음).
//
//  - RouteErrorBoundary: Layout의 Outlet 안. 사이드바·헤더는 남고, 화면 이동 시 초기화.
//  - AppErrorBoundary: 최상위. Layout 자체가 터져도 빈 화면 대신 복구 UI.
//  - lazyRoute: React.lazy는 한 번 reject된 import를 영구 캐시하므로, 사용자 재시도 뒤에는
//    새 lazy로 import를 다시 부른다. 단 브라우저가 실패한 모듈 URL을 캐시하면(Chrome) 재요청이
//    나가지 않으므로, 청크 실패에는 사용자가 누르는 "앱 다시 불러오기"를 함께 둔다.
//    데스크톱(Tauri WKWebView)은 실패한 모듈 URL을 새로고침 뒤에도 같은 프로세스 안에서 기억하므로
//    (PR #33 실측: fetch 200, 같은 URL import 실패, ?x=1 import 성공) 청크 실패에는 버튼 없이 앱 재실행을 안내한다.
import { Component, lazy, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { EmptyState } from "./ui/EmptyState";
import { Button } from "./ui/Button";
import { EmptyIcon } from "../lib/emptyIcons";

/** 동적 import(청크) 로딩 실패인가 — 브라우저마다 문구가 다르다. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk .* failed/i.test(
    msg,
  );
}

interface BoundaryProps {
  /** 값이 바뀌면 오류 상태를 해제한다 (화면 이동). */
  resetKey?: unknown;
  fallback: (error: unknown, retry: () => void) => ReactNode;
  children: ReactNode;
}

interface BoundaryState {
  error: unknown;
  hasError: boolean;
  resetKey: unknown;
}

class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, hasError: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error, hasError: true };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      if (state.hasError) requestRetry();
      return { resetKey: props.resetKey, error: null, hasError: false };
    }
    return null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[Raven] 화면 렌더 오류:", error, info.componentStack);
  }

  retry = () => {
    requestRetry();
    this.setState({ error: null, hasError: false });
  };

  render() {
    if (this.state.hasError) return this.props.fallback(this.state.error, this.retry);
    return this.props.children;
  }
}

/** 데스크톱 셸(Tauri) 안인가 — 렌더 시점에 판단한다. */
function isDesktopShell(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

function describe(error: unknown, desktop: boolean): { title: string; description: string } {
  if (isChunkLoadError(error)) {
    return {
      title: "화면 파일을 불러오지 못했습니다",
      description: desktop
        ? "앱 파일을 읽는 중 문제가 생겼습니다. 다른 화면은 계속 사용할 수 있습니다. 이 화면이 계속 열리지 않으면 앱을 종료한 뒤 다시 실행하세요."
        : "네트워크가 불안정하거나 앱이 방금 업데이트되었을 수 있습니다. 앱을 다시 불러오거나 다른 화면으로 이동하세요.",
    };
  }
  return {
    title: "이 화면을 표시하지 못했습니다",
    description: "다른 메뉴는 계속 사용할 수 있습니다. 다시 시도하거나 다른 화면으로 이동하세요.",
  };
}

function ErrorFallback({ error, retry }: { error: unknown; retry: () => void }) {
  const chunk = isChunkLoadError(error);
  const desktop = isDesktopShell();
  // 데스크톱 청크 실패는 같은 프로세스 안에서 어떤 버튼으로도 복구되지 않는다(WKWebView 실측:
  // 다시 시도해도 재요청이 나가지 않고, 새로고침 뒤에도 실패) — 버튼 없이 앱 재실행만 안내한다.
  const recoverable = !(chunk && desktop);
  return (
    <div role="alert">
      <EmptyState
        icon={<EmptyIcon.AlertTriangle />}
        {...describe(error, desktop)}
        action={
          recoverable ? (
            <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
              <Button variant={chunk ? "secondary" : "primary"} onClick={retry}>
                다시 시도
              </Button>
              {/* Chrome은 실패한 동적 import를 같은 URL로 다시 요청하지 않는다(실측, Chrome 154) —
                  청크 실패의 실제 복구는 새로고침. 자동이 아니라 사용자가 누를 때만. */}
              {chunk && (
                <Button variant="primary" onClick={() => window.location.reload()}>
                  앱 다시 불러오기
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

/** 라우트 단위 boundary — Layout의 Outlet 안에서 쓴다. 화면 이동(location.key)마다 초기화. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.key} fallback={(error, retry) => <ErrorFallback error={error} retry={retry} />}>
      {children}
    </ErrorBoundary>
  );
}

/** 최상위 boundary — Router 밖에서도 동작한다(초기화는 "다시 시도"로만). */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={(error, retry) => (
        <div style={{ maxWidth: 640, margin: "0 auto", padding: "64px 24px" }}>
          <ErrorFallback error={error} retry={retry} />
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

// 사용자 재시도(다시 시도 · 화면 이동) 회차. 실패한 lazy는 회차가 바뀐 뒤에만 새로 만든다.
// 실패 즉시 갈아 끼우면 React가 오류 직후 하는 자동 재렌더가 새 import를 시작해,
// 사용자 조작 없이 import가 반복된다 (RED에서 클릭 0회에 5회 시도로 확인).
let retryEpoch = 0;
function requestRetry() {
  retryEpoch += 1;
}

/** React.lazy + 재시도 가능. reject된 import는 사용자 재시도 뒤 첫 렌더에서만 다시 요청한다. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyRoute(load: () => Promise<{ default: ComponentType<any> }>): ComponentType {
  let failedAt: number | null = null;
  const make = () =>
    lazy(() =>
      load().catch((err) => {
        failedAt = retryEpoch;
        throw err;
      }),
    );
  let Lazy = make();
  return function LazyRoute() {
    if (failedAt !== null && failedAt !== retryEpoch) {
      failedAt = null;
      Lazy = make();
    }
    return <Lazy />;
  };
}

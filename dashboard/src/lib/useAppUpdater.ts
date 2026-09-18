// useAppUpdater — 데스크톱 앱 업데이트 전 과정(확인 → 다운로드 → 설치 → 재시작)의 상태 기계.
//
// v0.7.183+: 기존에는 UpdateChecker 토스트와 VaultManage 관리 화면이 각자
// `check()` → `downloadAndInstall()`을 직접 호출했다. 문제 2가지:
//  1. 진행률 콜백을 안 써서 "업데이트 실행"을 눌러도 UI가 수십 초간 무반응
//     (수십 MB 다운로드가 끝날 때까지 버튼만 disabled).
//  2. 설치 직전에 check()를 한 번 더 호출 — 확인 단계에서 얻은 handle을 버림.
//
// 이 훅이 handle을 붙들고 DownloadEvent(Started/Progress/Finished)를 받아
// phase + 진행률(bytes/percent/속도/ETA)을 노출한다. 브라우저/Docker 모드에서는
// __TAURI_INTERNALS__가 없어 desktop=false로 떨어지고 아무 것도 하지 않는다.
import { useCallback, useEffect, useRef, useState } from "react";

export type UpdatePhase =
  | "idle"        // 아직 확인 안 함
  | "checking"    // 서버에 최신 버전 질의 중
  | "uptodate"    // 확인 완료 — 최신
  | "available"   // 새 버전 있음 (사용자 액션 대기)
  | "downloading" // 패키지 내려받는 중 (진행률 있음)
  | "installing"  // 내려받기 완료, 설치 중
  | "relaunching" // 설치 완료, 앱 재시작 중
  | "error";

/** tauri-plugin-updater의 download 이벤트와 동일 shape (테스트에서 직접 만들 수 있게 재선언). */
export type UpdateDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface UpdateHandle {
  version: string;
  currentVersion?: string;
  body?: string;
  downloadAndInstall: (onEvent?: (e: UpdateDownloadEvent) => void) => Promise<void>;
}

export interface UpdaterBackend {
  check: () => Promise<UpdateHandle | null>;
  relaunch: () => Promise<void>;
}

export interface UpdateProgressState {
  /** 지금까지 받은 바이트. */
  downloaded: number;
  /** 전체 바이트. 서버가 Content-Length를 안 주면 null(= 불확정 진행률). */
  total: number | null;
  /** 0~100. total을 모르면 null. */
  percent: number | null;
  /** 평균 전송 속도(B/s). 표본이 부족하면 null. */
  bytesPerSec: number | null;
  /** 남은 시간(초). 계산 불가면 null. */
  etaSec: number | null;
}

const EMPTY_PROGRESS: UpdateProgressState = {
  downloaded: 0,
  total: null,
  percent: null,
  bytesPerSec: null,
  etaSec: null,
};

export interface UseAppUpdaterOptions {
  /** 테스트 주입용. 미지정 시 @tauri-apps/plugin-{updater,process}를 동적 import. */
  backend?: () => Promise<UpdaterBackend>;
  /** 미지정 시 window.__TAURI_INTERNALS__ 존재 여부로 판단. */
  desktop?: boolean;
  /** 마운트 직후 1회 자동 확인 (토스트용). 관리 화면은 false. */
  autoCheck?: boolean;
  /**
   * 진행률 state 반영 최소 간격(ms). Progress 이벤트는 청크마다 오므로
   * 그대로 setState하면 초당 수백 번 리렌더된다. 0이면 매 이벤트 반영(테스트).
   */
  progressThrottleMs?: number;
}

export interface AppUpdaterState {
  desktop: boolean;
  phase: UpdatePhase;
  /** 새 버전 문자열 (available 이후). */
  version: string | null;
  /** 릴리스 노트. */
  notes: string | null;
  progress: UpdateProgressState;
  error: string | null;
  /** 진행 중(사용자 입력을 막아야 하는) 상태인가. */
  busy: boolean;
  check: () => Promise<void>;
  install: () => Promise<void>;
  /** available/uptodate/error 표시를 닫고 idle로. 진행 중에는 무시. */
  dismiss: () => void;
}

function defaultIsDesktop(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

async function defaultBackend(): Promise<UpdaterBackend> {
  const [{ check }, { relaunch }] = await Promise.all([
    import("@tauri-apps/plugin-updater"),
    import("@tauri-apps/plugin-process"),
  ]);
  return { check: () => check(), relaunch };
}

function toMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

export function useAppUpdater(options: UseAppUpdaterOptions = {}): AppUpdaterState {
  const {
    backend = defaultBackend,
    desktop = defaultIsDesktop(),
    autoCheck = false,
    progressThrottleMs = 80,
  } = options;

  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [progress, setProgress] = useState<UpdateProgressState>(EMPTY_PROGRESS);
  const [error, setError] = useState<string | null>(null);

  // 확인 단계에서 얻은 handle을 설치까지 들고 간다 (check 중복 호출 제거).
  const handleRef = useRef<UpdateHandle | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const check = useCallback(async () => {
    if (!desktop) return;
    setPhase("checking");
    setError(null);
    setProgress(EMPTY_PROGRESS);
    try {
      const api = await backend();
      const found = await api.check();
      if (!aliveRef.current) return;
      handleRef.current = found;
      if (found) {
        setVersion(found.version);
        setNotes(found.body ?? null);
        setPhase("available");
      } else {
        setVersion(null);
        setNotes(null);
        setPhase("uptodate");
      }
    } catch (e) {
      if (!aliveRef.current) return;
      setError(toMessage(e));
      setPhase("error");
    }
  }, [backend, desktop]);

  const install = useCallback(async () => {
    if (!desktop) return;
    setError(null);
    setPhase("downloading");
    setProgress({ ...EMPTY_PROGRESS });

    // 이벤트 누적은 ref에, state 반영은 throttle — 청크마다 리렌더 방지.
    let downloaded = 0;
    let total: number | null = null;
    let startedAt = Date.now();
    let lastPush = 0;

    const pushProgress = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastPush < progressThrottleMs) return;
      lastPush = now;
      const elapsedSec = Math.max((now - startedAt) / 1000, 0.001);
      const bytesPerSec = downloaded > 0 ? downloaded / elapsedSec : null;
      const percent = total && total > 0 ? Math.min(100, (downloaded / total) * 100) : null;
      const etaSec =
        total && bytesPerSec && bytesPerSec > 0
          ? Math.max(0, (total - downloaded) / bytesPerSec)
          : null;
      if (!aliveRef.current) return;
      setProgress({ downloaded, total, percent, bytesPerSec, etaSec });
    };

    try {
      const api = await backend();
      // 확인 단계의 handle 재사용. 없으면(토스트를 닫았다 다시 연 경우 등) 새로 확인.
      const target = handleRef.current ?? (await api.check());
      if (!target) {
        if (!aliveRef.current) return;
        handleRef.current = null;
        setPhase("uptodate");
        return;
      }
      handleRef.current = target;
      if (aliveRef.current) setVersion(target.version);

      await target.downloadAndInstall((e) => {
        if (e.event === "Started") {
          startedAt = Date.now();
          total = typeof e.data.contentLength === "number" && e.data.contentLength > 0
            ? e.data.contentLength
            : null;
          pushProgress(true);
        } else if (e.event === "Progress") {
          downloaded += e.data.chunkLength;
          pushProgress(false);
        } else {
          if (total && downloaded > total) total = downloaded;
          if (total === null) total = downloaded || null;
          downloaded = total ?? downloaded;
          pushProgress(true);
          if (aliveRef.current) setPhase("installing");
        }
      });

      if (!aliveRef.current) return;
      setPhase("relaunching");
      await api.relaunch();
    } catch (e) {
      if (!aliveRef.current) return;
      setError(toMessage(e));
      setPhase("error");
    }
  }, [backend, desktop, progressThrottleMs]);

  const dismiss = useCallback(() => {
    setPhase((current) =>
      current === "downloading" || current === "installing" || current === "relaunching"
        ? current
        : "idle"
    );
  }, []);

  // autoCheck는 마운트당 1회만. 호출부가 options 객체를 매 렌더 새로 만들어도
  // check identity 변화로 재확인이 반복되지 않게 ref로 잠근다.
  const autoCheckedRef = useRef(false);
  useEffect(() => {
    if (!desktop || !autoCheck || autoCheckedRef.current) return;
    autoCheckedRef.current = true;
    void check();
  }, [autoCheck, check, desktop]);

  const busy =
    phase === "checking" ||
    phase === "downloading" ||
    phase === "installing" ||
    phase === "relaunching";

  return { desktop, phase, version, notes, progress, error, busy, check, install, dismiss };
}

// ── 표시용 포맷터 (UpdatePanel / 테스트 공용) ──

export function formatUpdateBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatUpdateEta(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec)) return null;
  if (sec < 1) return "곧 완료";
  if (sec < 60) return `약 ${Math.ceil(sec)}초 남음`;
  const min = Math.floor(sec / 60);
  const rest = Math.ceil(sec % 60);
  return rest ? `약 ${min}분 ${rest}초 남음` : `약 ${min}분 남음`;
}

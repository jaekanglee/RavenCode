// UpdatePanel — 업데이트 진행 상황 시각화 (v0.7.183+).
//
// "업데이트 실행을 눌러도 UI가 반응하지 않는다"는 보고의 해결부.
// useAppUpdater의 phase/진행률을 받아 ① 상태 헤더 ② 진행률 바
// ③ 바이트·속도·ETA ④ 3단계 레일(다운로드→설치→재시작)로 그린다.
//
// 두 사용처(우하단 토스트 UpdateChecker / 관리 화면 VaultManage)가 같은
// 몸통을 공유하고, 감싸는 박스와 "나중에" 버튼만 각자 다르다.
import { Button } from "./ui/Button";
import { ProgressBar } from "./ui/ProgressBar";
import {
  formatUpdateBytes,
  formatUpdateEta,
  type AppUpdaterState,
  type UpdatePhase,
} from "../lib/useAppUpdater";

const STEPS: { key: string; label: string; phases: UpdatePhase[] }[] = [
  { key: "download", label: "다운로드", phases: ["downloading"] },
  { key: "install", label: "설치", phases: ["installing"] },
  { key: "relaunch", label: "재시작", phases: ["relaunching"] },
];

const PHASE_ORDER: UpdatePhase[] = ["downloading", "installing", "relaunching"];

const PHASE_TEXT: Record<UpdatePhase, { icon: string; title: string; hint?: string }> = {
  idle: { icon: "", title: "" },
  checking: { icon: "⟳", title: "업데이트 확인 중…", hint: "릴리스 서버에 최신 버전을 묻고 있습니다." },
  uptodate: { icon: "✓", title: "최신 버전을 사용 중입니다" },
  available: { icon: "↑", title: "새 버전을 설치할 수 있습니다" },
  downloading: { icon: "⟳", title: "새 버전 내려받는 중…", hint: "다운로드가 끝나면 자동으로 설치까지 진행됩니다." },
  installing: { icon: "⟳", title: "설치하는 중…", hint: "잠시만 기다려 주세요. 앱을 닫지 마세요." },
  relaunching: { icon: "⟳", title: "앱을 다시 시작하는 중…", hint: "곧 새 버전으로 창이 다시 열립니다." },
  error: { icon: "!", title: "업데이트에 실패했습니다" },
};

function isRunning(phase: UpdatePhase): boolean {
  return PHASE_ORDER.includes(phase);
}

/** 진행 중 단계 레일 — 완료(●) / 진행(◍ 펄스) / 대기(○). */
function StepRail({ phase }: { phase: UpdatePhase }) {
  const activeIndex = PHASE_ORDER.indexOf(phase);
  return (
    <ol className="update-steps" aria-label="업데이트 단계">
      {STEPS.map((step, i) => {
        const state = i < activeIndex ? "done" : i === activeIndex ? "active" : "pending";
        return (
          <li key={step.key} className={`update-step update-step--${state}`}>
            <span className="update-step-dot" aria-hidden="true" />
            <span className="update-step-label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export interface UpdatePanelProps {
  state: AppUpdaterState;
  /** 현재 설치된 버전 (있으면 "v0.2.0 → v0.2.1" 표기). */
  currentVersion?: string | null;
  /** "나중에" 버튼 — 토스트에서만 노출. */
  onDismiss?: () => void;
}

export function UpdatePanel({ state, currentVersion, onDismiss }: UpdatePanelProps) {
  const { phase, version, notes, progress, error } = state;
  // 아직 확인 전이면 아무 것도 그리지 않는다 ("업데이트 확인" 버튼은 호출부 소유).
  if (phase === "idle") return null;

  const text = PHASE_TEXT[phase];
  const running = isRunning(phase);
  const spinning = phase === "checking" || running;

  // 다운로드 중에만 실제 비율. 확인/설치/재시작은 끝을 알 수 없으므로 불확정 애니메이션.
  const barValue = phase === "downloading" ? progress.percent : null;
  const showBar = phase === "checking" || running;

  const eta = formatUpdateEta(progress.etaSec);
  const speed = progress.bytesPerSec ? `${formatUpdateBytes(progress.bytesPerSec)}/s` : null;
  const meta =
    phase === "downloading"
      ? [
          progress.total
            ? `${formatUpdateBytes(progress.downloaded)} / ${formatUpdateBytes(progress.total)}`
            : formatUpdateBytes(progress.downloaded),
          speed,
          eta,
        ].filter(Boolean).join(" · ")
      : null;

  const toneClass =
    phase === "error" ? "update-panel--error" : phase === "uptodate" ? "update-panel--ok" : "update-panel--info";

  return (
    <div className={`update-panel ${toneClass}`} aria-live="polite">
      <div className="update-panel-head">
        <span className={spinning ? "update-panel-icon update-panel-icon--spin" : "update-panel-icon"} aria-hidden="true">
          {text.icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="update-panel-title">{text.title}</div>
          {text.hint && phase !== "available" && <div className="update-panel-hint">{text.hint}</div>}
        </div>
        {version && phase !== "uptodate" && (
          <span className="update-version-chip">
            {currentVersion ? `v${currentVersion} → ` : ""}
            <strong>v{version}</strong>
          </span>
        )}
        {phase === "uptodate" && currentVersion && (
          <span className="update-version-chip">v{currentVersion}</span>
        )}
      </div>

      {showBar && (
        <div className="update-panel-progress">
          <ProgressBar
            value={barValue}
            label={phase === "checking" ? "업데이트 확인 중" : "업데이트 진행률"}
          />
          <div className="update-panel-progress-row">
            <span className="update-panel-meta">{meta ?? (phase === "checking" ? "" : "진행 중…")}</span>
            {phase === "downloading" && progress.percent !== null && (
              <span className="update-panel-percent">{Math.round(progress.percent)}%</span>
            )}
          </div>
        </div>
      )}

      {running && <StepRail phase={phase} />}

      {phase === "available" && notes && <pre className="update-panel-notes">{notes}</pre>}

      {phase === "error" && error && <div className="update-panel-error">{error}</div>}

      {(phase === "available" || phase === "error") && (
        <div className="update-panel-actions">
          {phase === "available" && (
            <Button variant="pillPrimary" size="sm" onClick={() => void state.install()}>
              지금 업데이트 및 재실행
            </Button>
          )}
          {phase === "error" && (
            <Button variant="pillPrimary" size="sm" onClick={() => void state.check()}>
              다시 시도
            </Button>
          )}
          {onDismiss && (
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              나중에
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

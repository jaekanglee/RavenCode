// ProgressBar — 앱 공통 진행률 바 (v0.7.183+).
//
// 사용자 원칙 (§13.1 재사용 컴포넌트 우선 / §13.2 색은 CSS 변수).
// 색·애니메이션은 globals.css의 .progress-bar-* 클래스가 소유하고,
// 이 컴포넌트는 값 → 폭(%) 매핑과 a11y 속성만 담당한다.
//
// value=null → 불확정(indeterminate) 모드. 총량을 모르는 다운로드나
// "확인 중"처럼 끝을 알 수 없는 단계에 사용.
export interface ProgressBarProps {
  /** 0~100. null이면 불확정 애니메이션. */
  value: number | null;
  /** 스크린리더용 설명. */
  label: string;
  tone?: "primary" | "success" | "danger";
  height?: number;
}

export function ProgressBar({ value, label, tone = "primary", height = 8 }: ProgressBarProps) {
  const indeterminate = value === null;
  const clamped = indeterminate ? 0 : Math.max(0, Math.min(100, value));

  return (
    <div
      className="progress-bar-track"
      style={{ height }}
      role="progressbar"
      aria-label={label}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
      aria-valuetext={indeterminate ? "진행 중" : `${Math.round(clamped)}%`}
    >
      <div
        className={
          indeterminate
            ? `progress-bar-fill progress-bar-fill--${tone} progress-bar-fill--indeterminate`
            : `progress-bar-fill progress-bar-fill--${tone}`
        }
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </div>
  );
}

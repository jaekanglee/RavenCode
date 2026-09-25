// TextField — 앱 공통 텍스트 입력 (v0.6.20+).
//
// 사용자 원칙 (2026-06-29): "텍스트 라벨이던 버튼이던 가급적 재사용할 수 있게
// 모두 컴포넌트화". 인라인 <label><span/><input/></label> 반복 제거.
//
// Contract:
//  - label: 필드 위에 표시되는 라벨
//  - required: true면 라벨 옆에 * 표시
//  - hideLabel: true면 라벨을 화면에서 숨기고 스크린리더에만 남긴다 (툴바 검색창 등)
//  - helper: 입력 아래 회색 도움말
//  - error: 입력 아래 빨간 에러 (있으면 helper 대신 표시)
//  - multiline: true면 textarea, 아니면 input
//  - 나머지 props (value, onChange, placeholder, autoFocus, onKeyDown,
//    ref...)는 그대로 위임 — native input/textarea attrs와 1:1 매핑.
//
// 스타일: globals.css의 .input-base를 재사용 — Carbon 시그니처(bottom-border)
//         유지하면서 좌우 패딩 14px 보장 (가독성).
import { forwardRef, useId } from "react";

export interface TextFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label: string;
  helper?: string;
  error?: string | null;
  required?: boolean;
  hideLabel?: boolean;
  /** true면 textarea, 아니면 input. textarea일 때 textarea attrs도 위임됨. */
  multiline?: boolean;
  rows?: number;
}

export const TextField = forwardRef<HTMLInputElement | HTMLTextAreaElement, TextFieldProps>(
  function TextField(
    {
      label,
      helper,
      error,
      required,
      hideLabel,
      multiline,
      rows = 4,
      id,
      className,
      ...rest
    },
    ref
  ) {
    const generatedId = useId();
    const fieldId = id || generatedId;

    const labelStyle: React.CSSProperties = {
      display: "block",
      marginBottom: hideLabel ? 0 : 16,
    };
    const labelTextStyle: React.CSSProperties = {
      display: "block",
      fontSize: 13,
      fontWeight: 500,
      marginBottom: 6,
      color: "var(--color-ink)",
    };
    const helperStyle: React.CSSProperties = {
      display: "block",
      fontSize: 12,
      color: error ? "var(--color-error-text)" : "var(--color-muted)",
      marginTop: 4,
    };

    const inputBaseClass = "input-base";

    return (
      <label htmlFor={fieldId} style={labelStyle}>
        <span style={labelTextStyle} className={hideLabel ? "sr-only" : undefined}>
          {label}
          {required && " *"}
        </span>
        {multiline ? (
          <textarea
            id={fieldId}
            ref={ref as React.Ref<HTMLTextAreaElement>}
            className={className || inputBaseClass}
            rows={rows}
            {...(rest as Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "ref">)}
          />
        ) : (
          <input
            id={fieldId}
            ref={ref as React.Ref<HTMLInputElement>}
            className={className || inputBaseClass}
            {...rest}
          />
        )}
        {(error || helper) && (
          <span style={helperStyle}>{error || helper}</span>
        )}
      </label>
    );
  }
);
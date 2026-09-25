// FilterChip — 켜고 끄는 필터 칩 (그래프 타입 범례·관계 필터 등).
//
// Contract:
//  - label / count: 칩 텍스트와 오른쪽 개수
//  - active: 눌린 상태 (aria-pressed)
//  - dotColor: 왼쪽 색 점 — CSS 색 값 또는 var(--token)
//  - 나머지 button attrs(onClick, title...)는 그대로 위임
//
// 스타일: globals.css의 .filter-chip
export interface FilterChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  count?: number;
  active: boolean;
  dotColor?: string;
}

export function FilterChip({ label, count, active, dotColor, className, ...rest }: FilterChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`filter-chip${active ? " active" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {dotColor && <span className="filter-chip-dot" style={{ background: dotColor }} aria-hidden="true" />}
      <span>{label}</span>
      {typeof count === "number" && <span className="filter-chip-count">{count}</span>}
    </button>
  );
}

// FindBackdrop — 편집 모드 문서 내 찾기 강조 레이어.
//
// textarea 안의 글자에는 배경을 칠할 수 없고, WebKit은 포커스가 없는 textarea의
// 선택 영역을 그리지 않는다 (찾기 막대가 포커스를 가진 상태). 그래서 textarea 뒤에
// 같은 글꼴·패딩·줄바꿈 규칙을 가진 div를 깔고, 글자는 투명하게, 일치 구간만
// <mark> 배경으로 보이게 한다. 스크롤 위치는 부모가 textarea와 맞춘다.
import { forwardRef } from "react";
import type { Match } from "../lib/findInText";

export interface FindBackdropProps {
  text: string;
  matches: Match[];
  /** 0-based 현재 항목, 없으면 -1 */
  current: number;
  style?: React.CSSProperties;
}

export const FindBackdrop = forwardRef<HTMLDivElement, FindBackdropProps>(function FindBackdrop(
  { text, matches, current, style },
  ref,
) {
  const parts: React.ReactNode[] = [];
  let pos = 0;
  matches.forEach(([start, end], i) => {
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(
      <mark key={i} className={i === current ? "find-mark find-mark-current" : "find-mark"}>
        {text.slice(start, end)}
      </mark>,
    );
    pos = end;
  });
  // 끝 줄바꿈: textarea는 마지막 빈 줄도 높이를 갖는다 — 스크롤 높이를 맞춘다.
  parts.push(text.slice(pos) + "\n");

  return (
    <div ref={ref} aria-hidden="true" className="find-backdrop" style={style}>
      {parts}
    </div>
  );
});

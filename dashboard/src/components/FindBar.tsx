// FindBar — 문서 내 찾기 막대 (Cmd/Ctrl+F).
//
// 상태는 부모(InlineMarkdownEditor)가 갖고, 이 컴포넌트는 표시와 키 입력만 담당한다.
// Enter = 다음, Shift+Enter = 이전, Esc = 닫기. Esc는 전파를 막는다 —
// 편집 모드의 document Esc 핸들러가 편집을 취소해버리지 않도록.
import { useEffect, useRef } from "react";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";

export interface FindBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  /** 0-based 현재 항목. 일치가 없으면 -1. */
  current: number;
  total: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** 값이 바뀔 때마다 입력에 포커스 + 전체 선택 (Cmd+F 재입력). */
  focusSignal: number;
}

export function FindBar({ query, onQueryChange, current, total, onNext, onPrev, onClose, focusSignal }: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  const noMatch = query !== "" && total === 0;

  return (
    <div className="find-bar" role="search">
      <TextField
        ref={inputRef}
        label="문서 내 찾기"
        hideLabel
        className="input-base find-bar-input"
        placeholder="문서에서 찾기"
        value={query}
        aria-invalid={noMatch}
        onChange={(e) => onQueryChange((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="find-bar-count" aria-live="polite">
        {total > 0 ? `${current + 1}/${total}` : "0/0"}
      </span>
      <Button variant="ghost" size="sm" aria-label="이전 결과" disabled={total === 0} onClick={onPrev}>
        ↑
      </Button>
      <Button variant="ghost" size="sm" aria-label="다음 결과" disabled={total === 0} onClick={onNext}>
        ↓
      </Button>
      <Button variant="ghost" size="sm" aria-label="찾기 닫기" onClick={onClose}>
        ✕
      </Button>
    </div>
  );
}

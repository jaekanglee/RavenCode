// findInText — 문서 내 찾기의 순수 매칭 로직 (Cmd/Ctrl+F).
//
// 대소문자 무시, 겹치지 않는 부분 문자열 일치. 정규식·단어 단위 옵션은 없다.
// 읽기 모드(domFind)와 편집 모드(FindBackdrop)가 같은 함수를 쓴다.

/** [start, end) 구간 */
export type Match = [number, number];

export function findMatches(haystack: string, query: string): Match[] {
  if (!query) return [];
  let h = haystack.toLowerCase();
  let q = query.toLowerCase();
  // 소문자화로 길이가 바뀌는 문자(예: "İ")가 있으면 인덱스가 원문과 어긋난다 → 원문 그대로 비교.
  if (h.length !== haystack.length || q.length !== query.length) {
    h = haystack;
    q = query;
  }
  const out: Match[] = [];
  let i = h.indexOf(q);
  while (i !== -1) {
    out.push([i, i + q.length]);
    i = h.indexOf(q, i + q.length);
  }
  return out;
}

/** 이전/다음 이동으로 범위를 벗어난 인덱스를 0..total-1로 순환. total이 0이면 -1. */
export function wrapIndex(index: number, total: number): number {
  return total > 0 ? ((index % total) + total) % total : -1;
}

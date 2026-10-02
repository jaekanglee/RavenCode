# 문서 내 찾기 (Cmd/Ctrl+F) — 설계

- **작성일**: 2026-10-02
- **범위**: 페이지 화면에서 Cmd+F(macOS) 또는 Ctrl+F를 누르면 찾기 막대를 연다. 읽기 모드와 편집 모드 모두 지원한다. 바꾸기는 넣지 않는다.

## 배경

데스크톱 앱의 웹뷰(macOS WKWebView)에는 브라우저 같은 찾기 막대가 없어서 Cmd+F가 아무 반응도 하지 않는다. 문서 화면은 다음과 같다.

- 읽기 모드: `InlineMarkdownEditor.tsx` 안의 `MDEditor.Markdown` (`@uiw/react-md-editor`의 Markdown 렌더러)
- 편집 모드: `dashboard/src/components/InlineMarkdownEditor.tsx` (같은 라이브러리의 편집기, textarea 기반). 이미 Cmd+E와 Cmd+S를 처리한다.

## 결정 사항

1. **새 의존성 없음.** 읽기 모드는 **CSS Custom Highlight API**(`CSS.highlights`, `Highlight`, `::highlight()`)로 일치 항목을 칠한다. DOM을 바꾸지 않으므로 React 렌더링과 충돌하지 않는다. WKWebView는 Safari 17.2(macOS 14)부터 지원한다. API가 없으면 개수 표시와 스크롤만 하고 강조는 생략한다.
2. **편집 모드**는 textarea 뒤에 같은 글꼴·패딩·줄바꿈·`box-sizing`·`scrollbar-gutter`를 쓰는 backdrop(`FindBackdrop`)을 깔고 일치 구간을 `<mark>`로 칠한다. WebKit은 포커스가 없는 textarea의 선택 영역을 그리지 않아서, 찾기 막대가 포커스를 가진 동안 `setSelectionRange`가 보이지 않기 때문이다. 현재 항목은 mark의 `offsetTop`으로 textarea를 스크롤한다.
3. 일치 판정은 대소문자를 구분하지 않는 단순 부분 문자열 비교다. 정규식, 단어 단위 같은 옵션은 넣지 않는다.
4. 보기/편집 모드를 가진 `InlineMarkdownEditor`가 Cmd+F를 가로챈다. 이 컴포넌트를 쓰는 화면(현재 PageView)에서만 동작하고, 다른 화면은 기본 동작을 그대로 둔다. 브라우저 대시보드의 페이지 화면에서도 같은 막대가 뜬다.

## 구성 요소

- `dashboard/src/lib/findInText.ts`: 순수 함수 `findMatches(haystack, query): Array<[start, end]>`. 단위 테스트 대상이다.
- `dashboard/src/components/FindBar.tsx`: 입력란, "3/12" 개수, 이전·다음 버튼, 닫기 버튼으로 구성한다. `TextField`와 ui 버튼 컴포넌트를 쓰고, 색은 CSS 변수로 지정한다.
  - Enter는 다음, Shift+Enter는 이전, Esc는 닫기다.
  - 일치가 없으면 "0/0"을 보여주고 입력란 테두리를 `--color-danger` 계열로 바꾼다.
- `dashboard/src/lib/domFind.ts` (읽기 모드): 컨테이너 아래 텍스트 노드를 `TreeWalker`로 모아 `Range` 목록을 만든다. 전체 일치는 `CSS.highlights`의 `"raven-find"`, 현재 항목은 `"raven-find-current"`로 등록한다. 현재 항목은 `scrollIntoView({block:"center"})`로 보여준다. 텍스트 노드 경계를 넘는 일치(굵게 표시를 사이에 둔 구절)는 찾지 않는다.
- `dashboard/src/components/FindBackdrop.tsx` (편집 모드): textarea 뒤에 까는 강조 레이어. 글자는 투명, 일치 구간만 `<mark>` 배경. textarea `onScroll`로 스크롤을 맞춘다.
- `globals.css`: `::highlight(raven-find)`와 `::highlight(raven-find-current)` 스타일과 토큰 `--color-find-match`, `--color-find-current`를 추가한다. 라이트와 다크 모드 값을 모두 둔다.
- `InlineMarkdownEditor.tsx`: 기존 document keydown 핸들러에 `(metaKey||ctrlKey) && key==="f"` 분기를 더해 `preventDefault` 후 막대를 연다. 이미 열려 있으면 입력란에 포커스를 주고 전체 선택한다. 모드에 따라 읽기(domFind) 또는 편집(FindBackdrop) 쪽을 연결하고, 모드를 바꿔도 검색어는 유지한다.

## 테스트

- `findInText.test.ts`: 빈 검색어, 대소문자, 겹치는 일치(`"aa"`가 `"aaa"` 안에 있는 경우), 한글, 줄바꿈.
- `FindBar` 컴포넌트 테스트: Enter와 Shift+Enter로 순환하고, Esc를 누르면 `onClose`가 호출되고, "n/m" 표시가 맞아야 한다.
- `InlineMarkdownEditor.find` 테스트: Cmd+F·Ctrl+F가 `preventDefault` 후 막대를 연다. 읽기·편집 모드 개수와 순환, 막대의 Esc가 편집을 취소하지 않는 것, textarea의 Esc는 여전히 취소하는 것.
- 수동 확인: 데스크톱 앱에서 읽기 모드 강조와 스크롤, 편집 모드 backdrop 강조 위치와 스크롤, 다크 모드 색.

## 범위 밖

바꾸기, 정규식, vault 전체 검색(기존 Cmd+K 검색이 담당), 그래프나 다른 화면에서의 찾기.

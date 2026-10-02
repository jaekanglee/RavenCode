# 문서 내 찾기 (Cmd/Ctrl+F) — 설계

- **작성일**: 2026-10-02
- **범위**: 페이지 화면에서 Cmd+F(macOS) 또는 Ctrl+F를 누르면 찾기 막대를 연다. 읽기 모드와 편집 모드 모두 지원한다. 바꾸기는 넣지 않는다.

## 배경

데스크톱 앱의 웹뷰(macOS WKWebView)에는 브라우저 같은 찾기 막대가 없어서 Cmd+F가 아무 반응도 하지 않는다. 문서 화면은 다음과 같다.

- 읽기 모드: `dashboard/src/components/MarkdownView.tsx` (`@uiw/react-md-editor`의 Markdown 렌더러)
- 편집 모드: `dashboard/src/components/InlineMarkdownEditor.tsx` (같은 라이브러리의 편집기, textarea 기반). 이미 Cmd+E와 Cmd+S를 처리한다.

## 결정 사항

1. **새 의존성 없음.** 읽기 모드는 **CSS Custom Highlight API**(`CSS.highlights`, `Highlight`, `::highlight()`)로 일치 항목을 칠한다. DOM을 바꾸지 않으므로 React 렌더링과 충돌하지 않는다. WKWebView는 Safari 17.2(macOS 14)부터 지원한다. API가 없으면 개수 표시와 스크롤만 하고 강조는 생략한다.
2. **편집 모드**는 textarea 값에서 일치 위치를 찾아 `setSelectionRange`로 선택하고, 그 위치로 스크롤한다. 하이라이트 대신 선택 영역으로 보여준다.
3. 일치 판정은 대소문자를 구분하지 않는 단순 부분 문자열 비교다. 정규식, 단어 단위 같은 옵션은 넣지 않는다.
4. Cmd+F는 페이지 화면(`PageView`)에서만 가로챈다. 다른 화면에서는 기본 동작을 그대로 둔다(브라우저 대시보드의 기본 찾기도 유지된다). 페이지 화면에서는 브라우저에서도 이 찾기 막대가 뜬다. 두 환경에서 동작을 같게 하려는 것이다.

## 구성 요소

- `dashboard/src/lib/findInText.ts`: 순수 함수 `findMatches(haystack, query): Array<[start, end]>`. 단위 테스트 대상이다.
- `dashboard/src/components/FindBar.tsx`: 입력란, "3/12" 개수, 이전·다음 버튼, 닫기 버튼으로 구성한다. `TextField`와 ui 버튼 컴포넌트를 쓰고, 색은 CSS 변수로 지정한다.
  - Enter는 다음, Shift+Enter는 이전, Esc는 닫기다.
  - 일치가 없으면 "0/0"을 보여주고 입력란 테두리를 `--color-danger` 계열로 바꾼다.
- `dashboard/src/hooks/useDomFind.ts` (읽기 모드): 컨테이너 ref 아래 텍스트 노드를 `TreeWalker`로 모아 `Range` 목록을 만든다. 전체 일치는 `CSS.highlights.set("raven-find", …)`, 현재 항목은 `"raven-find-current"`로 등록한다. 현재 항목은 `scrollIntoView({block:"center"})`로 보여준다. `content`가 바뀌면 다시 계산하고, 닫힐 때 하이라이트를 정리한다.
- `dashboard/src/hooks/useTextareaFind.ts` (편집 모드): textarea ref의 value에 `findMatches`를 돌린다. 현재 항목을 `setSelectionRange`로 선택하고, 줄 높이로 계산한 위치로 `scrollTop`을 맞춘다. 막대에서 Enter를 눌러도 입력란 포커스는 그대로 유지한다.
- `globals.css`: `::highlight(raven-find)`와 `::highlight(raven-find-current)` 스타일과 토큰 `--color-find-match`, `--color-find-current`를 추가한다. 라이트와 다크 모드 값을 모두 둔다.
- `PageView.tsx`: 키 핸들러를 둔다. `(metaKey||ctrlKey) && key==="f"`이면 `preventDefault` 후 막대를 연다. 이미 열려 있으면 입력란에 포커스를 주고 전체 선택한다. 모드(읽기/편집)에 따라 두 훅 중 하나를 연결한다. 모드를 바꾸면 검색어는 유지하고 대상만 다시 계산한다.

## 테스트

- `findInText.test.ts`: 빈 검색어, 대소문자, 겹치는 일치(`"aa"`가 `"aaa"` 안에 있는 경우), 한글, 줄바꿈.
- `FindBar` 컴포넌트 테스트: Enter와 Shift+Enter로 순환하고, Esc를 누르면 `onClose`가 호출되고, "n/m" 표시가 맞아야 한다.
- `PageView` 테스트: Cmd+F를 누르면 막대가 뜨고 `preventDefault`가 호출돼야 한다. 다른 화면에는 핸들러가 없어야 한다.
- 수동 확인: 데스크톱 앱에서 읽기 모드 강조와 스크롤, 편집 모드 선택 이동, 다크 모드 색.

## 범위 밖

바꾸기, 정규식, vault 전체 검색(기존 Cmd+K 검색이 담당), 그래프나 다른 화면에서의 찾기.

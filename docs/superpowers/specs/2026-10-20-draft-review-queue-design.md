# 초안 검토 대기열 — 설계

- **작성일**: 2026-10-20
- **범위**: frontmatter `status: draft` 문서를 대시보드에서 알아보고 승인한다. 사이드바에 표시하고, 검토 대기 화면에서 모아 보고 일괄 승인하며, 문서 상단 배너에서 하나씩 승인한다. 승인은 운영자만 한다.

## 배경

"에이전트가 MCP로 쓴 draft를 관리자가 승인해야 승격되는데, 그걸 알아볼 기능이 없다."

- 실제로 쓰이는 초안은 frontmatter `status: draft`다. rider-app은 27개 중 17개가 draft이고, 그중 13개는 tags에도 `draft`가 있다.
- vault에 주입되는 `SCHEMA.md`(Tier 2, `raven/core/templates/agent/SCHEMA.md`)는 draft를 "발행됐지만 사람 review 전, 노출, 헤더 경고"로 정의하고 `draft → current`를 "사람 명시 turn"으로 둔다. 그런데 대시보드는 `status`를 읽지 않는다.
  - `PageView`는 `status`를 파싱하지 않아 헤더 경고가 없다.
  - 트리 API의 page 노드에 `status`가 없어 사이드바가 draft를 구별하지 못한다.
  - 홈 "손볼 문서"는 `stale`·`contested`만 거른다.
  - 승격하려면 에디터에서 frontmatter를 직접 고쳐야 한다.
- 이름이 같은 `drafts/` 폴더 기능(`wiki_generate_draft` → `wiki_commit_draft`)은 사이드바 "초안" 섹션과 커밋 배너까지 있지만, 등록된 vault 셋 어디에도 `drafts/` 폴더가 없다. 이번 작업과는 별개다.

## 결정 사항

1. **기준은 `status: draft` 하나다.** tags의 `draft`만 있고 status가 draft가 아닌 문서는 대상이 아니다(현재 0건). `drafts/` 폴더 기능은 건드리지 않는다.
2. **승인 = `status: current` + tags에서 `draft` 제거.** 본문과 나머지 frontmatter(다른 태그, `agents`, `relations`, `confidence` 등)는 그대로 둔다. `updated`는 쓰기 계약 규칙대로 오늘 날짜가 된다.
3. **승인은 운영자 전용이다.** 손님 토큰(`rvg_`)은 `update` 권한이 있어도 승인할 수 없다. 새 라우트 둘은 `guest_routes.ROUTES`에 `owner`로 분류한다. 대시보드는 손님 탭에서 검토 대기 진입점과 승인 버튼을 숨긴다. draft 표시(점, 배너 문구)는 손님에게도 보인다.
4. **MCP 도구는 추가하지 않는다.** 에이전트가 스스로 승인하면 "사람이 승인한다"는 전제가 깨진다.
5. **쓰기는 기존 계약을 탄다.** `raven.core.contracts.write_page`에 기존 본문을 그대로 넘기고 `extra_meta={"status": "current"}`와 `draft`를 뺀 tags를 준다. actor 없이(`actor=None`, `enforce_protected_paths=True`) 쓰므로 대시보드 문서 수정 `PUT /pages/{slug}`와 같은 조건이다. 잠금과 원자적 쓰기는 계약이 맡는다. `log.md`에는 `update` 레코드를 남기고 note에 "검토 승인: draft → current"를 적는다(새 action 종류는 만들지 않는다).
6. **한 번에 여러 건, 건별 결과.** 승인 요청은 slug 목록을 받고 하나씩 처리한다. 일부가 실패해도 나머지는 반영한다. 건별 결과는 `approved` / `not_found` / `not_draft` / `stale_precondition` / `error` 중 하나다.
7. **읽은 뒤 바뀐 문서는 승인하지 않는다.** 문서 배너의 승인은 그 문서를 불러올 때 받은 precondition 토큰을 함께 보낸다. 그사이 에이전트가 내용을 바꿨으면 `stale_precondition`으로 거절하고 "내용이 바뀌었으니 다시 확인해 달라"고 안내한다. 검토 대기 화면의 일괄 승인은 토큰 없이 보낸다(본문을 보지 않고 승인하겠다는 운영자의 선택이다). 두 경로 모두 처리 시점에 status가 아직 draft인지는 확인한다.
8. **반려 기능은 넣지 않는다.** 반려는 지금처럼 문서에서 고치거나 삭제한다.

## 화면

| 위치 | 내용 |
|---|---|
| 사이드바 vault 섹션 | 트리 맨 위에 "검토 대기 N" 줄. 누르면 `/review/<vault>`. N이 0이거나 손님 탭이면 숨긴다. N은 트리 응답에서 센다(추가 요청 없음). |
| 사이드바 트리 | draft 문서 행에 상태 점. 그룹 행(사이드바는 문서를 type별로 묶는다)에는 하위 draft 개수. |
| `/review/<vault>` (신규) | 제목 줄 "검토 대기 N · in <vault>". 목록 행: 체크박스, 제목(누르면 문서로 이동), 타입 pill, 마지막 작성 에이전트, 수정일. 상단에 "전체 선택"과 "선택 승인 (k)". 승인 뒤 결과 토스트(성공 n건, 건너뜀 m건과 이유)를 띄우고 목록을 다시 불러온다. 비면 `EmptyState`("검토할 초안이 없습니다"). 손님 탭이면 안내만 보여 준다. |
| 문서 상단 | `status: draft`이면 배너 "에이전트가 쓴 초안입니다 · 검토 대기"와 **승인** 버튼(운영자만). 승인되면 문서를 다시 불러오고 배너가 사라진다. |
| 홈 "손볼 문서" | 필터에 `draft`를 더한다. 빈 문구는 "stale·contested·draft 문서가 없습니다." |

승인이 끝나면 `tree:<vault>`·`pages:<vault>` 캐시를 무효화하고, Layout의 `refresh`(outlet context)를 불러 사이드바 트리를 다시 받는다. 문서 수정 저장 뒤와 같은 경로다. 검토 화면은 승인 뒤 자기 목록을 다시 불러온다.

## API

`GET /api/vaults/{name}/review` — 운영자 전용

```jsonc
{
  "ok": true,
  "vault": "rider-app",
  "drafts": [
    {
      "slug": "content/결제-정산",
      "title": "결제 정산",
      "type": "concept",
      "created": "2026-07-08",
      "updated": "2026-10-16",
      "last_agent": "claude"   // frontmatter agents 마지막 항목: dict면 name, 문자열이면 그 값, 없으면 null
    }
  ]
}
```

정렬은 `updated` 내림차순, 같으면 제목순.

`POST /api/vaults/{name}/review/approve` — 운영자 전용

```jsonc
// 요청
{ "items": [ { "slug": "content/결제-정산", "precondition": "…" }, { "slug": "content/실시간-통신-위치" } ] }
// 응답 (항상 200, 건별 결과)
{
  "ok": true,
  "results": [
    { "slug": "content/결제-정산", "result": "approved" },
    { "slug": "content/실시간-통신-위치", "result": "not_draft" }
  ]
}
```

`items`가 비었거나 200건을 넘으면 400. vault가 없으면 404.

## 구성

| 파일 | 역할 |
|---|---|
| `raven/core/review.py` (신규) | `list_drafts(vault)`, `approve(vault, items)`. frontmatter는 `raven.core.frontmatter.parse`로 읽고, 쓰기는 `contracts.write_page`. HTTP를 모르는 순수 core. |
| `raven/api/review_api.py` (신규) | 두 라우트를 `app.add_api_route`로 등록(`guest_api.py`와 같은 방식). 요청 검증과 404/400만 맡는다. |
| `raven/api/server.py` | `review_api` 등록. `_build_tree_node`의 page 노드에 `status` 추가(`normalize_status`). |
| `raven/api/guest_routes.py` | 새 라우트 둘을 `owner`로 분류. |
| `dashboard/src/types.ts` | `TreeNode.status?: string` |
| `dashboard/src/lib/api.ts` | `fetchReviewQueue`, `approveDrafts`와 응답 타입. 승인 뒤 캐시 무효화. |
| `dashboard/src/lib/review.ts` (신규) | `isDraftStatus(status)`, `countDrafts(node)`, `summarizeApproval(results)` 순수 함수. 사이드바·검토 화면·문서 화면과 테스트가 함께 쓴다. |
| `dashboard/src/components/Sidebar.tsx` | 검토 대기 줄, 문서 행 점, 폴더 개수. |
| `dashboard/src/routes/ReviewPage.tsx` (신규) | 검토 대기 화면. |
| `dashboard/src/App.tsx` | `/review/:vault` 라우트. |
| `dashboard/src/components/DraftReviewBanner.tsx` (신규) | 문서 상단 배너와 승인 버튼. |
| `dashboard/src/routes/PageView.tsx` | `fm.status`를 읽어 배너를 붙인다. |
| `dashboard/src/routes/HomePage.tsx` | `pickUnfinishedPages`에 draft 추가, 빈 문구. |

색과 글꼴은 `globals.css`의 CSS 변수를 쓴다. draft 점과 배너에 맞는 토큰이 없으면 `:root`에 추가한다.

## 테스트

- **core** (`tests/test_review.py`): draft만 목록에 나온다 / `last_agent` 추출 / 승인하면 status가 current가 되고 `draft` 태그만 빠진다 / 본문과 다른 frontmatter가 보존된다 / draft가 아닌 문서는 `not_draft` / 없는 slug는 `not_found` / precondition이 다르면 `stale_precondition`이고 파일이 그대로다 / 일부 실패해도 나머지는 반영된다 / `log.md`에 레코드가 남는다.
- **API**: 두 라우트 정상 응답 / 빈 items·201건은 400 / 손님 토큰은 403 / `test_every_route_is_classified` 통과 / 트리 page 노드에 `status`가 있다.
- **dashboard**: `countDrafts`(중첩 폴더) / `pickUnfinishedPages`가 draft를 포함 / 검토 화면에서 선택 → 승인 → 결과 토스트와 목록 갱신 / 손님 탭에서 승인 버튼이 없다 / 배너가 draft일 때만 보인다.

## 범위 밖 (후속 후보)

- `stale`·`contested` 헤더 경고: Tier 2 SCHEMA가 약속하지만 아직 없다. 이번 배너 컴포넌트를 상태별로 넓히면 된다.
- issue draft 7일 자동 승격: Tier 2 SCHEMA에 적혀 있지만 `_auto_promote_draft_issues`를 부르는 곳이 없다. 문서를 고칠지 코드를 살릴지 따로 정한다.
- 정본 `_meta/SCHEMA.md`의 status 표는 4종(draft 없음)이라 Tier 2 템플릿(5종)과 어긋난다.
- CLI `raven review list|approve`.

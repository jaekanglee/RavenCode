---
title: Vault Policy Slot and MCP Delivery
created: 2026-09-25
type: rule
tags: [rule, agent, mcp, workflow]
confidence: medium
status: accepted
refines: adr-2026-07-14-raven-contract-and-user-agent-policy-boundary
---

# Vault Policy Slot and MCP Delivery

> **결정:** Raven은 vault 운영 지침의 **내용**은 계속 소유하지 않는다. 대신 사용자가 쓴 지침을 둘 **자리**(vault 안의 보호된 파일 1개), 사람이 편집할 **화면**, 에이전트에게 건네는 **MCP 전달 경로**, 제품 계약 기준의 **검증**을 제공한다.

## 맥락

2026-07-14 결정으로 운영 지침은 Raven 밖의 사용자 소유 문서가 됐다. 현재는 별도 git repo(`RavenVaultPolicies`)로 관리한다. 두 달 운영해 보니 경계는 옳았지만 전달 경로가 비싸다.

- **세팅이 무겁다.** 에이전트마다 정책 repo clone, 경로 변수 5개, 루트 지침 파일에 트리거 블록 붙여넣기가 필요하다.
- **세팅을 안 하면 조용히 약해진다.** hub-control-room은 트리거 설치 위치를 정하지 못해 설치하지 않았고, 세션 전체가 명시적 지시(Level 0)로만 운영됐다. 작업 종료 시 제안은 한 번도 뜨지 않았다.
- **제품 계약 사본이 낡는다.** 정책과 검증기가 type 목록·stale 기준을 상수로 들고 있다. 검증기가 실제 제품을 읽지 못하니 제품-정책 드리프트를 못 잡는다(정책 repo CHANGELOG v1.13.0의 CI 제거 이유).
- **승인 게이트가 문서에만 있다.** "에이전트는 자기 정책을 승인 없이 바꾸지 않는다"를 강제하는 장치가 없다.

2026-07-14 결정의 핵심은 저장 위치가 아니라 **소유권**이었다 — 제품이 운영 판단을 섞어 전달하지 않고, 사용자 지침 파일을 생성·덮어쓰지 않는다. 이 조건을 지키면 자리와 전달 경로는 제품이 제공해도 된다.

### 반복하지 않을 것

2026-07-15 `530fdbc`에서 bootstrap·guide·freshness·diff 표면을 통째로 제거했다(약 1,600줄). 제품이 가이드 **내용**을 설치·동기화·신선도 검사하던 구조가 비용만 컸다. 이번 결정은 그 반대 방향이어야 한다 — 제품은 사용자 파일을 **읽어서 건네기만** 하고, 설치·동기화·버전 비교를 하지 않는다.

## 결정

### 1. 자리 — vault당 사용자 소유 파일 1개

- 경로: `_meta/policy/VAULT-POLICY.md` (가칭)
- `_meta/agents/`에 두지 않는다. 그 디렉터리가 있으면 `Vault.is_llm_wiki`가 참이 되므로, 정책을 쓰는 것만으로 LLM Wiki 모드가 켜지면 안 된다.
- **Raven은 이 파일을 만들지 않는다.** 사람이 Dashboard에서 "템플릿에서 시작"을 눌렀을 때만 빈 템플릿을 1회 복사한다. 이후 bootstrap·sync·업그레이드가 이 파일을 건드리지 않는다.
- **에이전트 쓰기 차단은 추가 구현이 필요 없다.** `raven/core/contracts.py`가 `_meta/` 전체를 에이전트 쓰기 금지(`permission_denied` + audit)로 막고 있다. 정책 변경은 사람의 Dashboard 편집으로만 일어나고, 문서에만 있던 승인 게이트를 제품이 강제하게 된다.
- **색인에서 뺀다.** `_meta/`는 현재 색인 대상이다. 정책 파일이 페이지로 잡히면 type lint·그래프·검색에 섞인다. `ROOT_AGENT_INSTRUCTION_FILES`처럼 "사용자 소유 지침"으로 열거해 페이지 해석에서 제외한다.

### 2. 공통 운영 지침 — 설치당 1개 (선택)

모든 vault가 공유하는 작업 방식(현재 `VAULT-OPERATOR.md`)은 Raven 데이터 디렉터리의 사용자 소유 파일 1개로 둔다. 규칙은 vault 파일과 같다 — 제품이 내용을 넣지 않고, 사람이 편집하고, 없으면 없는 대로 동작한다.

### 3. 전달 — MCP

- **읽기 도구 1개**: `wiki_get_policy(vault) -> {vault, content, modified, common_content}`. 파일이 없으면 `content: null`을 돌려주고 오류로 만들지 않는다. 모든 모드(read/write/admin)에서 사용 가능하다.
- **서버 `instructions`에 한 줄 추가**: "vault 작업 전에 `wiki_get_policy(vault)`를 호출하고 그 지침을 따른다." `instructions`는 MCP 클라이언트(Claude Code 등)가 시스템 프롬프트에 주입하는 표준 필드이고, Raven은 이미 이 필드를 쓰고 있다(`raven/mcp/cli.py`, 현재는 vault 목록만). 정책 본문은 넣지 않는다 — 서버 시작 시 고정되는 문자열이라 vault별 내용과 편집 반영을 담을 수 없다.
- 결과: **MCP를 연결하는 것만으로 세팅이 끝난다.** 트리거 블록·경로 변수·clone이 필요 없어진다.
- 진입점 추가가 아니다. 에이전트 ↔ Raven = MCP 단일 원칙(AGENTS.md §5.5) 안에서 read 도구 1개가 늘어난다.

### 4. 사람 쪽 표면 — Dashboard

vault 설정 안에 정책 편집기 1개(보기·편집·"템플릿에서 시작"). REST `GET/PUT /api/vaults/{name}/policy`로 백엔드를 두고, 쓰기는 사람 진입점에서만 허용한다.

### 5. 검증 — 제품 계약 기준 policy lint

정책 파일 frontmatter/YAML 블록의 type·필수 필드·stale 기준을 **제품의 실제 계약**과 대조하는 lint check 1개. 정책 repo 검증기가 상수로 들고 있던 계약 사본을 없앤다. 정책의 판단 내용(저장 기준, 제안 조건 등)은 검사하지 않는다 — 그것은 사용자 소유다.

## 하지 않는 것

- 기본 운영 철학·저장 기준·에이전트 역할을 제품에 넣지 않는다. 템플릿은 빈칸 양식이다.
- 정책 파일을 자동 생성·동기화·신선도 검사·버전 diff 하지 않는다.
- `AGENTS.md`·`CLAUDE.md` 등 루트 지침 파일을 생성·수정하지 않는다(2026-07-14 결정 유지).
- 에이전트가 MCP로 정책을 쓰게 하지 않는다.

## 트레이드오프

- **변경 이력**: git repo의 커밋 이력을 잃는다. vault가 git으로 관리되면 그대로 남고, 아니면 Dashboard 저장을 `log.md`에 기록하는 것으로 부분 대체한다.
- **`instructions`를 무시하는 클라이언트**: 도구는 보이지만 호출 지시가 없다. 이런 클라이언트에서는 사용자가 "정책 읽고 시작해"라고 한 번 말해야 한다. 지금보다 나빠지지 않는다.
- **MCP 없이 쓰는 에이전트**: 파일이 vault 안의 평범한 markdown이라 직접 읽을 수 있다. 이식성은 유지된다.
- **정책 repo의 역할 축소**: 템플릿·프리셋 원본과 과거 이력 보관으로 줄어든다. 폐기는 이전이 끝난 뒤 별도로 결정한다.

## 단계

1. 이 ADR 승인, `AGENTS.md` §4 Tier 2 문구 정정 ("vault 운영 지침은 Raven 영역 ❌" → "지침 내용은 Raven 영역 ❌, 자리와 전달 경로는 제공")
2. `wiki_get_policy` + `instructions` 한 줄 + 색인 제외 — 가장 작은 패치로 전달 경로만 먼저 검증 (회귀 테스트 5개 이상)
3. REST + Dashboard 편집기
4. policy lint
5. 기존 7개 vault 정책을 각 vault로 이전 (vault 데이터 쓰기이므로 vault별 사용자 승인)

## 열린 질문

- 공통 운영 지침(§2)을 제품 데이터 디렉터리에 둘지, 별도 "정책 vault"에 둘지
- 정책 파일 형식: 현재 정책 repo처럼 본문 + YAML 블록을 유지할지, frontmatter로 옮길지 (policy lint 구현 난이도가 달라진다)
- 멀티 에이전트 환경에서 vault 하나에 역할별 정책이 필요해질 때의 확장 — 지금은 vault당 1개로 시작한다

## 관련

- [[raven-contract-and-user-agent-policy-boundary]] — 이 결정이 다듬는 경계
- `530fdbc` refactor: remove bootstrap and guide surfaces — 반복하지 않을 구조

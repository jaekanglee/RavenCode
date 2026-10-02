---
title: Gardening Record Log Entry
created: 2026-10-02
type: rule
tags: [rule, agent, mcp, workflow]
confidence: medium
status: accepted
---

# Gardening Record Log Entry

> **결정:** 에이전트가 `log.md`에 쓰는 유일한 경로로 MCP `wiki_gardening_record`(write 모드)를 둔다. 형식이 고정된 `gardening` 항목 하나만 쓰며, 범용 로그 쓰기 도구는 만들지 않는다.

## 맥락

정책 repo v1.17.0의 가드닝 절차(VAULT-OPERATOR §3.3)는 회차를 이어 가려면 지난 회차의 마지막 날짜와 보류·제안 목록이 필요하다. 그런데 에이전트는 `log.md`에 직접 쓸 수 없다(`raven/core/contracts.py` 보호 경로, PWW §8.4). 그래서 페이지를 고친 회차만 `wiki_update`의 `reason`으로 흔적이 남았고, 변경이 0건인 회차와 보류 목록은 대화 보고에만 남았다. 다음 세션은 그 대화를 볼 수 없다.

## 결정

- **좁은 쓰기 경로 1개**: `wiki_gardening_record(vault, summary, deferred?, proposed?, actor?)` → `## [날짜] gardening | <summary>` 항목과 `- actor:`·`- deferred:`·`- proposed:` 줄. `raven.core.log.append`를 거쳐 다른 항목과 같은 잠금·원자적 쓰기·rotate를 탄다.
- **위조 차단**: 값에 줄바꿈이 있으면 거부한다(헤더나 세부 줄을 끼워 넣을 수 있다). 값 300자, 목록 각 50개 상한.
- **조회**: `wiki_log(action="gardening")`. `gardening`은 `log.md` 액션 목록에 추가되고 Dashboard 로그 필터에도 보인다.
- 기존 `log.md` 보호(`wiki_update` 등으로의 쓰기 차단 + audit)는 그대로다.

## 하지 않는 것

- 임의 액션·임의 본문을 쓰는 `wiki_log_append` 같은 범용 도구. 에이전트가 운영 로그를 자유롭게 쓰면 로그가 감사 기록으로서 의미를 잃는다.
- 가드닝 주기·우선순위·완료 기준 같은 운영 판단. 이는 vault owner의 정책(VAULT-OPERATOR, vault `gardening` 블록) 소관이다(`adr-2026-09-25-vault-policy-slot-and-mcp-delivery`).

## 트레이드오프

- write 모드가 아닌 에이전트는 기록을 남기지 못한다. 그 경우 지금처럼 보고에만 남는다.
- 에이전트가 같은 회차를 여러 번 기록할 수 있다. 중복 방지는 하지 않는다 — 기록이 남는 쪽이 빠지는 쪽보다 낫다.

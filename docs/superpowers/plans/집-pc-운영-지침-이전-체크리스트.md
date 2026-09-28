---
title: 집 PC 운영 지침 이전 체크리스트
created: 2026-09-28
updated: 2026-09-28
type: rule
tags: [plan, workflow, mcp, agent]
status: todo
---

# 집 PC 운영 지침 이전 체크리스트

> **BLUF**: 회사 PC에서 hub-control-room 하나를 옮겼다. 집 PC에서는 앱을 새 코드로 재설치한 뒤 나머지 6개 vault의 운영 지침을 각 vault의 `_meta/policy/VAULT-POLICY.md`로 옮기고, 끝나면 정책 repo 안내문을 "MCP 연결이면 끝" 기준으로 고친다.

배경: `_meta/decisions/adr-2026-09-25-vault-policy-slot-and-mcp-delivery.md`. 회사 PC 작업 기록은 `_meta/changelog-v0.7.182.md` §23·§25·§26·§28·§29.

## 0. 준비

- [ ] Raven 최신 코드 받기: `raven update` (또는 `git pull --ff-only`). `132c07b` 이후여야 한다
- [ ] 정책 repo 최신 받기: `git -C <POLICIES_CHECKOUT> pull --ff-only` (`d8eab12` 이후)
- [ ] 앱 재설치: `make desktop-install` → `open /Applications/Raven.app`
- [ ] 새 코드가 들어갔는지 확인: `find /Applications/Raven.app -name policy.py -path '*raven/core*'`가 나와야 한다. 없으면 옛 앱이라, 정책 파일이 **페이지로 색인**되고 MCP에 `wiki_get_policy`도 없다 — 이전하지 말 것

## 1. vault별 이전 (6개)

대상: harumoa · hellburn · hermes-infra · homelab · raven-dev · talkmmury (정책 원본: 정책 repo `vaults/<name>.md`)

vault 하나마다:

1. [ ] vault가 이 PC 레지스트리에 있는지 확인 — 대시보드 관리 페이지, 또는 `raven vault list`
2. [ ] 본문 준비: 원본 그대로 두고 제목 다음 줄에 안내 한 줄만 붙인다. hub-control-room에 붙인 문장과 같은 형식:
   > **정본 위치**: 이 파일이 정본이다 (YYYY-MM-DD, 정책 repo `vaults/<name>.md`에서 이전). 에이전트는 MCP `wiki_get_policy`로 읽는다. 본문의 `VAULT-OPERATOR.md`(공통 운영 지침)는 정책 repo https://github.com/jaekanglee/RavenVaultPolicies 에 있다.
3. [ ] 저장: 대시보드 **관리 → 운영 지침 → 빈 문서로 시작**에 붙여넣고 저장. 또는 REST `PUT /api/vaults/<name>/policy` + `{"content": ..., "precondition": ""}` (`""` = 아직 없다는 단언. 이미 있으면 409)
4. [ ] 확인
   - 저장된 파일이 준비본과 같다 (`cmp`)
   - `log.md`에 `create | _meta/policy/VAULT-POLICY.md`
   - 앱 MCP(8766)에서 `wiki_get_policy(<name>)`가 파일과 같은 내용
   - lint #24 결과 확인 (예상: homelab만 1건, 아래)
5. [ ] 정책 repo에서 원본 내리기: `git mv vaults/<name>.md vaults/history/<name>-policy-until-YYYY-MM-DD.md`, 파일 맨 위에 "이전됨 — 실행 지침 아님" 한 줄
6. [ ] vault가 git 저장소면 정책 파일만 커밋 (다른 변경이 섞여 있으면 빼고)

vault별 주의:

- **homelab** — 정책 `required_fields`에 `created`가 없다(lint #24 info). 옮기면서 `[title, type, created, updated]`로 고친다 (소유자 결정 사항이라 확인 후)
- **harumoa** — 제품 9종 밖 type 5종이 `validator_exceptions`(approved_by·approved_at 있음)로 선언돼 있다. lint #24가 인정하므로 그대로 옮기면 0건
- **raven-dev** — 책임 에이전트가 `raven-vault-coach`로 적혀 있다. 이전과 무관하지만 지금도 맞는지 한 번 볼 것

## 2. 6개 이전 뒤 정책 repo 정리

- [ ] `AGENT-INSTRUCTION.md` §1의 "이전된 vault:" 목록에 옮긴 vault 추가 (지금은 `hub-control-room`만)
- [ ] `validate-policies.py`가 `vaults/*.md`만 보므로, 다 옮기면 검사 대상이 없어진다 — 검증기를 템플릿·공통 문서 검사만 남기도록 정리할지 결정
- [ ] `SETUP-GUIDE.md`·`SOUL-TRIGGER-BLOCK.md`를 "Raven MCP 연결 → 대시보드에서 운영 지침 작성"을 기본 경로로 고쳐 쓴다. clone·변수 5개·트리거 블록은 MCP 없는 환경용 대체 경로로 내린다
- [ ] CHANGELOG 항목 추가 → `python3 script/validate-policies.py` 0건 → commit·push

## 3. 결정할 것

- **공통 운영 지침 전달**: `VAULT-OPERATOR.md`는 아직 MCP로 전달되지 않는다. vault 정책이 이 문서의 §를 참조하므로 에이전트는 여전히 정책 repo를 따로 읽어야 한다. ADR 열린 질문 — 앱 데이터 디렉터리 vs 별도 정책 vault
- **rider-app**(회사 PC에만 있음): 운영 지침이 없다. 필요하면 대시보드 "템플릿에서 시작"으로 작성

## 참고 — 회사 PC에서 이미 끝난 것

- Raven: MCP `wiki_get_policy`, REST GET/PUT, 대시보드 편집 화면, lint #24, textarea 높이 버그, 테스트 레지스트리 오염 수정 — 전부 push됨 (`132c07b`)
- 정책 repo: 지식화 방법론 보강(v1.15.0), hub-control-room 이전(v1.16.0) — push됨 (`d8eab12`)
- `~/Raven`(회사 PC 로컬): hub-control-room 정책 + 레지스트리 정리 커밋 (`04244f7`, remote 없음)

---
title: Docker Desktop loopback 토큰 우회 — 해결 기록
type: issue
status: resolved
created: 2026-10-13
resolved: 2026-10-13
tags: [security, access, docker, mcp, api]
source: 2026-10-12 운영 배포 전 감사에서 발견 (GitHub #67), PR #69(opt-in), 기본 정책 전환 PR
aliases: [issue-67-loopback-token-mode]
---

# Docker Desktop loopback 토큰 우회

macOS Docker Desktop은 컨테이너의 `host.docker.internal` 연결을 호스트 loopback으로 넘긴다. Core API와 MCP에는 그 연결이 `127.0.0.1`에서 온 것으로 보였고, 컨테이너가 `Host: 127.0.0.1:<port>`를 보내면 #28의 토큰 없는 loopback 통과를 받았다. 실측(master `ffe72d2`): Core·MCP 모두 토큰 없이 200, 잘못된 토큰을 보내도 200.

## 경과

1. **PR #69 — opt-in 강화 모드**: `RAVEN_REQUIRE_LOOPBACK_TOKEN`을 켜면 loopback에도 토큰을 요구했다. 기본 설치는 그대로 열려 있었고, 데스크톱 앱은 매번 토큰을 붙여 넣어야 했으며, Finder로 연 앱에는 환경 변수가 닿지 않았고, compose healthcheck가 깨졌다.
2. **기본 정책 전환**: 모든 출처에 토큰을 요구한다. 결정과 근거는 [`_meta/decisions/adr-2026-10-13-loopback-token-required.md`](../../_meta/decisions/adr-2026-10-13-loopback-token-required.md). `RAVEN_REQUIRE_LOOPBACK_TOKEN`은 기본 동작이 되어 없앴다.

## 지금 동작

- 토큰 없이 열리는 것: `GET /healthz`(고정 본문), Core가 서빙하는 대시보드 정적 파일.
- 데스크톱 앱: 셸이 실행마다 만든 세션 자격 증명으로 자동 인증(사용자 입력 없음).
- vite 대시보드·로컬 MCP 클라이언트·스크립트: 발급 토큰(`raven mcp token add`).
- compose healthcheck: `curl -fsS /healthz`.

## 남은 것

- 토큰을 가진 컨테이너는 같은 PC로 보여 #15의 이 PC 전용 API도 쓸 수 있다.
- OrbStack·Colima·Podman forwarding, Windows·Linux webview 실측은 UNKNOWN.

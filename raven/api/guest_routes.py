"""손님 토큰(``rvg_``)의 라우트 판정 (spec 2026-10-16-guest-access-design).

``ROUTES``는 Core API의 **모든** 라우트를 ``(method, 경로 템플릿)``으로 분류한다
(``tests/test_guest_gate.py::test_every_route_is_classified``가 빠진 라우트를 잡는다).
표에 없으면 ``owner`` — 새 API는 분류하기 전까지 손님에게 닫혀 있다.

분류:
- ``read`` / ``create`` / ``update``: 경로의 ``{name}`` vault에 그 권한이 있어야 한다.
- ``any``: 승인된 손님이면 누구나 (vault 없음). ``GET /api/vaults``는 핸들러가 목록을 거른다.
- ``public``: 게이트의 공개 예외로 토큰 없이 들어온다 (손님 판정까지 오지 않는다).
- ``owner``: 운영자만 (데스크톱 세션 · ``rvn_`` 토큰). 삭제와 관리 작업 전부.
"""
from __future__ import annotations

from typing import Optional

from starlette.routing import Match

from raven.core import guest_access
from raven.core.access import effective_client

V = "/api/vaults/{name}"

ROUTES: dict[tuple[str, str], str] = {
    # ── 손님 입장
    ("POST", "/api/guest/requests"): "public",
    ("GET", "/api/guest/requests/{request_id}"): "public",
    ("GET", "/api/guest/me"): "any",
    ("GET", "/api/guest/requests"): "owner",
    ("POST", "/api/guest/requests/{request_id}/approve"): "owner",
    ("POST", "/api/guest/requests/{request_id}/deny"): "owner",
    ("GET", "/api/guest/grants"): "owner",
    ("DELETE", "/api/guest/grants/{grant_id}"): "owner",
    # ── vault 목록 (핸들러가 허용된 vault만 남긴다)
    ("GET", "/api/vaults"): "any",
    # ── 읽기
    ("GET", V): "read",
    ("GET", f"{V}/advice"): "read",
    ("GET", f"{V}/ai-advice"): "read",
    ("GET", f"{V}/archive"): "read",
    ("GET", f"{V}/drafts"): "read",
    ("GET", f"{V}/garden"): "read",
    ("GET", f"{V}/graph"): "read",
    ("GET", f"{V}/hybrid-search"): "read",
    ("GET", f"{V}/link-check"): "read",
    ("GET", f"{V}/lint"): "read",
    ("GET", f"{V}/lint/contradictions"): "read",
    ("GET", f"{V}/lint/summary"): "read",
    ("GET", f"{V}/log"): "read",
    ("GET", f"{V}/log/status"): "read",
    ("GET", f"{V}/pages"): "read",
    ("GET", f"{V}/pages/{{slug:path}}"): "read",
    ("GET", f"{V}/pages/{{slug:path}}/export.md"): "read",
    ("GET", f"{V}/pages/{{slug:path}}/recommendations"): "read",
    ("GET", f"{V}/policy"): "read",
    ("GET", f"{V}/rag/query"): "read",
    ("GET", f"{V}/raw"): "read",
    ("GET", f"{V}/raw/{{path:path}}"): "read",
    ("GET", f"{V}/search"): "read",
    ("GET", f"{V}/stats"): "read",
    ("GET", f"{V}/tree"): "read",
    ("POST", f"{V}/suggest-tags"): "read",  # 계산만 하고 쓰지 않는다
    # ── 작성
    ("POST", f"{V}/pages"): "create",
    ("POST", f"{V}/folders"): "create",
    # ── 수정
    ("PUT", f"{V}/pages/{{slug:path}}"): "update",  # 핸들러가 기존 페이지만 허용 (없으면 404)
    ("POST", f"{V}/relations"): "update",
    ("POST", f"{V}/pages/{{slug:path}}/feedback"): "update",
    ("POST", f"{V}/lint/contradictions/resolve"): "update",
    # ── 운영자 전용: 삭제
    ("DELETE", V): "owner",
    ("DELETE", f"{V}/drafts/{{draft_name}}"): "owner",
    ("DELETE", f"{V}/feedback/{{index}}"): "owner",
    ("DELETE", f"{V}/graph/positions"): "owner",
    ("DELETE", f"{V}/locks"): "owner",
    ("DELETE", f"{V}/pages/{{slug:path}}"): "owner",
    ("DELETE", f"{V}/raw/{{path:path}}"): "owner",
    # ── 운영자 전용: vault·시스템 관리
    ("GET", "/api/system/info"): "owner",
    ("GET", "/api/index.json"): "owner",
    ("POST", "/api/debug-log"): "owner",
    ("POST", "/api/backup/export"): "owner",
    ("POST", "/api/backup/import"): "owner",
    ("POST", "/api/crosslink/{name}"): "owner",
    ("POST", "/api/vaults"): "owner",
    ("POST", "/api/vaults/register"): "owner",
    ("PUT", V): "owner",
    ("POST", f"{V}/archive/clean"): "owner",
    ("POST", f"{V}/archive/restore"): "owner",
    ("POST", f"{V}/build"): "owner",
    ("POST", f"{V}/clone"): "owner",
    ("POST", f"{V}/drafts/commit"): "owner",    # 운영자가 LLM으로 만든 초안의 발행
    ("POST", f"{V}/drafts/generate"): "owner",  # LLM 비용
    ("GET", f"{V}/review"): "owner",            # 초안 검토 대기열 — 승인은 운영자 일
    ("POST", f"{V}/review/approve"): "owner",
    ("POST", f"{V}/export"): "owner",
    ("PUT", f"{V}/feedback/{{index}}"): "owner",  # 남의 피드백 문구를 원래 작성자 이름으로 바꾼다
    ("GET", f"{V}/git/diff"): "owner",
    ("GET", f"{V}/git/status"): "owner",
    ("POST", f"{V}/graph/positions"): "owner",
    ("GET", f"{V}/locks"): "owner",
    ("POST", f"{V}/log"): "owner",
    ("POST", f"{V}/log/rotate"): "owner",
    ("PUT", f"{V}/policy"): "owner",
    ("PUT", f"{V}/raw/{{path:path}}"): "owner",
    ("POST", f"{V}/repair"): "owner",
    ("POST", f"{V}/select"): "owner",  # 서버 전역 상태
    ("POST", f"{V}/workspace"): "owner",
    ("GET", f"{V}/workspace/file"): "owner",
    ("GET", f"{V}/workspace/tree"): "owner",
    # ── 그 밖 (대시보드 정적 파일은 게이트의 공개 예외로 따로 열린다)
    ("GET", "/{full_path:path}"): "owner",
    ("GET", "/docs"): "owner",
    ("GET", "/docs/oauth2-redirect"): "owner",
    ("GET", "/openapi.json"): "owner",
    ("GET", "/redoc"): "owner",
}

_PUBLIC_PATHS = {path for (_, path), perm in ROUTES.items() if perm == "public"}


def classify(app, scope) -> tuple[str, Optional[str]]:
    """``(분류, vault 이름)``. 라우트를 찾지 못하면 ``("owner", None)``."""
    if scope["type"] != "http":
        return "owner", None
    method = "GET" if scope.get("method") == "HEAD" else scope.get("method", "")
    for route in app.router.routes:
        match, child = route.matches(scope)
        if match == Match.FULL:
            perm = ROUTES.get((method, getattr(route, "path", "")), "owner")
            return perm, child.get("path_params", {}).get("name")
    return "owner", None


def is_public(app, scope) -> bool:
    """손님 입장 요청·상태 조회 — 토큰 없이 들어오는 API 2종."""
    perm, _ = classify(app, scope)
    return perm == "public"


def _header(scope, name: bytes) -> Optional[str]:
    for key, value in scope.get("headers", []):
        if key == name:
            return value.decode("latin-1")
    return None


def authorize(app, scope, token: str) -> tuple[bool, dict]:
    """손님 토큰 판정. ``(True, 손님 정보)`` 또는 ``(False, {"status", 응답 본문...})``."""
    grant, reason = guest_access.check_grant(
        token, _header(scope, b"x-raven-device"), effective_client(scope))
    if reason is not None:
        return False, {"status": 401, "error": "unauthorized", "reason": reason,
                       "detail": "손님 입장이 만료됐거나 확인되지 않았습니다. 다시 입장을 요청해 주세요."}
    perm, vault = classify(app, scope)
    info = {"id": grant["id"], "name": grant["name"], "vaults": grant["vaults"]}
    if perm == "any":
        return True, info
    if perm in guest_access.PERMS and vault and perm in grant["vaults"].get(vault, []):
        return True, info
    body = {"status": 403, "error": "forbidden",
            "detail": "손님 권한으로 할 수 없는 작업입니다."}
    if perm in guest_access.PERMS:
        body.update(need=perm, vault=vault)
    return False, body

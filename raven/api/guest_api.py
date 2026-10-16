"""손님 입장 HTTP API (spec 2026-10-16-guest-access-design).

누가 어떤 API를 부를 수 있는지는 게이트가 ``guest_routes.ROUTES``로 정한다 — 요청 생성·상태
조회는 공개, ``/api/guest/me``는 손님, 나머지는 운영자. 핸들러는 그 판정을 믿고 일만 한다.

라우트는 ``install(app)``이 앱에 직접 등록한다. FastAPI 0.139의 ``include_router``는 라우트를
묶음 하나로 넣어 ``guest_routes.classify``가 개별 경로 템플릿을 볼 수 없다.
"""
from __future__ import annotations

from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel

from raven.core import guest_access
from raven.core.access import GUEST_STATE_KEY, UNKNOWN_CLIENT
from raven.core.registry import registry

def guest_of(request: Request) -> Optional[dict]:
    """게이트가 통과시킨 손님의 ``{id, name, vaults}``. 운영자 요청이면 None."""
    return request.scope.get("state", {}).get(GUEST_STATE_KEY)


def guest_actor(request: Request) -> Optional[str]:
    """손님 쓰기의 작성자 이름 (``guest:<이름>``). 클라이언트가 보낸 actor 대신 쓴다."""
    guest = guest_of(request)
    return f"guest:{guest['name']}" if guest else None


def _source(request: Request) -> Optional[str]:
    client = request.scope.get("client")
    ip = client[0] if client else None
    return None if ip in (None, UNKNOWN_CLIENT) else ip


class GuestRequestCreate(BaseModel):
    name: str
    device_id: str


class GuestApprove(BaseModel):
    vaults: dict[str, list[str]]
    ttl_days: Optional[int] = None


def create_request(payload: GuestRequestCreate, request: Request):
    try:
        return guest_access.requests.create(payload.name, payload.device_id, _source(request))
    except guest_access.RateLimited as e:
        raise HTTPException(status_code=429, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


def request_status(
    request_id: str,
    request: Request,
    claim: Optional[str] = Header(None, alias="X-Raven-Claim"),
    device: Optional[str] = Header(None, alias="X-Raven-Device"),
):
    got = guest_access.requests.status(request_id, claim, device, _source(request))
    if got is None:
        raise HTTPException(status_code=404, detail="Not Found")
    return got


def me(request: Request):
    guest = guest_of(request)
    if guest is None:
        raise HTTPException(status_code=404, detail="Not Found")
    grant = next((g for g in guest_access.list_grants() if g.get("id") == guest["id"]), {})
    return {"name": guest["name"], "vaults": guest["vaults"], "expires": grant.get("expires")}


def list_requests():
    return {"ok": True, "requests": guest_access.requests.pending()}


def approve(request_id: str, payload: GuestApprove):
    unknown = [n for n in payload.vaults if registry().get(n) is None]
    if unknown:
        raise HTTPException(status_code=422, detail=f"등록되지 않은 vault: {', '.join(unknown)}")
    try:
        grant_id = guest_access.requests.approve(request_id, payload.vaults, payload.ttl_days)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except guest_access.RequestStateError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"ok": True, "grant_id": grant_id}


def deny(request_id: str):
    try:
        guest_access.requests.deny(request_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except guest_access.RequestStateError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True}


def list_grants():
    return {"ok": True, "grants": guest_access.list_grants()}


def revoke(grant_id: str):
    if not guest_access.revoke_grant(grant_id):
        raise HTTPException(status_code=404, detail="Not Found")
    return {"ok": True}


def install(app: FastAPI) -> None:
    """SPA fallback(``GET /{full_path:path}``)보다 먼저 불러야 한다."""
    app.add_api_route("/api/guest/requests", create_request, methods=["POST"])
    app.add_api_route("/api/guest/requests/{request_id}", request_status, methods=["GET"])
    app.add_api_route("/api/guest/me", me, methods=["GET"])
    app.add_api_route("/api/guest/requests", list_requests, methods=["GET"])
    app.add_api_route("/api/guest/requests/{request_id}/approve", approve, methods=["POST"])
    app.add_api_route("/api/guest/requests/{request_id}/deny", deny, methods=["POST"])
    app.add_api_route("/api/guest/grants", list_grants, methods=["GET"])
    app.add_api_route("/api/guest/grants/{grant_id}", revoke, methods=["DELETE"])

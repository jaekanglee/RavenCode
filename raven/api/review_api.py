"""초안 검토 대기열 HTTP API (spec 2026-10-20-draft-review-queue-design).

두 라우트 모두 운영자 전용이다 — ``guest_routes.ROUTES``에서 ``owner``로 분류한다.
라우트는 ``install(app, vault_or_404)``이 앱에 직접 등록한다. ``guest_api``와 같은 이유로
``include_router``를 쓰지 않는다(묶음 라우트는 경로 템플릿을 게이트에 드러내지 않는다).
"""
from __future__ import annotations

from typing import Callable, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from raven.core import review
from raven.core.vault import Vault

MAX_ITEMS = 200


class ApproveItem(BaseModel):
    slug: str
    precondition: Optional[str] = None


class ApprovePayload(BaseModel):
    items: list[ApproveItem]


def install(app: FastAPI, vault_or_404: Callable[[str], Vault]) -> None:
    """SPA fallback(``GET /{full_path:path}``)보다 먼저 불러야 한다."""

    def review_queue(name: str):
        v = vault_or_404(name)
        return {"ok": True, "vault": name, "drafts": review.list_drafts(v)}

    def approve_drafts(name: str, payload: ApprovePayload):
        v = vault_or_404(name)
        if not payload.items or len(payload.items) > MAX_ITEMS:
            raise HTTPException(status_code=400, detail=f"items는 1~{MAX_ITEMS}건이어야 합니다")
        return {"ok": True, "results": review.approve(v, [i.model_dump() for i in payload.items])}

    app.add_api_route("/api/vaults/{name}/review", review_queue, methods=["GET"])
    app.add_api_route("/api/vaults/{name}/review/approve", approve_drafts, methods=["POST"])

"""손님 입장 — HTTP 흐름·게이트 판정·라우트 표 (spec 2026-10-16-guest-access-design).

손님은 내부망 출처(``LAN``)에서 토큰 없이 입장을 요청하고, 운영자(loopback + 세션 자격 증명)가
승인하면 상태 조회로 ``rvg_`` 토큰을 받는다. 그 토큰은 기기 ID·IP가 맞고 라우트 표가 허락할 때만 통한다.
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from raven.api.server import app
from raven.core import access, guest_access, mcp_tokens
from raven.core.vault import Vault

pytestmark = pytest.mark.no_auto_auth

LOCAL = ("127.0.0.1", 50000)
LAN = ("10.10.81.12", 50000)
DEV = "d_" + "g" * 22
SESSION = "rvs_guest_test_session"
OWNER = {"Authorization": f"Bearer {SESSION}"}


@pytest.fixture
def root(tmp_path, monkeypatch):
    r = tmp_path / "vaults"
    r.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(r))
    monkeypatch.setattr(guest_access, "requests", guest_access.RequestBook())
    access.set_session_token(SESSION)  # 운영자 = 데스크톱 webview (conftest가 teardown에서 지운다)
    Vault.create("alpha", r / "alpha")
    Vault.create("beta", r / "beta")
    owner = TestClient(app, client=LOCAL, headers=OWNER)
    assert owner.post("/api/vaults/alpha/pages",
                      json={"slug": "hello", "title": "Hello", "content": "body"}).status_code == 200
    return r


def _owner() -> TestClient:
    return TestClient(app, client=LOCAL, headers=OWNER)


def _guest(token: str | None = None, peer=LAN, device=DEV) -> TestClient:
    headers = {"X-Raven-Device": device}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return TestClient(app, client=peer, headers=headers)


def _pair(vaults=None, ttl=7, name="김동료") -> str:
    """요청 → 승인 → 수령. 손님 토큰을 돌려준다."""
    g = _guest()
    r = g.post("/api/guest/requests", json={"name": name, "device_id": DEV})
    assert r.status_code == 200, r.text
    req = r.json()
    ok = _owner().post(f"/api/guest/requests/{req['request_id']}/approve",
                       json={"vaults": vaults or {"alpha": ["read", "update"]}, "ttl_days": ttl})
    assert ok.status_code == 200, ok.text
    got = g.get(f"/api/guest/requests/{req['request_id']}",
                headers={"X-Raven-Claim": req["claim_secret"]}).json()
    assert got["status"] == "approved"
    return got["token"]


# ─── 입장 흐름 ─────────────────────────────────────────────────


def test_request_is_public_and_listed_for_owner(root):
    r = _guest().post("/api/guest/requests", json={"name": "김동료", "device_id": DEV})
    assert r.status_code == 200 and set(r.json()) == {"request_id", "claim_secret", "code", "expires_in"}
    listed = _owner().get("/api/guest/requests").json()["requests"]
    assert [(x["name"], x["ip"], x["code"]) for x in listed] == [("김동료", LAN[0], r.json()["code"])]


def test_status_needs_matching_claim_device_ip(root):
    req = _guest().post("/api/guest/requests", json={"name": "김동료", "device_id": DEV}).json()
    url = f"/api/guest/requests/{req['request_id']}"
    claim = {"X-Raven-Claim": req["claim_secret"]}
    assert _guest().get(url, headers=claim).json() == {"status": "pending"}
    assert _guest().get(url, headers={"X-Raven-Claim": "x"}).status_code == 404
    assert _guest(device="d_" + "z" * 22).get(url, headers=claim).status_code == 404
    assert _guest(peer=("10.10.81.99", 1)).get(url, headers=claim).status_code == 404


def test_request_validation_and_rate_limit(root):
    g = _guest()
    assert g.post("/api/guest/requests", json={"name": "", "device_id": DEV}).status_code == 422
    assert g.post("/api/guest/requests", json={"name": "a", "device_id": "bad"}).status_code == 422
    for _ in range(3):
        assert g.post("/api/guest/requests", json={"name": "a", "device_id": DEV}).status_code == 200
    assert g.post("/api/guest/requests", json={"name": "a", "device_id": DEV}).status_code == 429


def test_approve_validation(root):
    req = _guest().post("/api/guest/requests", json={"name": "김동료", "device_id": DEV}).json()
    url = f"/api/guest/requests/{req['request_id']}/approve"
    o = _owner()
    assert o.post(url, json={"vaults": {"nope": ["read"]}, "ttl_days": 7}).status_code == 422
    assert o.post(url, json={"vaults": {"alpha": ["delete"]}, "ttl_days": 7}).status_code == 422
    assert o.post(url, json={"vaults": {"alpha": ["read"]}, "ttl_days": 3}).status_code == 422
    assert o.post("/api/guest/requests/nope/approve",
                  json={"vaults": {"alpha": ["read"]}, "ttl_days": 7}).status_code == 404
    assert o.post(f"/api/guest/requests/{req['request_id']}/deny").status_code == 200
    assert o.post(url, json={"vaults": {"alpha": ["read"]}, "ttl_days": 7}).status_code == 409


# ─── 판정 ──────────────────────────────────────────────────────


def test_guest_permissions(root):
    t = _pair({"alpha": ["read", "update"]})
    g = _guest(t)
    assert g.get("/api/guest/me").json()["vaults"] == {"alpha": ["read", "update"]}
    assert [v["name"] for v in g.get("/api/vaults").json()["vaults"]] == ["alpha"]
    assert g.get("/api/vaults/alpha/pages").status_code == 200
    assert g.get("/api/vaults/alpha/pages/content/hello").status_code == 200

    denied = g.get("/api/vaults/beta/pages")
    assert denied.status_code == 403 and denied.json()["need"] == "read"
    assert g.post("/api/vaults/alpha/pages",
                  json={"slug": "x", "title": "X", "content": ""}).json()["need"] == "create"
    assert g.delete("/api/vaults/alpha/pages/content/hello").status_code == 403
    for method, path in [("GET", "/api/system/info"), ("GET", "/api/guest/requests"),
                         ("GET", "/api/guest/grants"), ("POST", "/api/vaults/alpha/build"),
                         ("POST", "/api/vaults/alpha/select"), ("GET", "/api/vaults/alpha/git/status")]:
        assert g.request(method, path).status_code == 403, path


def test_guest_write_is_logged_as_guest(root):
    t = _pair({"alpha": ["read", "update"]})
    g = _guest(t)
    page = g.get("/api/vaults/alpha/pages/content/hello").json()
    r = g.put("/api/vaults/alpha/pages/content/hello",
              json={"content": "edited", "title": "Hello", "precondition": page.get("precondition")})
    assert r.status_code == 200, r.text
    r = g.post("/api/vaults/alpha/pages/content/hello/feedback", json={"feedback": "봐주세요", "actor": "user"})
    assert r.status_code == 200, r.text
    text = (root / "alpha" / "content" / "hello.md").read_text(encoding="utf-8")
    assert "(guest:김동료)**: 봐주세요" in text and "(user)" not in text
    log = (root / "alpha" / "log.md").read_text(encoding="utf-8")
    assert "actor=guest:김동료" in log


def test_owner_writes_unchanged(root):
    r = _owner().post("/api/vaults/alpha/pages/content/hello/feedback", json={"feedback": "hi", "actor": "user"})
    assert r.status_code == 200
    assert "(user)**: hi" in (root / "alpha" / "content" / "hello.md").read_text(encoding="utf-8")
    assert len(_owner().get("/api/vaults").json()["vaults"]) == 2


@pytest.mark.parametrize("change,reason", [
    ({"peer": ("10.10.81.99", 1)}, "ip_changed"),
    ({"device": "d_" + "z" * 22}, "device_mismatch"),
])
def test_bound_to_device_and_ip(root, change, reason):
    t = _pair()
    r = _guest(t, **change).get("/api/vaults/alpha/pages")
    assert r.status_code == 401 and r.json()["reason"] == reason


def test_revoked(root):
    t = _pair()
    gid = _owner().get("/api/guest/grants").json()["grants"][0]["id"]
    assert "sha256" not in _owner().get("/api/guest/grants").json()["grants"][0]
    assert _owner().delete(f"/api/guest/grants/{gid}").status_code == 200
    r = _guest(t).get("/api/vaults/alpha/pages")
    assert r.status_code == 401 and r.json()["reason"] == "revoked"


def test_guest_token_from_loopback_still_checks_ip(root):
    t = _pair()
    r = _guest(t, peer=LOCAL).get("/api/vaults/alpha/pages")
    assert r.status_code == 401 and r.json()["reason"] == "ip_changed"


def test_me_is_guest_only(root):
    assert _owner().get("/api/guest/me").status_code == 404


def test_guest_token_rejected_by_mcp(root):
    from raven.mcp.auth import LanTokenAuth

    t = _pair()
    reached: list[bool] = []

    async def stub(scope, receive, send):
        reached.append(True)
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def go():
        transport = httpx.ASGITransport(app=LanTokenAuth(stub), client=LAN)
        async with httpx.AsyncClient(transport=transport, base_url="http://x") as c:
            return await c.post("/mcp", headers={"Authorization": f"Bearer {t}", "X-Raven-Device": DEV})

    assert asyncio.run(go()).status_code == 401 and not reached


def test_agent_token_unaffected(root):
    tok = mcp_tokens.add_token("agent")
    r = TestClient(app, client=LAN, headers={"Authorization": f"Bearer {tok}"}).get("/api/guest/requests")
    assert r.status_code == 200


# ─── 라우트 표 ─────────────────────────────────────────────────


def test_every_route_is_classified():
    from raven.api.guest_routes import ROUTES

    missing = []
    # include_router의 묶음(_IncludedRouter)은 경로를 드러내지 않아 표로 판정할 수 없다
    assert all(hasattr(route, "path") for route in app.routes)
    for route in app.routes:
        for method in getattr(route, "methods", None) or ():
            if method == "HEAD":
                continue
            if (method, route.path) not in ROUTES:
                missing.append(f"{method} {route.path}")
    assert not missing, "guest_routes.ROUTES에 분류를 추가하세요: " + ", ".join(missing)


def test_no_delete_route_is_open_to_guests():
    from raven.api.guest_routes import ROUTES

    assert all(perm == "owner" for (m, _), perm in ROUTES.items() if m == "DELETE")

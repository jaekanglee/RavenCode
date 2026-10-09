"""MCP 내부망 토큰 인증 (v0.7.182 §31, ADR 2026-09-30).

MCP는 내부망(LAN)까지 열리되, loopback이 아닌 출처(tailnet 포함, Issue #26)는
`Authorization: Bearer <token>`이 맞아야 통과한다.

Contract:
  1. 토큰 파일(`<VAULTS_ROOT>/.mcp-tokens.json`)에는 해시만 — 평문 ❌, 권한 0600
  2. add → 평문은 한 번만 반환, 같은 이름 중복 ❌, revoke → 즉시 무효
  3. loopback 출처만 토큰 없이 통과. tailnet(100.64.0.0/10, fd7a:115c:a1e0::/48)도 토큰 필요 (#26)
  4. 내부망 출처: 토큰 없음/틀림 → 401, 맞으면 통과. 발급 0개면 전부 401
  5. 파일은 요청마다 다시 읽는다 — revoke가 재시작 없이 반영
  6. 데스크톱 MCP 기본 바인딩 = 0.0.0.0 (API가 0.0.0.0일 때), 광고 주소는 접속 가능한 IP,
     앱은 LanTokenAuth로 감싼다 (#26부터 standalone raven.mcp.cli·team·Docker도 — test_mcp_remote_auth.py)
  7. CLI `raven mcp token add/list/revoke`
"""
from __future__ import annotations

import asyncio
import json
import stat

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from typer.testing import CliRunner

from raven.core import mcp_tokens as auth
from raven.mcp.auth import LanTokenAuth


@pytest.fixture
def vaults_root(tmp_path, monkeypatch):
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path))
    return tmp_path


def _inner_app() -> Starlette:
    async def ok(_request):
        return PlainTextResponse("ok")

    return Starlette(routes=[Route("/mcp", ok, methods=["GET", "POST"])])


def _request(client_ip: str, headers: dict[str, str] | None = None) -> httpx.Response:
    transport = httpx.ASGITransport(app=LanTokenAuth(_inner_app()), client=(client_ip, 50000))

    async def go() -> httpx.Response:
        async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
            return await c.post("/mcp", headers=headers or {})

    return asyncio.run(go())


# ─── 1-2. 토큰 저장소 ────────────────────────────────────────


def test_add_returns_plaintext_once_and_stores_only_hash(vaults_root):
    token = auth.add_token("민수-노트북")

    assert token.startswith("rvn_") and len(token) > 30
    path = vaults_root / ".mcp-tokens.json"
    raw = path.read_text(encoding="utf-8")
    assert token not in raw
    entry = json.loads(raw)["tokens"][0]
    assert entry["name"] == "민수-노트북"
    assert "sha256" in entry and "created" in entry
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_duplicate_name_is_rejected(vaults_root):
    auth.add_token("a")
    with pytest.raises(ValueError):
        auth.add_token("a")


def test_verify_and_revoke(vaults_root):
    token = auth.add_token("a")
    assert auth.verify_token(token) is True
    assert auth.verify_token(token + "x") is False

    assert auth.revoke_token("a") is True
    assert auth.verify_token(token) is False
    assert auth.revoke_token("a") is False
    assert auth.list_tokens() == []


# ─── 3-5. 미들웨어 ───────────────────────────────────────────


@pytest.mark.parametrize("ip", ["127.0.0.1", "::1"])
def test_loopback_passes_without_token(vaults_root, ip):
    assert _request(ip).status_code == 200


@pytest.mark.parametrize("ip", ["100.116.203.33", "100.64.0.1", "fd7a:115c:a1e0::1"])
def test_tailnet_needs_a_token_too(vaults_root, ip):
    """Issue #26: route-judged tailnet peers are no longer trusted without a token."""
    assert _request(ip).status_code == 401
    token = auth.add_token(f"t-{abs(hash(ip))}")
    assert _request(ip, {"Authorization": f"Bearer {token}"}).status_code == 200


def test_lan_without_any_issued_token_is_rejected(vaults_root):
    res = _request("192.168.0.10")
    assert res.status_code == 401
    assert res.headers["www-authenticate"].startswith("Bearer")


def test_lan_requires_valid_bearer(vaults_root):
    token = auth.add_token("a")

    assert _request("192.168.0.10").status_code == 401
    assert _request("192.168.0.10", {"Authorization": "Bearer wrong"}).status_code == 401
    assert _request("192.168.0.10", {"Authorization": token}).status_code == 401
    assert _request("192.168.0.10", {"Authorization": f"Bearer {token}"}).status_code == 200


def test_revoke_takes_effect_without_restart(vaults_root):
    token = auth.add_token("a")
    headers = {"Authorization": f"Bearer {token}"}
    assert _request("10.0.0.7", headers).status_code == 200

    auth.revoke_token("a")
    assert _request("10.0.0.7", headers).status_code == 401


def test_lan_range_just_outside_tailnet_is_not_trusted(vaults_root):
    # 100.64.0.0/10 = 100.64.0.0 ~ 100.127.255.255
    assert _request("100.128.0.1").status_code == 401


# ─── 6. 데스크톱 바인딩 ──────────────────────────────────────


def test_desktop_mcp_binds_all_interfaces_when_api_is_lan_wide():
    from raven.desktop.runtime import _resolve_mcp_host

    assert _resolve_mcp_host(None, "0.0.0.0") == "0.0.0.0"
    assert _resolve_mcp_host(None, "127.0.0.1") == "127.0.0.1"
    assert _resolve_mcp_host("100.116.203.33", "0.0.0.0") == "100.116.203.33"


def test_advertised_mcp_host_is_connectable(monkeypatch):
    from raven.desktop import runtime

    monkeypatch.setattr("raven.api.main.get_tailscale_ip", lambda: "100.116.203.33")
    assert runtime._advertised_mcp_host("0.0.0.0") == "100.116.203.33"
    monkeypatch.setattr("raven.api.main.get_tailscale_ip", lambda: None)
    assert runtime._advertised_mcp_host("0.0.0.0") == "127.0.0.1"
    assert runtime._advertised_mcp_host("10.0.0.5") == "10.0.0.5"


def test_desktop_mcp_app_is_wrapped_in_lan_token_auth(vaults_root):
    from raven.desktop.runtime import _build_mcp_app

    assert isinstance(_build_mcp_app("read", "0.0.0.0"), LanTokenAuth)


# ─── 7. CLI ──────────────────────────────────────────────────


def test_cli_token_add_list_revoke(vaults_root):
    from raven.cli.__main__ import app

    runner = CliRunner()
    added = runner.invoke(app, ["mcp", "token", "add", "민수-노트북"])
    assert added.exit_code == 0, added.output
    token = next(w for w in added.output.split() if w.startswith("rvn_"))
    assert auth.verify_token(token)

    listed = runner.invoke(app, ["mcp", "token", "list"])
    assert listed.exit_code == 0
    assert "민수-노트북" in listed.output
    assert token not in listed.output

    dup = runner.invoke(app, ["mcp", "token", "add", "민수-노트북"])
    assert dup.exit_code == 1

    revoked = runner.invoke(app, ["mcp", "token", "revoke", "민수-노트북"])
    assert revoked.exit_code == 0
    assert not auth.verify_token(token)
    assert runner.invoke(app, ["mcp", "token", "revoke", "민수-노트북"]).exit_code == 1

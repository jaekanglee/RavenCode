"""손님 입장 저장소·요청 흐름 (spec 2026-10-16-guest-access-design).

grant 파일(``<VAULTS_ROOT>/.guest-grants.json``)과 메모리의 입장 요청. 게이트·HTTP는
``test_guest_gate.py``에서 본다.
"""
from __future__ import annotations

import json
import os
import stat
from datetime import datetime, timedelta, timezone

import pytest

from raven.core import guest_access as ga

T0 = datetime(2026, 10, 16, 9, 0, tzinfo=timezone.utc)
DEV = "d_" + "a" * 22
DEV2 = "d_" + "b" * 22
IP = "10.10.81.12"


@pytest.fixture
def root(tmp_path, monkeypatch):
    r = tmp_path / "vaults"
    r.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(r))
    return r


def _issue(**kw):
    args = dict(name="김동료", device_id=DEV, ip=IP, vaults={"rider-app": ["read"]},
                ttl_days=30, now=T0)
    args.update(kw)
    return ga.issue_grant(**args)


# ─── 권한 정규화 ────────────────────────────────────────────────


def test_create_or_update_implies_read():
    assert ga.normalize_vaults({"a": ["update"], "b": ["create", "read"]}) == {
        "a": ["read", "update"], "b": ["read", "create"]}


@pytest.mark.parametrize("bad", [
    {}, {"a": []}, {"a": ["delete"]}, {"a": "read"}, {"": ["read"]}, [], None,
])
def test_invalid_vault_perms_rejected(bad):
    with pytest.raises(ValueError):
        ga.normalize_vaults(bad)


# ─── grant 저장소 ──────────────────────────────────────────────


def test_issue_stores_only_hash_with_0600(root):
    gid, token = _issue()
    assert token.startswith("rvg_") and gid.startswith("g_")
    raw = (root / ".guest-grants.json").read_text(encoding="utf-8")
    assert token not in raw
    assert stat.S_IMODE(os.stat(root / ".guest-grants.json").st_mode) == 0o600
    g = json.loads(raw)["grants"][0]
    assert g["device_id"] == DEV and g["ip"] == IP and g["vaults"] == {"rider-app": ["read"]}
    assert g["expires"] == (T0 + timedelta(days=30)).isoformat(timespec="seconds")


def test_check_ok_and_each_reason(root):
    _, token = _issue()
    g, reason = ga.check_grant(token, DEV, IP, now=T0)
    assert reason is None and g["name"] == "김동료"
    assert ga.check_grant("rvg_nope", DEV, IP, now=T0) == (None, "revoked")
    assert ga.check_grant(token, DEV2, IP, now=T0)[1] == "device_mismatch"
    assert ga.check_grant(token, None, IP, now=T0)[1] == "device_mismatch"
    assert ga.check_grant(token, DEV, "10.10.81.99", now=T0)[1] == "ip_changed"
    assert ga.check_grant(token, DEV, None, now=T0)[1] == "ip_changed"
    assert ga.check_grant(token, DEV, IP, now=T0 + timedelta(days=31))[1] == "expired"


def test_unlimited_ttl_never_expires(root):
    _, token = _issue(ttl_days=None)
    assert ga.check_grant(token, DEV, IP, now=T0 + timedelta(days=3650))[1] is None


@pytest.mark.parametrize("ttl", [0, 1, 365, "30"])
def test_ttl_must_be_7_30_or_none(root, ttl):
    with pytest.raises(ValueError):
        _issue(ttl_days=ttl)


def test_same_device_replaces_old_grant(root):
    _, old = _issue()
    _, new = _issue(ip="10.10.81.50")
    assert ga.check_grant(old, DEV, IP, now=T0)[1] == "revoked"
    assert ga.check_grant(new, DEV, "10.10.81.50", now=T0)[1] is None
    assert len(ga.list_grants()) == 1


def test_list_hides_hash_and_revoke(root):
    gid, token = _issue()
    listed = ga.list_grants()
    assert "sha256" not in listed[0] and listed[0]["id"] == gid
    assert ga.revoke_grant(gid) is True
    assert ga.revoke_grant(gid) is False
    assert ga.check_grant(token, DEV, IP, now=T0)[1] == "revoked"


def test_corrupt_file_rejects_every_guest(root):
    _, token = _issue()
    (root / ".guest-grants.json").write_text("{not json", encoding="utf-8")
    assert ga.check_grant(token, DEV, IP, now=T0) == (None, "revoked")


def test_last_seen_written_at_most_hourly(root):
    _, token = _issue()
    ga.check_grant(token, DEV, IP, now=T0 + timedelta(minutes=5))
    first = ga.list_grants()[0]["last_seen"]
    ga.check_grant(token, DEV, IP, now=T0 + timedelta(minutes=30))
    assert ga.list_grants()[0]["last_seen"] == first
    ga.check_grant(token, DEV, IP, now=T0 + timedelta(minutes=70))
    assert ga.list_grants()[0]["last_seen"] != first


# ─── 입장 요청 ─────────────────────────────────────────────────


@pytest.fixture
def book(root):
    events: list[dict] = []
    return ga.RequestBook(emit=events.append), events


def test_request_approve_claim_once(book):
    b, events = book
    r = b.create("김동료", DEV, IP, now=T0)
    assert set(r) == {"request_id", "claim_secret", "code", "expires_in"}
    assert events == [{"event": "guest_request", "name": "김동료", "ip": IP, "code": r["code"]}]
    rid, secret = r["request_id"], r["claim_secret"]
    assert b.status(rid, secret, DEV, IP, now=T0) == {"status": "pending"}
    assert [p["request_id"] for p in b.pending(now=T0)] == [rid]
    assert "claim_secret" not in b.pending(now=T0)[0]

    b.approve(rid, {"rider-app": ["update"]}, 7, now=T0)
    got = b.status(rid, secret, DEV, IP, now=T0)
    assert got["status"] == "approved" and got["token"].startswith("rvg_")
    assert b.status(rid, secret, DEV, IP, now=T0) == {"status": "claimed"}
    g, reason = ga.check_grant(got["token"], DEV, IP, now=T0)
    assert reason is None and g["vaults"] == {"rider-app": ["read", "update"]}


@pytest.mark.parametrize("who", [
    ("wrong-secret", DEV, IP), (None, DEV2, IP), (None, DEV, "10.10.81.99"),
])
def test_status_hidden_unless_secret_device_ip_match(book, who):
    b, _ = book
    r = b.create("김동료", DEV, IP, now=T0)
    secret = who[0] or r["claim_secret"]
    assert b.status(r["request_id"], secret, who[1], who[2], now=T0) is None
    assert b.status("nope", r["claim_secret"], DEV, IP, now=T0) is None


def test_deny(book):
    b, _ = book
    r = b.create("김동료", DEV, IP, now=T0)
    b.deny(r["request_id"], now=T0)
    assert b.status(r["request_id"], r["claim_secret"], DEV, IP, now=T0) == {"status": "denied"}
    with pytest.raises(ga.RequestStateError):
        b.approve(r["request_id"], {"a": ["read"]}, 7, now=T0)
    with pytest.raises(LookupError):
        b.deny("nope", now=T0)


def test_pending_expires_after_10_minutes(book):
    b, _ = book
    r = b.create("김동료", DEV, IP, now=T0)
    later = T0 + timedelta(minutes=11)
    assert b.status(r["request_id"], r["claim_secret"], DEV, IP, now=later) == {"status": "expired"}
    assert b.pending(now=later) == []
    with pytest.raises(ga.RequestStateError):
        b.approve(r["request_id"], {"a": ["read"]}, 7, now=later)


def test_unclaimed_approval_expires_and_drops_grant(book):
    b, _ = book
    r = b.create("김동료", DEV, IP, now=T0)
    b.approve(r["request_id"], {"a": ["read"]}, 7, now=T0 + timedelta(minutes=5))
    later = T0 + timedelta(minutes=16)
    assert b.status(r["request_id"], r["claim_secret"], DEV, IP, now=later) == {"status": "expired"}
    assert ga.list_grants() == []


def test_approve_validates_payload(book):
    b, _ = book
    r = b.create("김동료", DEV, IP, now=T0)
    with pytest.raises(ValueError):
        b.approve(r["request_id"], {"a": ["delete"]}, 7, now=T0)
    with pytest.raises(ValueError):
        b.approve(r["request_id"], {"a": ["read"]}, 3, now=T0)
    # 실패한 승인은 요청을 소비하지 않는다
    b.approve(r["request_id"], {"a": ["read"]}, None, now=T0)


@pytest.mark.parametrize("name,dev", [
    ("", DEV), ("   ", DEV), ("x" * 41, DEV), ("김동료", "bad"), ("김동료", "d_short"),
    ("김동료", None), ("a\x00b", DEV),
])
def test_create_validates_input(book, name, dev):
    b, _ = book
    with pytest.raises(ValueError):
        b.create(name, dev, IP, now=T0)


def test_create_needs_known_source(book):
    b, _ = book
    with pytest.raises(ValueError):
        b.create("김동료", DEV, None, now=T0)


def test_rate_limit_per_ip_and_total(book):
    b, _ = book
    for _ in range(3):
        b.create("김동료", DEV, IP, now=T0)
    with pytest.raises(ga.RateLimited):
        b.create("김동료", DEV, IP, now=T0 + timedelta(seconds=30))
    b.create("김동료", DEV, IP, now=T0 + timedelta(seconds=61))
    for i in range(16):
        b.create("x", DEV, f"10.0.0.{i}", now=T0 + timedelta(seconds=61))
    with pytest.raises(ga.RateLimited):
        b.create("x", DEV, "10.0.1.1", now=T0 + timedelta(seconds=61))


def test_code_shape(book):
    b, _ = book
    code = b.create("김동료", DEV, IP, now=T0)["code"]
    assert len(code) == 5 and code[2] == "-"
    assert not set(code) & set("0O1I")

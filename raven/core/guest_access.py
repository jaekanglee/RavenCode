"""내부망 손님 입장 — 승인된 기기(grant) 저장소와 입장 요청 (spec 2026-10-16-guest-access-design).

손님이 대시보드에서 입장을 요청하면(``RequestBook.create``) 운영자가 데스크톱 앱에서 승인하고,
요청한 브라우저가 상태 조회로 토큰을 한 번 받아 간다. 토큰은 승인 때 기록한 기기 ID와 출처 IP가
모두 맞을 때만 통한다(``check_grant``). vault별 권한은 ``read`` / ``create`` / ``update``이고
삭제·관리는 운영자 몫이다 — 라우트 판정은 ``raven/api/guest_routes.py``.

grant 파일(``<VAULTS_ROOT>/.guest-grants.json``, 0600)에는 ``mcp_tokens``처럼 SHA-256 해시만 둔다.
호출마다 다시 읽어 revoke가 재시작 없이 반영된다. 파일이 깨지면 빈 목록 — 모든 손님 거부.
입장 요청은 메모리에만 있다(재시작하면 사라지고 다시 요청하면 된다).

손님 토큰은 MCP에서 통하지 않는다: MCP 게이트는 이 저장소를 읽지 않는다.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

from raven.core.access import GUEST_TOKEN_PREFIX as TOKEN_PREFIX
from raven.core.registry import VAULTS_ROOT

PERMS = ("read", "create", "update")
TTL_CHOICES = (7, 30, None)

REQUEST_TTL = timedelta(minutes=10)   # 승인 대기, 그리고 승인 후 수령 대기
LAST_SEEN_EVERY = timedelta(hours=1)
MAX_PENDING = 20
PER_IP_PER_MINUTE = 3
NAME_MAX = 40
_DEVICE_RE = re.compile(r"^d_[A-Za-z0-9_-]{22,64}$")
_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"  # 0/O/1/I 제외

_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: datetime) -> str:
    return t.isoformat(timespec="seconds")


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


# ─── 권한 ──────────────────────────────────────────────────────


def normalize_vaults(vaults) -> dict[str, list[str]]:
    """``{vault: [perm, ...]}`` 검증. ``create``·``update``는 ``read``를 포함한다."""
    if not isinstance(vaults, dict) or not vaults:
        raise ValueError("vaults는 비어 있지 않은 {vault: [권한]} 이어야 합니다")
    out: dict[str, list[str]] = {}
    for name, perms in vaults.items():
        if not isinstance(name, str) or not name.strip():
            raise ValueError("vault 이름이 비었습니다")
        if not isinstance(perms, list) or not perms or any(p not in PERMS for p in perms):
            raise ValueError(f"{name}: 권한은 {', '.join(PERMS)} 중에서 골라야 합니다")
        chosen = set(perms) | {"read"}
        out[name] = [p for p in PERMS if p in chosen]
    return out


# ─── grant 저장소 ──────────────────────────────────────────────


def grants_path() -> Path:
    return VAULTS_ROOT() / ".guest-grants.json"


def _load() -> list[dict]:
    try:
        data = json.loads(grants_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        print(f"Raven: 손님 grant 파일을 읽을 수 없어 모든 손님을 거부합니다: {exc}", file=sys.stderr)
        return []
    grants = data.get("grants", []) if isinstance(data, dict) else []
    return [g for g in grants if isinstance(g, dict)]


def _save(grants: list[dict]) -> None:
    path = grants_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"grants": grants}, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def issue_grant(*, name: str, device_id: str, ip: str, vaults, ttl_days,
                now: Optional[datetime] = None) -> tuple[str, str]:
    """grant를 만들고 ``(grant_id, 평문 토큰)``을 돌려준다. 같은 기기의 이전 grant는 교체된다."""
    if ttl_days not in TTL_CHOICES or isinstance(ttl_days, bool):
        raise ValueError("기간은 7일, 30일, 무기한(null) 중 하나입니다")
    perms = normalize_vaults(vaults)
    now = now or _now()
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    grant = {
        "id": "g_" + secrets.token_hex(8),
        "name": name,
        "sha256": _hash(token),
        "device_id": device_id,
        "ip": ip,
        "vaults": perms,
        "created": _iso(now),
        "expires": _iso(now + timedelta(days=ttl_days)) if ttl_days else None,
        "last_seen": None,
    }
    with _lock:
        grants = [g for g in _load() if g.get("device_id") != device_id]
        grants.append(grant)
        _save(grants)
    return grant["id"], token


def list_grants() -> list[dict]:
    """승인된 기기 목록 (해시는 내보내지 않는다)."""
    return [{k: v for k, v in g.items() if k != "sha256"} for g in _load()]


def revoke_grant(grant_id: str) -> bool:
    with _lock:
        grants = _load()
        kept = [g for g in grants if g.get("id") != grant_id]
        if len(kept) == len(grants):
            return False
        _save(kept)
        return True


def check_grant(token: str, device_id: Optional[str], ip: Optional[str],
                now: Optional[datetime] = None) -> tuple[Optional[dict], Optional[str]]:
    """``(grant, None)`` 또는 ``(None|grant, 이유)``. 이유: revoked/expired/device_mismatch/ip_changed."""
    now = now or _now()
    digest = _hash(token)
    grant = next((g for g in _load() if hmac.compare_digest(digest, str(g.get("sha256", "")))), None)
    if grant is None:
        return None, "revoked"
    expires = grant.get("expires")
    if expires and now >= datetime.fromisoformat(expires):
        return None, "expired"
    if not device_id or not hmac.compare_digest(str(device_id), str(grant.get("device_id", ""))):
        return None, "device_mismatch"
    if not ip or ip != grant.get("ip"):
        return None, "ip_changed"
    _touch(grant, now)
    return {k: v for k, v in grant.items() if k != "sha256"}, None


def _touch(grant: dict, now: datetime) -> None:
    seen = grant.get("last_seen")
    if seen and now - datetime.fromisoformat(seen) < LAST_SEEN_EVERY:
        return
    with _lock:
        grants = _load()
        for g in grants:
            if g.get("id") == grant.get("id"):
                g["last_seen"] = _iso(now)
                _save(grants)
                return


# ─── 입장 요청 (메모리) ─────────────────────────────────────────


class RateLimited(Exception):
    """요청이 너무 많다 (IP당 1분 3건, 또는 대기 20건)."""


class RequestStateError(Exception):
    """이미 처리됐거나 만료된 요청."""


def _clean_name(name) -> str:
    if not isinstance(name, str):
        raise ValueError("이름을 입력해 주세요")
    name = name.strip()
    if not name or len(name) > NAME_MAX or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError(f"이름은 1~{NAME_MAX}자로 입력해 주세요")
    return name


class RequestBook:
    """프로세스 안의 입장 요청. 승인되면 grant를 만들고 평문 토큰을 수령 전까지만 쥐고 있는다."""

    def __init__(self, emit: Optional[Callable[[dict], None]] = None) -> None:
        self.emit = emit
        self._lock = threading.Lock()
        self._items: dict[str, dict] = {}
        self._recent: list[tuple[datetime, str]] = []

    def _sweep(self, now: datetime) -> None:
        for r in self._items.values():
            if r["status"] == "pending" and now - r["created"] >= REQUEST_TTL:
                r["status"] = "expired"
            elif r["status"] == "approved" and now - r["approved"] >= REQUEST_TTL:
                r["status"] = "expired"
                r["token"] = None
                revoke_grant(r["grant_id"])
        # 끝난 요청은 한 번 더 TTL만큼 상태 조회에 답하고 지운다
        self._items = {k: r for k, r in self._items.items()
                       if r["status"] in ("pending", "approved") or now - r["created"] < 3 * REQUEST_TTL}
        self._recent = [(t, ip) for t, ip in self._recent if now - t < timedelta(minutes=1)]

    def create(self, name, device_id, ip: Optional[str], now: Optional[datetime] = None) -> dict:
        now = now or _now()
        name = _clean_name(name)
        if not isinstance(device_id, str) or not _DEVICE_RE.match(device_id):
            raise ValueError("기기 ID 형식이 올바르지 않습니다")
        if not ip:
            raise ValueError("요청 출처를 확인할 수 없습니다")
        with self._lock:
            self._sweep(now)
            if sum(1 for _, i in self._recent if i == ip) >= PER_IP_PER_MINUTE:
                raise RateLimited("잠시 후 다시 시도해 주세요")
            if sum(1 for r in self._items.values() if r["status"] == "pending") >= MAX_PENDING:
                raise RateLimited("대기 중인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요")
            rid = secrets.token_urlsafe(16)
            secret = secrets.token_urlsafe(32)
            code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(4))
            code = f"{code[:2]}-{code[2:]}"
            self._items[rid] = {
                "request_id": rid, "claim_sha256": _hash(secret), "name": name,
                "device_id": device_id, "ip": ip, "code": code, "created": now,
                "status": "pending", "approved": None, "grant_id": None, "token": None,
            }
            self._recent.append((now, ip))
        if self.emit is not None:
            self.emit({"event": "guest_request", "name": name, "ip": ip, "code": code})
        return {"request_id": rid, "claim_secret": secret, "code": code,
                "expires_in": int(REQUEST_TTL.total_seconds())}

    def status(self, request_id: str, claim_secret: Optional[str], device_id: Optional[str],
               ip: Optional[str], now: Optional[datetime] = None) -> Optional[dict]:
        """요청자 본인일 때만 상태를 준다 (아니면 None → 404). 승인 후 첫 조회에서 토큰을 한 번 준다."""
        now = now or _now()
        with self._lock:
            self._sweep(now)
            r = self._items.get(request_id)
            if (r is None or not claim_secret
                    or not hmac.compare_digest(_hash(claim_secret), r["claim_sha256"])
                    or device_id != r["device_id"] or ip != r["ip"]):
                return None
            if r["status"] == "approved":
                token, r["token"], r["status"] = r["token"], None, "claimed"
                return {"status": "approved", "token": token}
            return {"status": r["status"]}

    def pending(self, now: Optional[datetime] = None) -> list[dict]:
        now = now or _now()
        with self._lock:
            self._sweep(now)
            return [{"request_id": r["request_id"], "name": r["name"], "ip": r["ip"],
                     "code": r["code"], "created": _iso(r["created"]),
                     "expires_in": max(0, int((r["created"] + REQUEST_TTL - now).total_seconds()))}
                    for r in self._items.values() if r["status"] == "pending"]

    def _pending_or_raise(self, request_id: str, now: datetime) -> dict:
        self._sweep(now)
        r = self._items.get(request_id)
        if r is None:
            raise LookupError("요청을 찾을 수 없습니다")
        if r["status"] != "pending":
            raise RequestStateError(f"이미 처리된 요청입니다 ({r['status']})")
        return r

    def approve(self, request_id: str, vaults, ttl_days, now: Optional[datetime] = None) -> str:
        now = now or _now()
        with self._lock:
            r = self._pending_or_raise(request_id, now)
            gid, token = issue_grant(name=r["name"], device_id=r["device_id"], ip=r["ip"],
                                     vaults=vaults, ttl_days=ttl_days, now=now)
            r.update(status="approved", approved=now, grant_id=gid, token=token)
            return gid

    def deny(self, request_id: str, now: Optional[datetime] = None) -> None:
        now = now or _now()
        with self._lock:
            self._pending_or_raise(request_id, now)["status"] = "denied"


# 프로세스 하나에 하나. 데스크톱 런타임이 ``requests.emit``에 셸 이벤트 통로를 꽂는다.
requests = RequestBook()

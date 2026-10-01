"""MCP 내부망 접근 토큰 저장소 (ADR 2026-09-30 mcp-lan-token-auth).

``raven mcp token add/list/revoke`` (CLI)와 MCP 인증 미들웨어(``raven.mcp.auth``)가
같이 쓴다. 파일(``<VAULTS_ROOT>/.mcp-tokens.json``, 0600)에는 SHA-256 해시만 둔다 —
평문은 add 때 한 번만 돌려준다. 호출할 때마다 파일을 다시 읽어 revoke가
재시작 없이 반영된다.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path

from raven.core.registry import VAULTS_ROOT

TOKEN_PREFIX = "rvn_"


def tokens_path() -> Path:
    return VAULTS_ROOT() / ".mcp-tokens.json"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _load() -> list[dict]:
    try:
        data = json.loads(tokens_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    return [t for t in data.get("tokens", []) if isinstance(t, dict)]


def _save(tokens: list[dict]) -> None:
    path = tokens_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"tokens": tokens}, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def add_token(name: str) -> str:
    """새 토큰을 발급하고 평문을 돌려준다 (다시 볼 수 없다)."""
    tokens = _load()
    if any(t.get("name") == name for t in tokens):
        raise ValueError(f"이미 있는 토큰 이름입니다: {name}")
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    tokens.append({
        "name": name,
        "sha256": _hash(token),
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    _save(tokens)
    return token


def list_tokens() -> list[dict]:
    """이름·발급일만 (해시는 내보내지 않는다)."""
    return [{"name": t.get("name", ""), "created": t.get("created", "")} for t in _load()]


def revoke_token(name: str) -> bool:
    tokens = _load()
    kept = [t for t in tokens if t.get("name") != name]
    if len(kept) == len(tokens):
        return False
    _save(kept)
    return True


def verify_token(token: str) -> bool:
    digest = _hash(token)
    return any(hmac.compare_digest(digest, t.get("sha256", "")) for t in _load())

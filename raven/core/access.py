"""Core API · MCP 공용 접근 정책 (Issue #14).

Raven API에는 계정이 없다. 대신 **요청이 어디서 왔는지**(소켓 주소)와 vault owner가
발급한 토큰으로 판정한다. 데스크톱 런타임, ``python -m raven.api``,
``uvicorn raven.api:app`` 어느 경로로 띄워도 같은 판정이 나오도록, 게이트는 실행기가
아니라 앱 자체(``raven/api/server.py``)에 붙는다. MCP(``raven.mcp.auth``)도 같은 판정을 쓴다.

판정 (Issue #67부터): **모든 출처에 ``Authorization: Bearer <token>``** — loopback, tailnet, 내부망,
Docker 모두 같다. 토큰은 ``raven mcp token add``로 발급한 것, 또는 Core API에서만 데스크톱 셸이
자기 webview에 준 실행별 세션 자격 증명(``set_session_token``)이다. 발급된 토큰이 없으면 전부 401
(fail-closed). URL query의 토큰은 읽지 않는다. 예외는 ``GET /healthz``(고정 본문)와 Core API의
대시보드 정적 파일뿐이다(``TokenGate`` 참고).

loopback을 예외로 두지 않는 이유: macOS Docker Desktop은 컨테이너의 ``host.docker.internal`` 연결을
호스트 loopback으로 넘긴다. 게이트에는 peer ``127.0.0.1``로 보이고, 컨테이너는 Host·Origin을 마음대로
쓴다. 그래서 #28의 "loopback + loopback Host/Origin이면 토큰 없이 통과"는 컨테이너가 그대로 흉내 낼 수
있었다(#67). tailnet은 #24(Core API)·#26(MCP)부터 이미 토큰 필수였다 — 라우트 판정(``is_tailnet_peer``)은
남아 있지만 그 결과로 토큰을 면제하는 게이트는 없다.

출처는 판정이 아니라 두 곳에만 쓴다: 통과한 요청의 ``scope["client"]`` 재작성(#15
``_require_loopback``의 "이 PC 전용" 검사)과 401 안내 문구. 출처를 정할 때 프록시 헤더(X-Forwarded-For /
Forwarded / X-Real-IP)는 서버 설정에 따라 다르게 다룬다 — PR #21 재리뷰 P0:

- **strict 모드 (기본)**: 게이트가 uvicorn 설정을 모르는 경우(``uvicorn raven.api:app`` 직접
  실행, gunicorn 등). uvicorn은 ``forwarded_allow_ips``가 허용하면 X-Forwarded-For로
  ``scope["client"]``를 *앱보다 먼저* 바꾼다 — ``'*'``면 LAN 기기가 ``127.0.0.1``을 사칭한다.
  그 재작성은 헤더가 있을 때만 일어나고 헤더는 남아 있으므로, **프록시 헤더가 붙은 요청은
  출처를 알 수 없는 것으로 본다**(이 PC 전용 API 403). ``forwarded_allow_ips`` 값과 무관하게 성립한다.
- **launcher 모드**: Raven 실행기(``python -m raven.api``, 데스크톱 런타임)는
  ``serve_kwargs()``로 uvicorn을 ``proxy_headers=False``로 띄운다 — ``scope["client"]``가 실제
  소켓 peer이고 ``FORWARDED_ALLOW_IPS``는 무시된다. 이때 게이트가 X-Forwarded-For를 직접
  읽되 **loopback peer(이 기기의 프록시, 예: vite ``xfwd``)가 보낸 경우만**: 오른쪽부터
  loopback hop을 건너뛰고 처음 나오는 주소가 출처다. 해석할 수 없는 항목이 있으면 출처 미상.
  비루프백 peer의 프록시 헤더, 그리고 X-Forwarded-For 외의 출처 헤더(Forwarded, X-Real-IP,
  True-Client-IP 등 ``_FORWARDING_HEADERS``)가 하나라도 있는 요청은 — X-Forwarded-For와 함께여도 —
  출처 미상 (#29: 클라이언트의 XFF를 그대로 넘기고 실제 주소는 X-Real-IP에만 쓰는 프록시).

통과한 요청의 ``scope["client"]``는 게이트가 본 실효 출처로 바뀐다(모르면 ``"unknown"``) —
``_require_loopback`` 같은 하위 가드도 같은 출처를 본다. 이 기기의 프록시가 X-Forwarded-For를
붙이지 않으면 모든 요청이 loopback으로 보이므로(이 PC 전용 API가 열린다), 앞단 프록시는 반드시
XFF를 붙여야 한다.

bind 정책도 여기 둔다 (``safe_bind_host``): 기본 loopback, 비루프백·와일드카드는
``RAVEN_ALLOW_REMOTE``가 참일 때만. 게이트가 1차 방어, bind 제한이 2차 방어다.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import threading
import time

from raven.core.mcp_tokens import verify_token

LOOPBACK_HOST = "127.0.0.1"
ALLOW_REMOTE_ENV = "RAVEN_ALLOW_REMOTE"

LOOPBACK_NETWORKS = (
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
)
# Tailscale이 노드에 주는 주소 대역 (CGNAT IPv4 + Tailscale ULA IPv6). **범위 소속만으로는
# 신뢰하지 않는다** — CGNAT은 통신사 LAN·다른 mesh VPN·사용자 Docker 망도 쓴다.
# 아래 ``is_tailnet_peer``가 라우트로 판정한다 (증명이 아니라 추론 — 아래 주석).
TAILNET_NETWORKS = (
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("fd7a:115c:a1e0::/48"),
)
TRUSTED_NETWORKS = LOOPBACK_NETWORKS + TAILNET_NETWORKS  # 하위 호환 (범위 표기용)

def _parse_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    candidate = host.strip()
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    try:
        addr = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    # IPv4-mapped IPv6 (::ffff:a.b.c.d)는 IPv4 규칙으로 판정한다.
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        return addr.ipv4_mapped
    return addr


# ─── tailnet 판정 ─────────────────────────────────────────────
#
# TCP 연결은 클라이언트가 우리 SYN-ACK를 받아야 성립한다. 커널이 그 peer 주소로 가는
# 응답을 **이 기기의 Tailscale 주소**(tailscaled가 `tailscale ip`로 알려주는 값)에서
# 내보낸다면, SYN-ACK는 Tailscale로 들어갔고 Tailscale은 그 주소를 가진 WireGuard
# 인증 노드에게만 전달한다 — 라우팅이 대칭이고 연결 이후 바뀌지 않는다는 전제에서, LAN에서
# 100.x를 사칭한 호스트는 SYN-ACK를 못 받아 연결을 끝낼 수 없다. 이 검사는 요청 시점의
# 송신 라우트를 보는 **추론**이며, 수락된 소켓의 수신 경로나 WireGuard 인증을 직접 증명하지
# 않는다 — 그래서 #24(Core API)·#26(MCP)부터 어느 게이트도 이 판정으로 토큰을 면제하지 않는다. Tailscale이 없거나(CLI·daemon 부재), 응답이 다른 인터페이스로 나가면
# (CGNAT LAN, 다른 VPN, Docker bridge) tailnet 신뢰는 없다 — 토큰 필요 (fail-closed).

_TS_TTL = 30.0
_TS_CACHE: dict[str, tuple[float, frozenset[str]]] = {}
_TS_LOCK = threading.Lock()
_TS_FALLBACK_PATHS = (
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
)


def _tailscale_binary() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    for path in _TS_FALLBACK_PATHS:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def _tailscale_self_ips() -> frozenset[str]:
    """This host's Tailscale addresses, from tailscaled itself (cached ``_TS_TTL`` s)."""
    now = time.monotonic()
    with _TS_LOCK:
        hit = _TS_CACHE.get("ips")
        if hit and now - hit[0] < _TS_TTL:
            return hit[1]
    ips: set[str] = set()
    binary = _tailscale_binary()
    if binary:
        try:
            out = subprocess.run(
                [binary, "ip"], capture_output=True, text=True, timeout=2, check=False,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            out = ""
        for line in out.splitlines():
            addr = _parse_ip(line)
            if addr is not None and any(addr in net for net in TAILNET_NETWORKS):
                ips.add(str(addr))
    result = frozenset(ips)
    with _TS_LOCK:
        _TS_CACHE["ips"] = (now, result)
    return result


def _route_source(ip: str) -> str | None:
    """Local address the kernel would send from to reach ``ip`` (no packet is sent)."""
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_DGRAM) as s:
            s.connect((ip, 9))
            source = s.getsockname()[0]
    except OSError:
        return None
    addr = _parse_ip(source.split("%", 1)[0])
    return str(addr) if addr is not None else None


def is_tailnet_peer(host: str | None) -> bool:
    """In a tailnet range *and* replies to it leave through this host's Tailscale address."""
    addr = _parse_ip(host) if host else None
    if addr is None or not any(addr in net for net in TAILNET_NETWORKS):
        return False
    self_ips = _tailscale_self_ips()
    if not self_ips:
        return False
    return _route_source(str(addr)) in self_ips


def is_loopback_client(host: str | None) -> bool:
    """loopback 출처인가 (127.0.0.0/8, ::1, IPv4-mapped). IP가 아닌 값은 신뢰하지 않는다."""
    addr = _parse_ip(host) if host else None
    return addr is not None and any(addr in net for net in LOOPBACK_NETWORKS)


def is_trusted_client(host: str | None, *, allow_tailnet: bool = True) -> bool:
    """loopback, 또는 (``allow_tailnet``이면) 라우트로 판정한 tailnet 출처인가.

    Core API(#24)와 MCP(#26) 게이트 모두 ``allow_tailnet=False``로 부른다 — 라우트 판정은
    추론이지 연결의 WireGuard 인증 증명이 아니다. ``True``를 쓰는 게이트는 없다.
    """
    if is_loopback_client(host):
        return True
    return allow_tailnet and is_tailnet_peer(host)


# Headers a proxy may use to name the original client. Only X-Forwarded-For is ever
# read (launcher mode); any of the others means some proxy put the client there, so
# the request's source cannot be told apart from the socket peer (Issue #29).
_FORWARDING_HEADERS = (
    b"x-forwarded-for",
    b"forwarded",
    b"x-real-ip",
    b"x-client-ip",
    b"true-client-ip",
    b"cf-connecting-ip",
    b"fastly-client-ip",
    b"x-cluster-client-ip",
)

# True only while Raven's own launcher serves the app with ``proxy_headers=False``
# (see ``serve_kwargs``) — then ``scope["client"]`` is the real socket peer.
_socket_peer = False

UNKNOWN_CLIENT = "unknown"


def serve_kwargs() -> dict:
    """uvicorn options for Raven's launchers: ``scope["client"]`` = socket peer.

    ``proxy_headers=False`` keeps uvicorn from rewriting the client from
    X-Forwarded-For (whatever ``FORWARDED_ALLOW_IPS`` says), which is what lets
    the gate read forwarding headers itself. In-process only — a ``--reload``
    child re-imports the app and falls back to strict mode (fail-closed).
    """
    global _socket_peer
    _socket_peer = True
    return {"proxy_headers": False}


def _parse_forwarded_entry(entry: str):
    value = entry.strip()
    if value.startswith("["):  # [v6]:port
        end = value.find("]")
        if end == -1:
            return None
        value = value[1:end]
    elif value.count(":") == 1:  # v4:port
        value = value.split(":", 1)[0]
    return _parse_ip(value)


def effective_client(scope) -> str | None:
    """The source the gate judges, or None when it cannot be known."""
    client = scope.get("client")
    peer = client[0] if client else None
    xff: list[str] = []
    other = False
    for key, value in scope.get("headers", []):
        if key == b"x-forwarded-for":
            xff.append(value.decode("latin-1"))
        elif key in _FORWARDING_HEADERS:
            other = True
    if not xff and not other:
        return peer
    if not _socket_peer:
        return None  # the server may already have rewritten the client from these headers
    # Issue #29: X-Forwarded-For is only believed alone. A proxy that also (or only)
    # names the client in Forwarded / X-Real-IP / … may have passed the client's own
    # X-Forwarded-For through untouched — e.g. nginx with just `X-Real-IP $remote_addr`.
    if not peer or not is_loopback_host(peer) or not xff or other:
        return None
    entries = ",".join(xff).split(",")
    for entry in reversed(entries):
        addr = _parse_forwarded_entry(entry)
        if addr is None:
            return None
        if not addr.is_loopback:
            return str(addr)
    return LOOPBACK_HOST


# ─── 인증 (Issue #67: loopback도 예외 없음) ─────────────────────────────

# The one request a gate answers without a token: a liveness check with a fixed body.
# It reaches no app code and says nothing about vaults, tokens or the network.
HEALTH_PATH = "/healthz"
_HEALTH_BODY = b'{"ok":true}'

# Per-launch credential of the desktop shell for its own webview (Issue #67). The shell
# generates it, hands it to this process on stdin (raven.desktop.runtime) and to the
# webview over Tauri IPC. Only its SHA-256 lives here; it is never written to disk,
# logged, put in a URL or in the readiness line.
_session_digest: bytes | None = None


def set_session_token(token: str | None) -> None:
    """Accept ``token`` as this process's desktop session credential (None clears it)."""
    global _session_digest
    _session_digest = hashlib.sha256(token.encode("utf-8")).digest() if token else None


def _bearer_token(scope) -> str | None:
    """The token of the first ``Authorization`` header if it is ``Bearer <token>``. URLs are never read."""
    for key, value in scope.get("headers", []):
        if key == b"authorization":
            scheme, _, token = value.decode("latin-1").partition(" ")
            token = token.strip()
            return token if scheme.lower() == "bearer" and token else None
    return None


# Guest tokens (raven/core/guest_access.py) — judged by the Core API's ``guest`` hook, never
# by ``verify_token``. A passed guest's grant lands in ``scope["state"][GUEST_STATE_KEY]``.
GUEST_TOKEN_PREFIX = "rvg_"
GUEST_STATE_KEY = "raven_guest"


def _is_session_token(token: str) -> bool:
    digest = _session_digest
    return digest is not None and hmac.compare_digest(hashlib.sha256(token.encode("utf-8")).digest(), digest)


def has_valid_bearer(scope, *, session_ok: bool = False) -> bool:
    """An issued token (``raven mcp token add``), or — where ``session_ok`` — the desktop session credential."""
    token = _bearer_token(scope)
    if not token:
        return False
    if session_ok and _is_session_token(token):
        return True
    return verify_token(token)


def route_path(scope) -> str:
    """The path the router matches on: ``scope["path"]`` without ``root_path`` (Starlette's rule).

    Path exceptions must be judged on this, not on ``scope["path"]``: with a root path
    (``uvicorn --root-path``, ``UVICORN_ROOT_PATH``, a mounting ASGI app) the router strips
    the prefix before matching, so a raw-path check would call an API route "not /api".
    """
    path: str = scope.get("path", "")
    root_path: str = scope.get("root_path", "") or ""
    if not root_path or not path.startswith(root_path):
        return path
    if path == root_path:
        return ""
    if path[len(root_path)] == "/":
        return path[len(root_path):]
    return path


def _is_health_check(scope) -> bool:
    return scope["type"] == "http" and scope.get("method") == "GET" and route_path(scope) == HEALTH_PATH


class TokenGate:
    """ASGI 게이트 — 모든 출처에 Bearer 토큰을 요구한다. loopback도 예외가 아니다 (Issue #67).

    macOS Docker Desktop은 컨테이너의 ``host.docker.internal`` 연결을 호스트 loopback으로 넘기고,
    컨테이너는 Host·Origin을 마음대로 쓴다. 소켓 주소와 헤더로는 같은 PC의 프로세스와 구분할 수
    없으므로 출처로 토큰을 면제하지 않는다. 예외는 둘뿐이다:

    - ``GET /healthz`` — 고정 본문(``{"ok":true}``), 앱 코드에 닿지 않는다.
    - ``public(scope)``가 참인 요청 — Core API가 서빙하는 대시보드 정적 파일(``raven/api/server.py``).
      MCP에는 없다.

    http와 websocket 둘 다 막는다(websocket은 close 1008). 거부된 요청은 감싼 앱에 전달되지 않는다.
    lifespan 등 다른 scope는 그대로 통과한다. 출처(``effective_client``)는 판정이 아니라
    ``scope["client"]`` 재작성(#15 ``_require_loopback``)과 401 안내 문구에만 쓴다.
    """

    realm = "raven"
    # The Core API serves the desktop webview, which holds the shell's session credential.
    # MCP clients are agents with issued tokens, so MCP turns this off.
    accept_session_token = True
    detail = (
        "원격 접근에는 Authorization: Bearer <token>이 필요합니다 "
        "(raven mcp token add <name>)."
    )

    def __init__(self, app, public=None, guest=None):
        self.app = app
        self._public = public
        # Core API only: judges guest tokens (``rvg_``, raven/api/guest_routes.py::authorize).
        # MCP passes none, so a guest token there is just an unknown token → 401.
        self._guest = guest

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        if _is_health_check(scope):
            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(_HEALTH_BODY)).encode())],
            })
            await send({"type": "http.response.body", "body": _HEALTH_BODY})
            return
        source = effective_client(scope)
        public = scope["type"] == "http" and self._public is not None and self._public(scope)
        # The desktop session credential belongs to the webview on this PC: it is never
        # accepted from a LAN/tailnet/unknown source, so a copy is useless off this machine.
        session_ok = self.accept_session_token and is_loopback_client(source)
        token = _bearer_token(scope)
        guest = None
        if not public and self._guest is not None and token and token.startswith(GUEST_TOKEN_PREFIX):
            allowed, guest = self._guest(scope, token)
            if not allowed:
                await self._deny_guest(scope, send, guest)
                return
        if public or guest is not None or has_valid_bearer(scope, session_ok=session_ok):
            client = scope.get("client")
            if source is None or not client or client[0] != source:
                port = client[1] if client else 0
                scope = dict(scope, client=(source or UNKNOWN_CLIENT, port))
            if guest is not None:
                scope = dict(scope, state={**scope.get("state", {}), GUEST_STATE_KEY: guest})
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        if source is None:
            # The source could not be told (e.g. an ambiguous proxy, #29): say only what is needed.
            detail = "이 요청에는 Authorization: Bearer <token>이 필요합니다 (raven mcp token add <name>)."
        elif is_loopback_client(source):
            detail = (
                "같은 PC(loopback)에서 온 요청도 Authorization: Bearer <token>이 필요합니다 "
                "(raven mcp token add <name>)."
            )
        else:
            detail = self.detail
        body = json.dumps(
            {"ok": False, "error": "unauthorized", "detail": detail},
            ensure_ascii=False,
        ).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"content-type", b"application/json; charset=utf-8"),
                (b"www-authenticate", f'Bearer realm="{self.realm}"'.encode()),
                (b"content-length", str(len(body)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": body})


    async def _deny_guest(self, scope, send, decision: dict) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        status = decision.get("status", 401)
        body = json.dumps({"ok": False, **{k: v for k, v in decision.items() if k != "status"}},
                          ensure_ascii=False).encode("utf-8")
        headers = [(b"content-type", b"application/json; charset=utf-8"),
                   (b"content-length", str(len(body)).encode())]
        if status == 401:
            headers.append((b"www-authenticate", f'Bearer realm="{self.realm}"'.encode()))
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

# ─── bind 정책 ────────────────────────────────────────────────


def allow_remote_from_env(raw: str | None = None) -> bool:
    """True only for an explicit truthy ``RAVEN_ALLOW_REMOTE`` (1/true/yes/on)."""
    if raw is None:
        raw = os.environ.get(ALLOW_REMOTE_ENV, "")
    return raw.strip().lower() in ("1", "true", "yes", "on")


def is_loopback_host(host: str) -> bool:
    """True when binding ``host`` only ever receives local traffic."""
    if host.strip().lower() == "localhost":
        return True
    addr = _parse_ip(host)
    return addr is not None and addr.is_loopback


def safe_bind_host(host: str | None, allow_remote: bool = False) -> str:
    """Resolve a requested bind host to something safe to bind.

    Fail-closed: anything that is not loopback resolves to loopback unless
    remote access was explicitly opted into. Loopback spellings (``127.0.0.1``,
    ``localhost``, ``::1``, ``[::1]``) normalise to ``127.0.0.1``. Wildcards
    (``0.0.0.0``, ``::``) and named addresses survive only under ``allow_remote``;
    IPv4-mapped forms (``::ffff:0.0.0.0``) are unwrapped to their IPv4 meaning.

    Narrowing (not raising) is what the desktop shell needs — it always passes a
    host, and refusing would leave no window. The standalone CLI refuses an
    explicit remote host before calling this (``raven/api/main.py``).
    """
    if host is None or not host.strip():
        return LOOPBACK_HOST
    if is_loopback_host(host):
        return LOOPBACK_HOST
    if not allow_remote:
        return LOOPBACK_HOST
    addr = _parse_ip(host)
    return str(addr) if addr is not None else host.strip()

"""Core API 접근 계약 (Issue #14 / PR #21 BLOCKER).

PR #21 1차 수정은 데스크톱 런타임에서만 API를 ``LanTokenAuth``로 감쌌다.
``python -m raven.api --host 0.0.0.0`` / ``RAVEN_HOST=0.0.0.0`` /
``uvicorn raven.api:app --host 0.0.0.0``은 원본 FastAPI 앱을 그대로 내놓아,
같은 망의 누구든 인증 없이 vault를 읽고 쓰고 ``DELETE ...?force=true``로 지울 수 있었다.

Contract (모든 실행 경로 공통):
  1. 접근 게이트는 앱(``raven.api.app``) 자체에 있다 — 실행 경로가 무엇이든 같은 판정.
     출처는 소켓 주소(ASGI ``scope["client"]``)로만 본다. Host/Origin/X-Forwarded-For는 무시.
     - loopback(127.0.0.0/8, ::1, ::ffff:127.x) → 통과
     - tailnet(100.64.0.0/10, fd7a:115c:a1e0::/48) → 통과 (MCP와 같은 신뢰 모델)
     - 그 외 → ``Authorization: Bearer <raven mcp token add 토큰>``이 맞아야 통과, 아니면 401.
       발급 0개면 전부 401. 예외 경로(health 등) 없음.
  2. bind: 기본 loopback. 비루프백/와일드카드는 ``RAVEN_ALLOW_REMOTE``가 참(1/true/yes/on)일
     때만. standalone CLI는 opt-in 없는 원격 bind 요청을 **거부**(exit 2)하고, 데스크톱
     런타임은 창이 안 뜨는 일이 없게 loopback으로 낮춘다. 우선순위: ``--host`` > ``RAVEN_HOST``.

모든 테스트는 임시 ``WIKI_VAULTS_DIR``와 임시 포트를 쓴다 — 사용자 vault는 건드리지 않는다.
"""
from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import httpx
import pytest

from raven.core import mcp_tokens

REPO_ROOT = Path(__file__).resolve().parents[1]

TRUSTED_SOURCES = [
    "127.0.0.1",
    "127.8.9.10",
    "::1",
    "::ffff:127.0.0.1",
    "100.64.0.1",          # tailnet CGNAT 하한
    "100.127.255.254",     # tailnet CGNAT 상한
    "fd7a:115c:a1e0::5",   # Tailscale ULA
    "::ffff:100.101.1.2",  # IPv4-mapped tailnet
]
UNTRUSTED_SOURCES = [
    "192.168.1.50",
    "10.0.0.7",
    "172.16.0.3",
    "100.63.255.255",      # CGNAT 바로 아래 — tailnet 아님
    "100.128.0.1",         # CGNAT 바로 위 — tailnet 아님
    "8.8.8.8",
    "::ffff:192.168.1.50",
    "::ffff:0.0.0.0",
    "fe80::1",
    "2001:db8::1",
    "fd00::1",             # 다른 ULA — Tailscale 대역 아님
    "testclient",          # IP가 아닌 출처 → 신뢰 ❌
    "",
]


@pytest.fixture
def vaults_root(tmp_path, monkeypatch):
    root = tmp_path / "vaults"
    root.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(root))
    return root


def _call(method: str, path: str, client_ip: str, headers: dict[str, str] | None = None, **kw):
    """Drive the *real* ``raven.api.app`` — the object every launcher serves."""
    from raven.api import app

    transport = httpx.ASGITransport(app=app, client=(client_ip, 44444))

    async def go() -> httpx.Response:
        async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
            return await c.request(method, path, headers=headers or {}, **kw)

    return asyncio.run(go())


# ─── 1. 앱 자체의 게이트 (uvicorn raven.api:app / python -m raven.api 공통) ───


@pytest.mark.parametrize("ip", UNTRUSTED_SOURCES)
def test_app_refuses_unauthenticated_non_local_source(vaults_root, ip):
    res = _call("GET", "/api/vaults", ip)
    assert res.status_code == 401, (ip, res.status_code, res.text[:200])
    assert res.headers["www-authenticate"].startswith("Bearer")
    assert res.json()["error"] == "unauthorized"


@pytest.mark.parametrize("ip", TRUSTED_SOURCES)
def test_app_serves_loopback_and_tailnet(vaults_root, ip):
    assert _call("GET", "/api/vaults", ip).status_code == 200, ip


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Origin": "https://evil.example.com"},
        {"Origin": "http://127.0.0.1:5173"},        # 허용 목록 origin 위조
        {"Origin": "http://tauri.localhost"},
        {"Host": "127.0.0.1:8765"},                 # Host 위조
        {"X-Forwarded-For": "127.0.0.1"},           # proxy 헤더 위조
        {"X-Real-IP": "100.100.100.100"},
    ],
)
def test_headers_never_vouch_for_a_lan_source(vaults_root, headers):
    assert _call("GET", "/api/vaults", "192.168.1.50", headers).status_code == 401, headers


@pytest.mark.parametrize("path", ["/", "/api/system/info", "/docs", "/openapi.json", "/api/health", "/assets/x.js"])
def test_no_unauthenticated_exemptions(vaults_root, path):
    """health/readiness 같은 예외 경로가 없다 — 게이트는 경로를 보지 않는다."""
    assert _call("GET", path, "192.168.1.50").status_code == 401, path


def test_bearer_matrix(vaults_root):
    lan = "192.168.1.50"
    # 발급 0개 — 무엇을 보내도 401 (fail-closed)
    assert _call("GET", "/api/vaults", lan, {"Authorization": "Bearer rvn_guess"}).status_code == 401

    token = mcp_tokens.add_token("laptop")
    ok = {"Authorization": f"Bearer {token}"}
    assert _call("GET", "/api/vaults", lan, ok).status_code == 200
    assert _call("GET", "/api/vaults", lan, {"Authorization": f"bearer {token}"}).status_code == 200

    for bad in (
        "Bearer rvn_wrong",
        "Bearer ",
        "Bearer",
        f"Basic {token}",
        token,
        f"Bearer {token}x",
    ):
        assert _call("GET", "/api/vaults", lan, {"Authorization": bad}).status_code == 401, bad

    mcp_tokens.revoke_token("laptop")
    assert _call("GET", "/api/vaults", lan, ok).status_code == 401


def test_unauthenticated_destructive_calls_never_reach_handlers(vaults_root, monkeypatch):
    """LAN의 write/delete가 핸들러에 닿지 않는다 — 401 + 디스크/registry 불변."""
    from raven.core.registry import registry
    from raven.core.vault import Vault

    Vault.create("alpha", vaults_root / "alpha")
    vault_dir = vaults_root / "alpha"
    assert vault_dir.exists()

    reached: list[str] = []
    import raven.api.server as server

    real_registry = server.registry
    monkeypatch.setattr(server, "registry", lambda *a, **k: reached.append("registry") or real_registry(*a, **k))

    lan = "192.168.1.50"
    calls = [
        ("DELETE", "/api/vaults/alpha?force=true", {}),
        ("DELETE", "/api/vaults/alpha", {}),
        ("POST", "/api/vaults/alpha/pages", {"json": {"title": "x", "body": "y"}}),
        ("GET", "/api/vaults/alpha/pages", {}),
        ("POST", "/api/vaults", {"json": {"name": "beta", "path": str(vaults_root / "beta")}}),
    ]
    for method, path, kw in calls:
        res = _call(method, path, lan, **kw)
        assert res.status_code == 401, (method, path, res.status_code)
    assert reached == [], f"handler reached: {reached}"
    assert vault_dir.exists()
    assert registry().get("alpha") is not None
    assert not (vaults_root / "beta").exists()

    # control — 같은 요청이 loopback에서는 실제로 지운다 (테스트가 무력하지 않다)
    res = _call("DELETE", "/api/vaults/alpha?force=true", "127.0.0.1")
    assert res.status_code == 200, res.text
    assert not vault_dir.exists()


def test_websocket_scope_is_gated_too(vaults_root):
    from raven.api import app

    sent: list[dict] = []

    async def receive():
        return {"type": "websocket.connect"}

    async def send(msg):
        sent.append(msg)

    scope = {
        "type": "websocket", "path": "/ws", "raw_path": b"/ws", "query_string": b"",
        "headers": [], "client": ("192.168.1.50", 1), "server": ("raven", 80),
        "scheme": "ws", "root_path": "", "subprotocols": [],
        "asgi": {"version": "3.0"},
    }
    asyncio.run(app(scope, receive, send))
    assert sent and sent[0]["type"] == "websocket.close", sent


def test_single_gate_implementation_is_shared_with_mcp():
    """Core API와 MCP가 같은 판정 함수를 쓴다 — 정책이 둘로 갈라지지 않는다."""
    from raven.core import access
    from raven.mcp import auth as mcp_auth

    assert mcp_auth.is_trusted_client is access.is_trusted_client
    assert issubclass(mcp_auth.LanTokenAuth, access.TokenGate)


def test_gate_is_installed_once_on_the_app():
    from raven.api import app
    from raven.core.access import TokenGate

    gates = [m for m in app.user_middleware if m.cls is TokenGate or (
        isinstance(m.cls, type) and issubclass(m.cls, TokenGate))]
    assert len(gates) == 1, app.user_middleware


# ─── 2. bind 정책 — standalone CLI (python -m raven.api) ───


class _Captured(dict):
    pass


@pytest.fixture
def fake_uvicorn(monkeypatch):
    captured = _Captured()

    def fake_run(app, host, port, **kwargs):
        captured.update(app=app, host=host, port=port, **kwargs)

    monkeypatch.setattr("raven.api.main.uvicorn.run", fake_run)
    for k in ("RAVEN_HOST", "RAVEN_ALLOW_REMOTE", "RAVEN_ALLOW_ALL_CORS"):
        monkeypatch.delenv(k, raising=False)
    return captured


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "192.168.1.5", "example.com"])
def test_standalone_refuses_remote_bind_without_opt_in(fake_uvicorn, host):
    from raven.api.main import main as api_main

    assert api_main(["--host", host]) == 2
    assert "host" not in fake_uvicorn, f"uvicorn started on {fake_uvicorn.get('host')}"


def test_standalone_refuses_raven_host_wildcard_without_opt_in(fake_uvicorn, monkeypatch):
    from raven.api.main import main as api_main

    monkeypatch.setenv("RAVEN_HOST", "0.0.0.0")
    assert api_main([]) == 2
    assert "host" not in fake_uvicorn


@pytest.mark.parametrize("raw", ["", "  ", "0", "false", "no", "off", "2", "enable", "yes please"])
def test_standalone_ignores_malformed_allow_remote(fake_uvicorn, monkeypatch, raw):
    from raven.api.main import main as api_main

    monkeypatch.setenv("RAVEN_ALLOW_REMOTE", raw)
    assert api_main(["--host", "0.0.0.0"]) == 2, raw
    assert "host" not in fake_uvicorn


@pytest.mark.parametrize("raw", ["1", "true", "TRUE", " yes ", "on"])
def test_standalone_remote_bind_with_opt_in(fake_uvicorn, monkeypatch, raw):
    from raven.api.main import main as api_main

    monkeypatch.setenv("RAVEN_ALLOW_REMOTE", raw)
    assert api_main(["--host", "0.0.0.0"]) == 0
    assert fake_uvicorn["host"] == "0.0.0.0"
    assert fake_uvicorn["app"] == "raven.api:app"  # 게이트가 앱 안에 있으므로 그대로 서빙


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1", "[::1]", ""])
def test_standalone_loopback_spellings(fake_uvicorn, host):
    from raven.api.main import main as api_main

    assert api_main(["--host", host]) == 0
    assert fake_uvicorn["host"] == "127.0.0.1"


def test_standalone_cli_host_beats_env(fake_uvicorn, monkeypatch):
    from raven.api.main import main as api_main

    monkeypatch.setenv("RAVEN_HOST", "0.0.0.0")
    assert api_main(["--host", "127.0.0.1"]) == 0
    assert fake_uvicorn["host"] == "127.0.0.1"


def test_standalone_tailscale_is_its_own_opt_in(fake_uvicorn, monkeypatch):
    from raven.api.main import main as api_main

    monkeypatch.setattr("raven.api.main.get_tailscale_ip", lambda: "100.88.1.2")
    assert api_main(["--host", "tailscale"]) == 0
    assert fake_uvicorn["host"] == "100.88.1.2"


# ─── 3. bind 정책 — desktop runtime 우선순위 (Tauri는 항상 --host를 넘긴다) ───


def test_desktop_resolver_matches_standalone_resolver():
    from raven.core.access import safe_bind_host
    from raven.desktop import runtime

    assert runtime.safe_bind_host is safe_bind_host


# ─── 4. 실제 소켓 — 이 기기의 LAN 주소로 접속해 "원격 출처"를 만든다 ───


def _lan_ip() -> str | None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))  # TEST-NET-1: 패킷은 나가지 않는다
        ip = s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()
    if ip.startswith("127.") or ip.startswith("100."):
        return None
    return ip


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _env(vaults_root: Path, **overrides: str) -> dict[str, str]:
    env = {
        k: v for k, v in os.environ.items()
        if k not in {"RAVEN_HOST", "RAVEN_DESKTOP_HOST", "RAVEN_ALLOW_ALL_CORS",
                     "RAVEN_ALLOW_REMOTE", "FORWARDED_ALLOW_IPS", "WIKI_VAULTS_DIR"}
    }
    env["WIKI_VAULTS_DIR"] = str(vaults_root)
    env.update(overrides)
    return env


def _wait_listening(port: int, proc: subprocess.Popen, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise AssertionError(f"server exited early ({proc.returncode}): {proc.stderr.read() if proc.stderr else ''}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return
        except OSError:
            time.sleep(0.1)
    raise AssertionError("server did not start")


def _http(method: str, url: str, headers: dict[str, str] | None = None) -> int:
    req = Request(url, method=method, headers=headers or {})
    try:
        with urlopen(req, timeout=5) as r:
            return r.status
    except HTTPError as e:
        return e.code


def _stop(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()


def _assert_remote_contract(port: int, lan: str, vaults_root: Path) -> None:
    from raven.core.vault import Vault

    Vault.create("alpha", vaults_root / "alpha")
    remote = f"http://{lan}:{port}"
    assert _http("GET", f"{remote}/api/vaults") == 401
    assert _http("GET", f"{remote}/api/vaults", {"Origin": "http://127.0.0.1:5173"}) == 401
    assert _http("GET", f"{remote}/api/vaults", {"X-Forwarded-For": "127.0.0.1"}) == 401
    assert _http("GET", f"{remote}/api/vaults", {"Authorization": "Bearer rvn_nope"}) == 401
    assert _http("DELETE", f"{remote}/api/vaults/alpha?force=true") == 401
    assert (vaults_root / "alpha").exists()

    token = mcp_tokens.add_token("lan-device")
    assert _http("GET", f"{remote}/api/vaults", {"Authorization": f"Bearer {token}"}) == 200
    assert _http("GET", f"http://127.0.0.1:{port}/api/vaults") == 200


@pytest.fixture
def lan_ip():
    ip = _lan_ip()
    if ip is None:
        pytest.skip("no non-loopback, non-tailnet IPv4 on this host")
    return ip


def test_real_socket_standalone_wildcard_without_opt_in_does_not_listen(vaults_root):
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "raven.api", "--host", "0.0.0.0", "--port", str(port)],
        cwd=REPO_ROOT, env=_env(vaults_root), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        rc = proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        _stop(proc)
        raise AssertionError("standalone API started a wildcard listener without RAVEN_ALLOW_REMOTE")
    assert rc == 2, rc
    with pytest.raises(OSError):
        socket.create_connection(("127.0.0.1", port), timeout=0.5).close()


def test_real_socket_standalone_remote_requires_token(vaults_root, lan_ip):
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "raven.api", "--host", "0.0.0.0", "--port", str(port)],
        cwd=REPO_ROOT, env=_env(vaults_root, RAVEN_ALLOW_REMOTE="1"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        _wait_listening(port, proc)
        _assert_remote_contract(port, lan_ip, vaults_root)
    finally:
        _stop(proc)


def test_real_socket_direct_uvicorn_asgi_is_gated(vaults_root, lan_ip):
    """`uvicorn raven.api:app --host 0.0.0.0` 은 main()을 거치지 않는다 — 앱 안의 게이트가 지킨다."""
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "raven.api:app", "--host", "0.0.0.0", "--port", str(port),
         "--log-level", "warning"],
        cwd=REPO_ROOT, env=_env(vaults_root), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        _wait_listening(port, proc)
        _assert_remote_contract(port, lan_ip, vaults_root)
    finally:
        _stop(proc)


def test_real_socket_desktop_remote_requires_token_and_keeps_local(vaults_root, lan_ip):
    """데스크톱 원격 모드: LAN 401, 유효 토큰 200(이중 게이트로 거부 ❌), loopback 200."""
    import json
    import select

    proc = subprocess.Popen(
        [sys.executable, "-m", "raven.desktop.runtime", "--host", "0.0.0.0"],
        cwd=REPO_ROOT, env=_env(vaults_root, RAVEN_ALLOW_REMOTE="1", PORT_API=str(_free_port())),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 20
        ready = None
        while time.monotonic() < deadline and ready is None:
            r, _, _ = select.select([proc.stdout], [], [], 0.1)
            if r:
                ready = json.loads(proc.stdout.readline())
            elif proc.poll() is not None:
                raise AssertionError(proc.stderr.read())
        assert ready and ready["host"] == "127.0.0.1"
        _assert_remote_contract(ready["port"], lan_ip, vaults_root)
    finally:
        _stop(proc)


def test_real_socket_desktop_cli_host_beats_raven_host_env(vaults_root, lan_ip):
    """Tauri는 RAVEN_DESKTOP_HOST > RAVEN_HOST로 고른 값을 --host로 넘긴다. 자식이 상속한
    RAVEN_HOST가 그 결정을 뒤집으면 안 된다."""
    import json
    import select

    proc = subprocess.Popen(
        [sys.executable, "-m", "raven.desktop.runtime", "--host", "127.0.0.1"],
        cwd=REPO_ROOT,
        env=_env(vaults_root, RAVEN_ALLOW_REMOTE="1", RAVEN_HOST="0.0.0.0", PORT_API=str(_free_port())),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 20
        ready = None
        while time.monotonic() < deadline and ready is None:
            r, _, _ = select.select([proc.stdout], [], [], 0.1)
            if r:
                ready = json.loads(proc.stdout.readline())
            elif proc.poll() is not None:
                raise AssertionError(proc.stderr.read())
        assert ready
        # TCP 수준에서 거절돼야 한다 — 401(HTTPError)은 "LAN에 열려 있다"는 뜻이다.
        with pytest.raises(ConnectionRefusedError):
            socket.create_connection((lan_ip, ready["port"]), timeout=2).close()
        assert _http("GET", f"http://127.0.0.1:{ready['port']}/api/vaults") == 200
    finally:
        _stop(proc)


def test_real_socket_tailnet_source_is_trusted(vaults_root):
    from raven.api.main import get_tailscale_ip

    ts = get_tailscale_ip()
    if not ts:
        pytest.skip("no tailnet on this host")
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "raven.api", "--host", "0.0.0.0", "--port", str(port)],
        cwd=REPO_ROOT, env=_env(vaults_root, RAVEN_ALLOW_REMOTE="1"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        _wait_listening(port, proc)
        assert _http("GET", f"http://{ts}:{port}/api/vaults") == 200
    finally:
        _stop(proc)

"""Docker dashboard proxy auth (PR #21 re-review P1).

In Docker the dashboard container's ``scripts/spa_server.py`` reverse-proxies
``/api/*`` to the ``api`` container. The API sees that hop from a bridge IP — not
loopback, not tailnet — so after Issue #14 every proxied call got 401 and the
dashboard was dead. Trusting the Docker subnet would hand admin to *any*
container on the network, so the fix is authenticated traffic instead:

  1. spa_server forwards a credential the *user* holds: either their own
     ``Authorization: Bearer`` header, or a token they entered once on
     ``/__raven/login`` (validated against the API, then kept in an
     ``HttpOnly; SameSite=Strict`` cookie and turned back into a Bearer header).
     No service token, no IP trust in spa_server.
  2. Nothing is served without a credential except the login page itself.
  3. Cookie-authenticated unsafe methods (POST/PUT/PATCH/DELETE) need an
     ``Origin`` matching the request ``Host`` (CSRF). Bearer-header clients are
     not cookie-driven and are exempt.
  4. The proxy never forwards its session cookie, and replaces any client-sent
     forwarding headers with the real client address.
  5. ``next`` redirects stay on-site.

Here the API is bound wide (opt-in) and spa_server reaches it through this
machine's LAN IP, so the API judges the proxy hop as a non-loopback peer — the
same position as the Docker bridge.
"""
from __future__ import annotations

import http.client
import http.server
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path

import pytest

from raven.core import mcp_tokens

REPO_ROOT = Path(__file__).resolve().parents[1]
SPA = REPO_ROOT / "scripts" / "spa_server.py"


def _lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))
        ip = s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()
    return None if ip.startswith(("127.", "100.")) else ip


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait(port, proc, timeout=20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise AssertionError(f"exited early: {proc.stderr.read() if proc.stderr else ''}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return
        except OSError:
            time.sleep(0.1)
    raise AssertionError("server did not start")


def _stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()


def _env(vaults_root, **extra):
    env = {k: v for k, v in os.environ.items()
           if k not in {"RAVEN_HOST", "RAVEN_ALLOW_REMOTE", "FORWARDED_ALLOW_IPS", "WIKI_VAULTS_DIR"}}
    env["WIKI_VAULTS_DIR"] = str(vaults_root)
    env.update(extra)
    return env


def _start_spa(api_url, dist, env):
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, str(SPA), "--port", str(port), "--bind", "127.0.0.1",
         "--dir", str(dist), "--api-url", api_url],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    _wait(port, proc)
    return port, proc


def _req(port, method, path, headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        res = conn.getresponse()
        return res.status, {k.lower(): v for k, v in res.getheaders()}, res.read()
    finally:
        conn.close()


def _login(port, token, next_path="/"):
    body = urllib.parse.urlencode({"token": token, "next": next_path})
    return _req(port, "POST", "/__raven/login", {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": f"http://127.0.0.1:{port}",
        "Host": f"127.0.0.1:{port}",
    }, body)


def _cookie(headers):
    raw = headers.get("set-cookie", "")
    return raw.split(";", 1)[0]


@pytest.fixture
def stack(tmp_path, monkeypatch):
    lan = _lan_ip()
    if lan is None:
        pytest.skip("no non-loopback, non-tailnet IPv4 on this host")
    vaults = tmp_path / "vaults"
    vaults.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(vaults))
    from raven.core.vault import Vault

    Vault.create("alpha", vaults / "alpha")
    Vault.create("beta", vaults / "beta")
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>raven dashboard</html>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    (dist / "manifest.webmanifest").write_text("{}", encoding="utf-8")

    api_port = _free_port()
    api = subprocess.Popen(
        [sys.executable, "-m", "raven.api", "--host", "0.0.0.0", "--port", str(api_port)],
        cwd=REPO_ROOT, env=_env(vaults, RAVEN_ALLOW_REMOTE="1"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    _wait(api_port, api)
    port, spa = _start_spa(f"http://{lan}:{api_port}", dist, _env(vaults))
    try:
        yield {"port": port, "vaults": vaults, "dist": dist, "token": mcp_tokens.add_token("me")}
    finally:
        _stop(spa)
        _stop(api)


def test_nothing_is_served_without_a_credential(stack):
    p = stack["port"]
    assert _req(p, "GET", "/api/vaults")[0] == 401
    for path in ("/", "/vault/alpha", "/assets/app.js"):
        status, headers, _ = _req(p, "GET", path)
        assert status == 303, path
        assert headers["location"].startswith("/__raven/login"), headers
    status, _, body = _req(p, "GET", "/__raven/login")
    assert status == 200 and b"<form" in body
    # only data-free files fetched credential-less by browsers are public
    assert _req(p, "GET", "/manifest.webmanifest")[0] == 200
    assert _req(p, "GET", "/index.html")[0] == 303


def test_wrong_token_does_not_log_in(stack):
    status, headers, _ = _login(stack["port"], "rvn_wrong")
    assert status == 401
    assert "set-cookie" not in headers


def test_login_sets_a_strict_httponly_cookie_and_dashboard_works(stack):
    p = stack["port"]
    status, headers, _ = _login(p, stack["token"], "/vault/alpha")
    assert status == 303 and headers["location"] == "/vault/alpha"
    cookie_attrs = headers["set-cookie"].lower()
    assert "httponly" in cookie_attrs and "samesite=strict" in cookie_attrs and "path=/" in cookie_attrs
    assert stack["token"] not in headers["location"]
    c = {"Cookie": _cookie(headers)}
    assert _req(p, "GET", "/api/vaults", c)[0] == 200
    status, _, body = _req(p, "GET", "/", c)
    assert status == 200 and b"raven dashboard" in body
    assert _req(p, "GET", "/assets/app.js", c)[0] == 200


def test_cookie_driven_writes_need_same_origin(stack):
    p = stack["port"]
    _, headers, _ = _login(p, stack["token"])
    c = {"Cookie": _cookie(headers), "Host": f"127.0.0.1:{p}"}
    assert _req(p, "DELETE", "/api/vaults/beta?force=true", c)[0] == 403
    assert _req(p, "DELETE", "/api/vaults/beta?force=true", {**c, "Origin": "http://evil.example"})[0] == 403
    assert _req(p, "DELETE", "/api/vaults/beta?force=true", {**c, "Origin": f"http://localhost:{p + 1}"})[0] == 403
    assert (stack["vaults"] / "beta").exists()
    status = _req(p, "DELETE", "/api/vaults/beta?force=true", {**c, "Origin": f"http://127.0.0.1:{p}"})[0]
    assert status == 200
    assert not (stack["vaults"] / "beta").exists()


def test_bearer_header_clients_pass_through(stack):
    p = stack["port"]
    auth = {"Authorization": f"Bearer {stack['token']}"}
    assert _req(p, "GET", "/api/vaults", auth)[0] == 200
    assert _req(p, "GET", "/api/vaults", {"Authorization": "Bearer rvn_nope"})[0] == 401


def test_revoked_token_sends_the_browser_back_to_login(stack):
    p = stack["port"]
    _, headers, _ = _login(p, stack["token"])
    c = {"Cookie": _cookie(headers)}
    mcp_tokens.revoke_token("me")
    assert _req(p, "GET", "/api/vaults", c)[0] == 401
    status, h, _ = _req(p, "GET", "/", c)
    assert status == 303 and h["location"].startswith("/__raven/login")


def test_logout_clears_the_cookie(stack):
    p = stack["port"]
    _, headers, _ = _login(p, stack["token"])
    status, h, _ = _req(p, "POST", "/__raven/logout", {
        "Cookie": _cookie(headers), "Origin": f"http://127.0.0.1:{p}", "Host": f"127.0.0.1:{p}"})
    assert status == 303
    assert "max-age=0" in h["set-cookie"].lower()


@pytest.mark.parametrize("nxt", ["//evil.example/x", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "",
                                 "/x\r\nSet-Cookie: pwned=1"])
def test_next_redirect_stays_on_site(stack, nxt):
    status, headers, _ = _login(stack["port"], stack["token"], nxt)
    assert status == 303
    assert headers["location"] == "/", headers["location"]


def test_proxy_strips_session_cookie_and_spoofed_forwarding_headers(tmp_path, monkeypatch):
    """Record what spa_server actually sends upstream."""
    seen: list[dict] = []

    class Echo(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append({k.lower(): v for k, v in self.headers.items()})
            body = b"{}"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    echo = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Echo)
    threading.Thread(target=echo.serve_forever, daemon=True).start()
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("x", encoding="utf-8")
    port, spa = _start_spa(f"http://127.0.0.1:{echo.server_address[1]}", dist, dict(os.environ))
    try:
        _req(port, "GET", "/api/vaults", {
            "Authorization": "Bearer rvn_secret",
            "Cookie": "raven_session=whatever; theme=dark",
            "X-Forwarded-For": "127.0.0.1",
            "Forwarded": "for=127.0.0.1",
            "X-Real-IP": "127.0.0.1",
        })
        assert seen, "proxy did not forward"
        fwd = seen[-1]
        assert fwd.get("authorization") == "Bearer rvn_secret"
        assert "raven_session" not in fwd.get("cookie", "")
        assert fwd.get("cookie") == "theme=dark"
        assert fwd.get("x-forwarded-for") == "127.0.0.1"  # the proxy's real client, not the spoof
        assert "forwarded" not in fwd and "x-real-ip" not in fwd
        # a cookie that is not a live session authenticates nothing
        status, _, _ = _req(port, "GET", "/api/vaults", {"Cookie": "raven_session=rvn_a"})
        assert status == 401
    finally:
        _stop(spa)
        echo.shutdown()


# ─── PR #21 audit: session hardening ───


def _session_cookie(headers):
    raw = headers.get("set-cookie", "")
    name, _, rest = raw.partition("=")
    return name, rest.split(";", 1)[0], raw


def test_cookie_holds_an_opaque_session_not_the_api_token(stack):
    """Cookies are not port-isolated: anything else on this host receives them.
    The cookie must not be the long-lived API token."""
    _, headers, _ = _login(stack["port"], stack["token"])
    name, value, raw = _session_cookie(headers)
    assert name == "raven_session"
    assert stack["token"] not in raw
    assert len(value) >= 32
    # a raw API token in the cookie is not a session
    status, h, _ = _req(stack["port"], "GET", "/", {"Cookie": f"raven_session={stack['token']}"})
    assert status == 303
    assert _req(stack["port"], "GET", "/api/vaults", {"Cookie": f"raven_token={stack['token']}"})[0] == 401


def test_logout_kills_the_session_server_side(stack):
    p = stack["port"]
    _, headers, _ = _login(p, stack["token"])
    name, value, _ = _session_cookie(headers)
    c = {"Cookie": f"{name}={value}"}
    assert _req(p, "GET", "/api/vaults", c)[0] == 200
    _req(p, "POST", "/__raven/logout", {**c, "Origin": f"http://127.0.0.1:{p}", "Host": f"127.0.0.1:{p}"})
    assert _req(p, "GET", "/api/vaults", c)[0] == 401          # replayed cookie is dead
    assert _req(p, "GET", "/", c)[0] == 303


@pytest.mark.parametrize("length", ["abc", "-1", "99999999"])
def test_login_rejects_bad_or_oversized_bodies(stack, length):
    conn = http.client.HTTPConnection("127.0.0.1", stack["port"], timeout=10)
    try:
        conn.putrequest("POST", "/__raven/login")
        conn.putheader("Content-Type", "application/x-www-form-urlencoded")
        conn.putheader("Content-Length", length)
        conn.endheaders()
        res = conn.getresponse()
        assert res.status in (400, 413), (length, res.status)
        assert "set-cookie" not in {k.lower() for k, _ in res.getheaders()}
    finally:
        conn.close()


@pytest.mark.parametrize("token", ["x" * 5000, "rvn_ok\r\nSet-Cookie: a=b", "rvn_with space", "rvn_;semi"])
def test_login_rejects_malformed_tokens(stack, token):
    status, headers, body = _login(stack["port"], token)
    assert status in (400, 401, 413)
    assert "set-cookie" not in headers
    assert token.encode()[:40] not in body


def test_proxy_rejects_malformed_content_length(stack):
    _, headers, _ = _login(stack["port"], stack["token"])
    name, value, _ = _session_cookie(headers)
    conn = http.client.HTTPConnection("127.0.0.1", stack["port"], timeout=10)
    try:
        conn.putrequest("POST", "/api/vaults")
        conn.putheader("Cookie", f"{name}={value}")
        conn.putheader("Origin", f"http://127.0.0.1:{stack['port']}")
        conn.putheader("Content-Length", "-5")
        conn.endheaders()
        assert conn.getresponse().status == 400
    finally:
        conn.close()


def test_token_never_reaches_urls_pages_or_logs(tmp_path, monkeypatch):
    """Login success/failure: token absent from Location, response bodies and spa_server logs."""
    lan = _lan_ip()
    if lan is None:
        pytest.skip("no LAN IP")
    vaults = tmp_path / "vaults"
    vaults.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(vaults))
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("x", encoding="utf-8")
    api_port = _free_port()
    api = subprocess.Popen([sys.executable, "-m", "raven.api", "--host", "0.0.0.0", "--port", str(api_port)],
                           cwd=REPO_ROOT, env=_env(vaults, RAVEN_ALLOW_REMOTE="1"),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    _wait(api_port, api)
    port, spa = _start_spa(f"http://{lan}:{api_port}", dist, _env(vaults))
    token = mcp_tokens.add_token("logcheck")
    try:
        bad = "rvn_" + "Q" * 43
        for tok in (bad, token):
            status, headers, body = _login(port, tok, "/x")
            assert tok not in headers.get("location", "")
            assert tok.encode() not in body
    finally:
        _stop(spa)
        _stop(api)
    logs = (spa.stdout.read() or "") + (spa.stderr.read() or "")
    assert token not in logs and bad not in logs, logs[-500:]


def test_secure_cookie_opt_in(tmp_path, monkeypatch):
    """Behind TLS the operator can mark the session cookie Secure."""
    lan = _lan_ip()
    if lan is None:
        pytest.skip("no LAN IP")
    vaults = tmp_path / "vaults"
    vaults.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(vaults))
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("x", encoding="utf-8")
    api_port = _free_port()
    api = subprocess.Popen([sys.executable, "-m", "raven.api", "--host", "0.0.0.0", "--port", str(api_port)],
                           cwd=REPO_ROOT, env=_env(vaults, RAVEN_ALLOW_REMOTE="1"),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    _wait(api_port, api)
    port, spa = _start_spa(f"http://{lan}:{api_port}", dist, _env(vaults, RAVEN_DASHBOARD_SECURE_COOKIE="1"))
    try:
        _, headers, _ = _login(port, mcp_tokens.add_token("tls"))
        assert "; secure" in headers["set-cookie"].lower()
    finally:
        _stop(spa)
        _stop(api)


def test_proxy_drops_upstream_cors_headers(tmp_path):
    """The dashboard is same-origin; the API's CORS answers must not leak through the proxy."""
    class Echo(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = b"{}"
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:9999")
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    echo = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Echo)
    threading.Thread(target=echo.serve_forever, daemon=True).start()
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("x", encoding="utf-8")
    port, spa = _start_spa(f"http://127.0.0.1:{echo.server_address[1]}", dist, dict(os.environ))
    try:
        status, headers, _ = _req(port, "GET", "/api/vaults", {"Authorization": "Bearer rvn_x",
                                                                "Origin": "http://127.0.0.1:9999"})
        assert status == 200
        assert not any(k.startswith("access-control-") for k in headers), headers
    finally:
        _stop(spa)
        echo.shutdown()


def test_shipped_local_proxies_send_x_forwarded_for():
    """Loopback peers without XFF are indistinguishable from local clients, so every proxy
    Raven ships must forward the real client address (vite dev proxy; spa_server is covered
    by test_proxy_strips_session_cookie_and_spoofed_forwarding_headers)."""
    vite = (REPO_ROOT / "dashboard" / "vite.config.ts").read_text(encoding="utf-8")
    assert "xfwd: true" in vite


def test_dashboard_401_names_its_own_realm(stack):
    """#24: the dashboard tells a gate 401 (Bearer realm="raven" → token dialog) from the
    Docker proxy's own 401 (Session realm → its login page)."""
    status, headers, _ = _req(stack["port"], "GET", "/api/vaults")
    assert status == 401
    assert headers.get("www-authenticate", "").startswith('Session realm="raven-dashboard"'), headers

#!/usr/bin/env python3
"""spa_server.py — SPA-aware static file server with /api/* reverse proxy.

역할:
  1. /api/* → API 서버(PORT_API)로 리버스 프록시
  2. 정적 파일 존재 → 그대로 반환
  3. 정적 파일 없음 → index.html 반환 (React Router SPA fallback)

Vite dev server의 proxy 설정을 프로덕션에서도 동일하게 재현.

인증 (Issue #14 / PR #21 P1):
  Docker에서 이 프록시가 API에 닿는 출처는 bridge IP라 API 게이트는 토큰을 요구한다.
  Docker 대역 전체를 신뢰하면 같은 망의 다른 컨테이너까지 관리자 권한을 얻으므로,
  대신 **사용자가 가진 토큰**을 실어 보낸다:
  - 브라우저: ``/__raven/login``에서 ``raven mcp token add``로 발급한 토큰을 한 번 입력 →
    API로 검증 → ``HttpOnly; SameSite=Strict`` 쿠키 → 매 /api 요청에 Bearer로 변환.
  - 그 외 클라이언트: 자기 ``Authorization: Bearer``를 그대로 보낸다.
  - 자격 없는 요청은 로그인 페이지(와 데이터 없는 manifest/favicon) 외에 아무것도 받지 못한다.
    IP 기반 신뢰는 없다.
  - 쿠키로 인증된 POST/PUT/PATCH/DELETE는 ``Origin``이 ``Host``와 같아야 한다 (CSRF).
  - 세션 쿠키는 업스트림에 보내지 않고, 클라이언트가 보낸 X-Forwarded-For/Forwarded/
    X-Real-IP는 버린 뒤 실제 클라이언트 주소로 X-Forwarded-For를 새로 붙인다.

Usage:
    python spa_server.py \\
        --port 5173 --bind 0.0.0.0 \\
        --dir /app/dashboard/dist \\
        --api-url http://127.0.0.1:8765
"""
from __future__ import annotations

import argparse
import html
import http.client
import http.cookies
import os
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_API_URL: str = "http://127.0.0.1:8765"
_STATIC_DIR: str = "."

SESSION_COOKIE = "raven_token"
SESSION_MAX_AGE = 30 * 24 * 3600
LOGIN_PATH = "/__raven/login"
LOGOUT_PATH = "/__raven/logout"
_UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
# Browsers fetch these without credentials (<link rel="manifest"> / favicon), and
# they carry no vault data — the only static files served before login.
_PUBLIC_STATIC = {"/manifest.webmanifest", "/favicon.svg"}
_STRIP_UPSTREAM = {"x-forwarded-for", "forwarded", "x-real-ip", "cookie", "authorization"}
_HOP_BY_HOP = {"host", "connection", "transfer-encoding", "keep-alive",
               "proxy-authenticate", "proxy-authorization", "te", "trailers", "upgrade"}

_LOGIN_PAGE = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raven 로그인</title>
<style>
:root {{ --bg:#f7f7f5; --ink:#1f2328; --muted:#6b7280; --line:#d0d4da; --accent:#0e7490; --err:#b42318; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#16181c; --ink:#e6e8eb; --muted:#9aa3ad; --line:#3a3f46; --accent:#22d3ee; --err:#f97066; }} }}
body {{ margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--ink);
       font:15px/1.5 system-ui, -apple-system, sans-serif; padding:16px; box-sizing:border-box; }}
form {{ width:100%; max-width:380px; display:grid; gap:12px; }}
h1 {{ font-size:20px; margin:0; }} p {{ margin:0; color:var(--muted); }}
input {{ font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; }}
button {{ font:inherit; padding:10px 12px; border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }}
.err {{ color:var(--err); }} code {{ font-size:13px; }}
</style></head><body>
<form method="post" action="{login}">
  <h1>Raven</h1>
  <p>이 대시보드는 토큰이 필요합니다. API 서버에서 <code>raven mcp token add &lt;이름&gt;</code>으로 발급하세요.</p>
  {error}
  <input type="password" name="token" placeholder="rvn_..." autocomplete="current-password" required autofocus aria-label="토큰">
  <input type="hidden" name="next" value="{next}">
  <button type="submit">들어가기</button>
</form></body></html>
"""


def _safe_next(value: str | None) -> str:
    """Only same-site absolute paths — no scheme, no `//host`, no backslash tricks."""
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/"
    if value.startswith(LOGIN_PATH) or any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
        return "/"  # control chars would split the Location header
    return value


class SPAHandler(SimpleHTTPRequestHandler):
    """Serve static files (SPA fallback) + reverse-proxy /api/* to API server."""

    # ── routing ──────────────────────────────────────────────────────────────

    def _is_api(self) -> bool:
        return self.path.startswith("/api")

    # ── reverse proxy ────────────────────────────────────────────────────────

    def _session_token(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(raw)
        except http.cookies.CookieError:
            return None
        morsel = jar.get(SESSION_COOKIE)
        return morsel.value if morsel and morsel.value else None

    def _credential(self) -> tuple[str | None, bool]:
        """(Authorization value to send upstream, came_from_cookie)."""
        header = self.headers.get("Authorization")
        if header:
            return header, False
        token = self._session_token()
        if token:
            return f"Bearer {token}", True
        return None, False

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        host = self.headers.get("Host")
        if not origin or not host:
            return False
        parsed = urllib.parse.urlsplit(origin)
        return parsed.scheme in ("http", "https") and parsed.netloc == host

    def _upstream(self, method: str, path: str, authorization: str | None, body: bytes | None = None):
        parsed = urllib.parse.urlparse(_API_URL)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 8765
        headers: dict[str, str] = {
            k: v for k, v in self.headers.items()
            if k.lower() not in _HOP_BY_HOP and k.lower() not in _STRIP_UPSTREAM
        }
        # keep the browser's other cookies, drop the session one
        other = [c.strip() for c in (self.headers.get("Cookie") or "").split(";")
                 if c.strip() and not c.strip().startswith(f"{SESSION_COOKIE}=")]
        if other:
            headers["Cookie"] = "; ".join(other)
        if authorization:
            headers["Authorization"] = authorization
        headers["X-Forwarded-For"] = self.client_address[0]
        headers["Host"] = f"{host}:{port}"
        conn = http.client.HTTPConnection(host, port, timeout=30)
        try:
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            return resp.status, resp.getheaders(), resp.read()
        finally:
            conn.close()

    def _token_is_valid(self, authorization: str) -> bool:
        try:
            status, _, _ = self._upstream("GET", "/api/vaults", authorization)
        except Exception:
            return False
        return status == 200

    def _send(self, status: int, body: bytes, content_type: str, extra: list[tuple[str, str]] = ()) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _redirect(self, location: str, extra: list[tuple[str, str]] = ()) -> None:
        self._send(303, b"", "text/plain", [("Location", location), *extra])

    def _clear_cookie(self) -> tuple[str, str]:
        return ("Set-Cookie", f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")

    def _to_login(self, clear: bool = False) -> None:
        target = f"{LOGIN_PATH}?next={urllib.parse.quote(_safe_next(self.path), safe='')}"
        self._redirect(target, [self._clear_cookie()] if clear else [])

    def _login_page(self, status: int = 200, error: str = "", next_path: str = "/") -> None:
        err = f'<p class="err" role="alert">{html.escape(error)}</p>' if error else ""
        page = _LOGIN_PAGE.format(login=LOGIN_PATH, error=err, next=html.escape(_safe_next(next_path)))
        self._send(status, page.encode("utf-8"), "text/html; charset=utf-8")

    def _handle_auth_routes(self, method: str) -> bool:
        path = urllib.parse.urlsplit(self.path).path
        if path == LOGIN_PATH:
            if method in ("GET", "HEAD"):
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                self._login_page(next_path=(query.get("next") or ["/"])[0])
            elif method == "POST":
                if self.headers.get("Origin") and not self._same_origin():
                    self._login_page(403, "다른 사이트에서 보낸 로그인 요청은 받지 않습니다.")
                    return True
                length = int(self.headers.get("Content-Length") or 0)
                form = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8") if length else "")
                token = (form.get("token") or [""])[0].strip()
                next_path = _safe_next((form.get("next") or ["/"])[0])
                if not token or not self._token_is_valid(f"Bearer {token}"):
                    self._login_page(401, "토큰이 맞지 않습니다.", next_path)
                    return True
                cookie = (f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; "
                          f"Max-Age={SESSION_MAX_AGE}")
                self._redirect(next_path, [("Set-Cookie", cookie)])
            else:
                self.send_error(405)
            return True
        if path == LOGOUT_PATH:
            if method != "POST":
                self.send_error(405)
            elif not self._same_origin():
                self._send(403, b"cross-origin logout refused", "text/plain")
            else:
                self._redirect(LOGIN_PATH, [self._clear_cookie()])
            return True
        return False

    # ── reverse proxy ────────────────────────────────────────────────────────

    def _proxy(self, method: str) -> None:
        authorization, from_cookie = self._credential()
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None
        if authorization is None:
            msg = b'{"ok": false, "error": "unauthorized", "detail": "login required"}'
            self._send(401, msg, "application/json")
            return
        if from_cookie and method in _UNSAFE and not self._same_origin():
            self._send(403, b'{"ok": false, "error": "cross-origin request refused"}', "application/json")
            return
        try:
            status, resp_headers, resp_body = self._upstream(method, self.path, authorization, body)
        except Exception as exc:
            msg = f"API proxy error: {exc}".encode()
            self._send(502, msg, "text/plain")
            return
        self.send_response(status)
        for k, v in resp_headers:
            if k.lower() not in _HOP_BY_HOP and k.lower() != "content-length":
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(resp_body)))
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(resp_body)

    def _require_session_for_page(self) -> bool:
        """Static/page requests: a valid credential or the login page."""
        if urllib.parse.urlsplit(self.path).path in _PUBLIC_STATIC:
            return True
        authorization, from_cookie = self._credential()
        if authorization is None:
            self._to_login()
            return False
        is_document = not urllib.parse.urlsplit(self.path).path.startswith("/assets/")
        if is_document and not self._token_is_valid(authorization):
            self._to_login(clear=from_cookie)
            return False
        return True

    # ── HTTP methods ─────────────────────────────────────────────────────────

    def do_GET(self) -> None:  # noqa: N802
        if self._handle_auth_routes("GET"):
            return
        if self._is_api():
            self._proxy("GET")
            return
        if not self._require_session_for_page():
            return
        # SPA fallback: 파일이 없으면 index.html 서빙
        path_only = self.path.split("?")[0].split("#")[0]
        abs_path = Path(_STATIC_DIR) / path_only.lstrip("/")
        if not abs_path.exists():
            self.path = "/index.html"
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        if self._handle_auth_routes("HEAD"):
            return
        if self._is_api():
            self._proxy("HEAD")
            return
        if not self._require_session_for_page():
            return
        super().do_HEAD()

    def do_POST(self) -> None:  # noqa: N802
        if self._handle_auth_routes("POST"):
            return
        if self._is_api():
            self._proxy("POST")
        else:
            self.send_error(405)

    def do_PUT(self) -> None:  # noqa: N802
        if self._handle_auth_routes("PUT"):
            return
        if self._is_api():
            self._proxy("PUT")
        else:
            self.send_error(405)

    def do_DELETE(self) -> None:  # noqa: N802
        if self._handle_auth_routes("DELETE"):
            return
        if self._is_api():
            self._proxy("DELETE")
        else:
            self.send_error(405)

    def do_PATCH(self) -> None:  # noqa: N802
        if self._handle_auth_routes("PATCH"):
            return
        if self._is_api():
            self._proxy("PATCH")
        else:
            self.send_error(405)

    # ── logging ──────────────────────────────────────────────────────────────

    def log_message(self, fmt: str, *args: object) -> None:
        if args and "favicon" in str(args[0]):
            return
        super().log_message(fmt, *args)


def main() -> None:
    global _API_URL, _STATIC_DIR

    parser = argparse.ArgumentParser(description="SPA static file server + API reverse proxy")
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--dir", default=".")
    parser.add_argument(
        "--api-url",
        default=os.environ.get(
            "API_URL",
            f"http://127.0.0.1:{os.environ.get('PORT_API', '8765')}",
        ),
        help="API 서버 base URL (default: http://127.0.0.1:PORT_API)",
    )
    args = parser.parse_args()

    _API_URL = args.api_url.rstrip("/")
    _STATIC_DIR = os.path.abspath(args.dir)
    os.chdir(_STATIC_DIR)

    # SimpleHTTPRequestHandler가 translate_path()에서 self.directory를 사용
    SPAHandler.directory = _STATIC_DIR  # type: ignore[attr-defined]

    print(f"[spa_server] static  → {_STATIC_DIR}")
    print(f"[spa_server] /api/*  → {_API_URL}")
    print(f"[spa_server] listen  → {args.bind}:{args.port}")

    server = ThreadingHTTPServer((args.bind, args.port), SPAHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[spa_server] Shutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()

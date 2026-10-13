"""Pytest config — ensure repo root on sys.path for `import raven`.

Issue #14: ``raven.api.app`` carries an access gate (raven/core/access.py).
Starlette's ``TestClient`` reports the peer as the literal string ``"testclient"``;
in-process API tests model the local Dashboard, so they default to a loopback
peer and a loopback Host here (#15's this-PC-only endpoints look at the source).
Tests that exercise remote sources pass ``client=(...)`` explicitly.

Issue #67: the gate requires a Bearer token from every source, loopback included.
The desktop webview authenticates with its shell's session credential
(``access.set_session_token``); in-process tests do the same — every test runs
with a test session credential and every ``TestClient`` sends it by default.
Gate tests that need a tokenless client mark themselves ``no_auto_auth`` or pass
their own ``Authorization`` header. Requests made through ``httpx.ASGITransport``
or real sockets carry no token unless the test adds one.
"""
from __future__ import annotations

import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from starlette.testclient import TestClient  # noqa: E402

_LOCAL_PEER = ("127.0.0.1", 50000)
_original_init = TestClient.__init__
# Issue #67: the credential in-process tests authenticate with (see module docstring).
TEST_SESSION_TOKEN = "rvs_test_" + secrets.token_hex(16)
_AUTO_AUTH = {"on": True}


def _init_with_loopback_peer(self, *args, **kwargs):
    kwargs.setdefault("client", _LOCAL_PEER)
    # The local Dashboard dials 127.0.0.1, not TestClient's default "testserver".
    if len(args) < 2:
        kwargs.setdefault("base_url", "http://127.0.0.1")
    headers = dict(kwargs.get("headers") or {})
    if _AUTO_AUTH["on"] and not any(k.lower() == "authorization" for k in headers):
        headers["Authorization"] = f"Bearer {TEST_SESSION_TOKEN}"
        kwargs["headers"] = headers
    _original_init(self, *args, **kwargs)


TestClient.__init__ = _init_with_loopback_peer


# PR #21 audit: tailnet trust is now proven by the kernel route + `tailscale ip`
# (raven/core/access.py::is_tailnet_peer). In-process tests get a deterministic
# fake tailnet — "this host is on a tailnet, tailnet-range addresses route out of
# it" — so results do not depend on whether the CI machine runs Tailscale. Tests
# marked `real_tailnet` use the real route table instead; subprocess servers are
# never affected.
import pytest  # noqa: E402

_FAKE_TS = {"4": "100.100.0.1", "6": "fd7a:115c:a1e0::1"}


def pytest_configure(config):
    config.addinivalue_line("markers", "real_tailnet: use the host's real Tailscale/route state")
    config.addinivalue_line("markers", "no_auto_auth: TestClient sends no session credential (gate tests)")


@pytest.fixture(autouse=True)
def _core_api_test_auth(request):
    """Issue #67: a test session credential the gate accepts, sent by every TestClient."""
    from raven.core import access

    _AUTO_AUTH["on"] = not request.node.get_closest_marker("no_auto_auth")
    access.set_session_token(TEST_SESSION_TOKEN)
    yield
    access.set_session_token(None)
    _AUTO_AUTH["on"] = True


@pytest.fixture(autouse=True)
def _deterministic_tailnet(request, monkeypatch):
    if request.node.get_closest_marker("real_tailnet"):
        yield
        return
    from raven.core import access

    def route_source(ip):
        addr = access._parse_ip(ip)
        if addr is not None and any(addr in net for net in access.TAILNET_NETWORKS):
            return _FAKE_TS["6" if addr.version == 6 else "4"]
        return "192.0.2.10"

    monkeypatch.setattr(access, "_tailscale_self_ips", lambda: frozenset(_FAKE_TS.values()))
    monkeypatch.setattr(access, "_route_source", route_source)
    yield

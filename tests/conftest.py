"""Pytest config — ensure repo root on sys.path for `import raven`.

Issue #14: ``raven.api.app`` now carries an access gate (raven/core/access.py)
that judges the request by its socket address. Starlette's ``TestClient``
reports the peer as the literal string ``"testclient"`` — not an IP, so the gate
correctly refuses it. In-process API tests model the local Dashboard, so they
default to a loopback peer here. Tests that exercise remote sources pass
``client=(...)`` explicitly and are unaffected.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from starlette.testclient import TestClient  # noqa: E402

_LOCAL_PEER = ("127.0.0.1", 50000)
_original_init = TestClient.__init__


def _init_with_loopback_peer(self, *args, **kwargs):
    kwargs.setdefault("client", _LOCAL_PEER)
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

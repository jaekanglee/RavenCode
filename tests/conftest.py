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

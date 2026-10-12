"""Live network state of the process serving the API (Issue #58).

The Desktop Core registers a provider (``raven.desktop.netwatch.NetworkWatcher.
snapshot``) once it is ready; ``GET /api/system/info`` reports it as ``network``.
Other launchers register nothing and the field is ``null``. Kept in ``raven.core``
so the API does not import the desktop runtime.
"""
from __future__ import annotations

from typing import Callable

_provider: Callable[[], dict] | None = None


def set_provider(provider: Callable[[], dict] | None) -> None:
    global _provider
    _provider = provider


def snapshot() -> dict | None:
    provider = _provider
    if provider is None:
        return None
    try:
        return provider()
    except Exception as exc:  # noqa: BLE001 — system info must still answer
        return {"problems": [f"network status unavailable: {type(exc).__name__}: {exc}"]}

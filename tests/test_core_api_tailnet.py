"""Tailnet trust must be proven by the route, not by the address range (PR #21 audit).

`100.64.0.0/10` is CGNAT space: carrier LANs, other mesh VPNs and user-defined
Docker networks use it too, and `fd7a:115c:a1e0::/48` is just an address. Being
*in* those ranges proves nothing about Tailscale.

What does prove it: a TCP connection is only established after the client
received our SYN-ACK. If the kernel routes replies for that peer address out
through **this host's own Tailscale address** (the address `tailscale ip`
reports — tailscaled is the authority, not the interface name or the range),
then the SYN-ACK went into Tailscale, which only delivers to the WireGuard-
authenticated node owning that address. A LAN host spoofing a 100.x source never
sees the SYN-ACK and cannot finish the handshake.

Contract:
  1. A source in the tailnet ranges is trusted only if the route source for it is
     one of this host's Tailscale IPs.
  2. No Tailscale (CLI missing, daemon down, no IPs) → no tailnet trust (token).
  3. Range membership + a non-Tailscale route (CGNAT LAN, other VPN, Docker
     bridge) → token.
  4. The XFF-derived source of a local proxy is checked the same way (same host,
     same routing table as the proxy that saw the peer).
  5. Loopback trust is unchanged and needs no Tailscale.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import httpx
import pytest

from raven.core import access

REPO_ROOT = Path(__file__).resolve().parents[1]
SELF_TS4 = "100.121.0.9"
SELF_TS6 = "fd7a:115c:a1e0::9"


@pytest.fixture
def vaults_root(tmp_path, monkeypatch):
    root = tmp_path / "vaults"
    root.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(root))
    return root


def _routes(monkeypatch, self_ips, table):
    """Fake `tailscale ip` + kernel route-source lookup."""
    monkeypatch.setattr(access, "_tailscale_self_ips", lambda: frozenset(self_ips))
    monkeypatch.setattr(access, "_route_source", lambda ip: table(ip))


def _call(peer, headers=None):
    from raven.api import app

    transport = httpx.ASGITransport(app=app, client=(peer, 44444))

    async def go():
        async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
            return await c.get("/api/vaults", headers=headers or {})

    return asyncio.run(go())


def test_tailnet_peer_routed_through_tailscale_is_trusted(vaults_root, monkeypatch):
    _routes(monkeypatch, {SELF_TS4, SELF_TS6},
            lambda ip: SELF_TS6 if ":" in ip else SELF_TS4)
    assert _call("100.101.1.2").status_code == 200
    assert _call("fd7a:115c:a1e0::77").status_code == 200
    assert _call("::ffff:100.101.1.2").status_code == 200


@pytest.mark.parametrize("peer", ["100.64.200.3", "100.101.1.2", "fd7a:115c:a1e0::77"])
def test_range_member_on_a_non_tailscale_route_needs_token(vaults_root, monkeypatch, peer):
    # CGNAT LAN / other mesh VPN / Docker network in 100.64/10: replies leave
    # through some other interface address.
    _routes(monkeypatch, {SELF_TS4, SELF_TS6}, lambda ip: "100.64.200.1" if "." in ip else "fd00::1")
    assert _call(peer).status_code == 401, peer


@pytest.mark.parametrize("self_ips", [set(), {"192.168.0.52"}])
def test_no_tailscale_means_no_tailnet_trust(vaults_root, monkeypatch, self_ips):
    # Even when the route source happens to be a 100.x address (a CGNAT LAN).
    _routes(monkeypatch, self_ips, lambda ip: "100.64.200.1")
    assert _call("100.64.200.3").status_code == 401
    assert _call("127.0.0.1").status_code == 200  # loopback needs no Tailscale


def test_route_lookup_failure_is_fail_closed(vaults_root, monkeypatch):
    _routes(monkeypatch, {SELF_TS4}, lambda ip: None)
    assert _call("100.101.1.2").status_code == 401


def test_xff_derived_tailnet_source_is_route_checked(vaults_root, monkeypatch):
    monkeypatch.setattr(access, "_socket_peer", True)
    _routes(monkeypatch, {SELF_TS4}, lambda ip: SELF_TS4 if ip.startswith("100.101.") else "100.64.200.1")
    assert _call("127.0.0.1", {"X-Forwarded-For": "100.101.1.2"}).status_code == 200
    assert _call("127.0.0.1", {"X-Forwarded-For": "100.64.200.3"}).status_code == 401


def test_mcp_gate_uses_the_same_route_check(monkeypatch, tmp_path):
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    from raven.mcp.auth import LanTokenAuth

    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path))
    _routes(monkeypatch, {SELF_TS4}, lambda ip: "100.64.200.1")

    async def ok(_r):
        return PlainTextResponse("ok")

    app = LanTokenAuth(Starlette(routes=[Route("/mcp", ok, methods=["POST"])]))
    transport = httpx.ASGITransport(app=app, client=("100.64.200.3", 1))

    async def go():
        async with httpx.AsyncClient(transport=transport, base_url="http://raven") as c:
            return await c.post("/mcp")

    assert asyncio.run(go()).status_code == 401


@pytest.mark.real_tailnet
def test_self_ips_come_from_tailscale_not_from_interface_guessing(monkeypatch):
    """`tailscale ip` output is parsed; anything unparsable or outside the ranges is dropped."""
    access._TS_CACHE.clear()
    monkeypatch.setattr(access, "_tailscale_binary", lambda: "/bin/fake-tailscale")

    def fake_run(argv, **kw):
        return subprocess.CompletedProcess(argv, 0, stdout="100.121.0.9\nfd7a:115c:a1e0::9\n192.168.0.5\njunk\n", stderr="")

    monkeypatch.setattr(access.subprocess, "run", fake_run)
    assert access._tailscale_self_ips() == frozenset({"100.121.0.9", "fd7a:115c:a1e0::9"})

    access._TS_CACHE.clear()
    monkeypatch.setattr(access, "_tailscale_binary", lambda: None)
    assert access._tailscale_self_ips() == frozenset()

    access._TS_CACHE.clear()
    monkeypatch.setattr(access, "_tailscale_binary", lambda: "/bin/fake-tailscale")

    def failing(argv, **kw):
        raise subprocess.TimeoutExpired(argv, 2)

    monkeypatch.setattr(access.subprocess, "run", failing)
    assert access._tailscale_self_ips() == frozenset()
    access._TS_CACHE.clear()


# ─── real network: this host's own route table ───


@pytest.mark.real_tailnet
def test_real_route_source_for_tailnet_on_this_host():
    """On a host running Tailscale, a tailnet-range address routes out of our TS address,
    and a LAN address does not."""
    access._TS_CACHE.clear()
    ips = access._tailscale_self_ips()
    if not ips:
        pytest.skip("Tailscale not running on this host")
    v4 = next(ip for ip in ips if "." in ip)
    assert access._route_source(v4) in ips                 # self
    assert access._route_source("100.101.1.2") in ips      # any tailnet-range peer
    assert access.is_trusted_client("100.101.1.2") is True
    assert access.is_trusted_client("192.168.1.50") is False

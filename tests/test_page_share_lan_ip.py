"""get_lan_ip() — LAN(192.168/10/172.16-31) IP 감지, Tailscale(100.64.0.0/10)과 구분.

배경: 페이지 공유 링크가 내부망 IP를 표시하려면 Tailscale IP와 겹치지 않는
전용 감지 로직이 필요하다 (docs/superpowers/specs/2026-09-04-page-share-link-design.md).
"""
from __future__ import annotations

import socket
from unittest.mock import MagicMock, patch

from raven.api.main import get_lan_ip


def _mock_socket_returning(ip: str) -> MagicMock:
    mock_sock = MagicMock()
    mock_sock.getsockname.return_value = (ip, 0)
    return mock_sock


def test_get_lan_ip_returns_192_168_address():
    with patch("socket.socket", return_value=_mock_socket_returning("192.168.1.42")):
        assert get_lan_ip() == "192.168.1.42"


def test_get_lan_ip_returns_10_x_address():
    with patch("socket.socket", return_value=_mock_socket_returning("10.0.0.5")):
        assert get_lan_ip() == "10.0.0.5"


def test_get_lan_ip_returns_172_16_31_address():
    with patch("socket.socket", return_value=_mock_socket_returning("172.20.3.9")):
        assert get_lan_ip() == "172.20.3.9"


def test_get_lan_ip_rejects_tailscale_address():
    """100.64.0.0/10 대역은 Tailscale IP이므로 LAN IP로 반환하면 안 된다."""
    with patch("socket.socket", return_value=_mock_socket_returning("100.64.0.1")):
        with patch("socket.gethostbyname_ex", return_value=("host", [], ["100.64.0.1"])):
            assert get_lan_ip() is None


def test_get_lan_ip_returns_none_when_no_network():
    with patch("socket.socket", side_effect=OSError("network unreachable")):
        with patch("socket.gethostbyname_ex", side_effect=OSError("no network")):
            assert get_lan_ip() is None

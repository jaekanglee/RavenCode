"""Issue #58: the Desktop Core follows the Tailscale address while it runs.

The tailnet address is simulated with a non-loopback address of this host (as in
the #50/#54 tests); the real tailnet is never touched. The lookup itself is
covered with a fake socket module.
"""
from __future__ import annotations

import errno
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

import pytest

from raven.desktop import netwatch
from raven.desktop import runtime as rt

REPO_ROOT = Path(__file__).resolve().parents[1]
MACOS = sys.platform == "darwin"


def _local_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # TEST-NET-1; UDP connect sends nothing
            ip = s.getsockname()[0]
    except OSError:
        return None
    return None if ip in ("0.0.0.0", "127.0.0.1") else ip


LAN = _local_ip()
needs_lan = pytest.mark.skipif(LAN is None, reason="needs a non-loopback address to stand in for the tailnet IP")


# ── lookup ──────────────────────────────────────────────────────────────────


class _FakeSocket:
    """socket.socket stand-in: UDP connect reports ``source``; TCP bind may fail."""

    source: str | OSError = "100.101.102.103"
    bind_error: OSError | None = None

    def __init__(self, family, kind, *a):
        self.kind = kind

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def connect(self, addr):
        if isinstance(self.source, OSError):
            raise self.source

    def getsockname(self):
        return (self.source, 5555)

    def bind(self, addr):
        if self.bind_error is not None:
            raise self.bind_error


@pytest.mark.parametrize(
    "source, bind_error, state",
    [
        ("100.101.102.103", None, "ip"),
        ("192.168.1.20", None, "none"),  # the route goes elsewhere: no tailnet
        ("100.20.0.1", None, "none"),  # 100.x outside 100.64.0.0/10 is not a tailnet address
        (OSError(errno.ENETUNREACH, "unreachable"), None, "none"),
        (OSError(errno.EMFILE, "too many files"), None, "error"),
        ("100.101.102.103", OSError(errno.EADDRNOTAVAIL, "not here"), "none"),  # userspace mode
        ("100.101.102.103", OSError(errno.EACCES, "denied"), "error"),
    ],
)
def test_lookup_distinguishes_an_address_no_tailnet_and_a_failure(monkeypatch, source, bind_error, state) -> None:
    fake = type("S", (_FakeSocket,), {"source": source, "bind_error": bind_error})
    monkeypatch.setattr(netwatch.socket, "socket", fake)
    result = netwatch.lookup_tailscale()
    assert result.state == state, result
    assert (result.ip == source) == (state == "ip")


def test_lookup_on_this_host_answers_quickly_without_dns() -> None:
    started = time.monotonic()
    result = netwatch.lookup_tailscale()
    assert result.state in ("ip", "none", "error")
    assert time.monotonic() - started < 1.0


@pytest.mark.parametrize("ip", ["", "0.0.0.0", "127.0.0.1", "::1", "224.0.0.1", "not-an-ip", None])
def test_a_lookup_result_that_is_not_a_host_address_is_an_error(ip) -> None:
    assert netwatch._checked(netwatch.Lookup("ip", ip)).state == "error"
    assert netwatch._checked(netwatch.Lookup("ip", "100.64.1.2")) == netwatch.Lookup("ip", "100.64.1.2")


def test_the_watcher_never_guards_or_advertises_a_bogus_lookup_result() -> None:
    """``""`` would bind the wildcard itself: it must be a failed lookup, not an address."""
    rig = _Rig(_Switch(""))
    try:
        rig.lookup.value = ""
        rig.watcher._lookup = lambda: netwatch.Lookup("ip", "")
        rig.ticks(3)
        assert rig.events == []
        snap = rig.watcher.snapshot()
        assert snap["tailscale"]["state"] == "error"
        assert snap["mcp"]["advertised"] == "127.0.0.1"
        assert rig.watcher.mcp.held == {} and rig.watcher.api.held == {}
    finally:
        rig.close()


def test_a_slow_lookup_times_out_and_is_not_started_twice() -> None:
    calls = []
    release = threading.Event()

    def slow():
        calls.append(1)
        release.wait(5)
        return netwatch.Lookup("ip", "100.64.0.9")

    timed = netwatch.TimedLookup(slow, timeout=0.2)
    started = time.monotonic()
    first = timed()
    assert first.state == "error" and "longer than" in first.detail
    assert time.monotonic() - started < 1.0
    second = timed()
    assert second.state == "error" and "still running" in second.detail
    assert len(calls) == 1
    release.set()
    time.sleep(0.1)
    assert timed() == netwatch.Lookup("ip", "100.64.0.9")


def test_a_lookup_that_raises_is_an_error_not_a_crash() -> None:
    def broken():
        raise RuntimeError("boom")

    result = netwatch.TimedLookup(broken, timeout=1)()
    assert result.state == "error" and "boom" in result.detail


# ── serving an extra socket on a running uvicorn server ─────────────────────


async def _app(scope, receive, send):
    if scope["type"] != "http":
        return
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ours"})


def _listen(host: str, port: int = 0) -> socket.socket:
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(64)
    return sock


class _Served:
    """A real uvicorn server on ``host`` with the #22 probe responder, in a thread."""

    def __init__(self, host: str = "0.0.0.0", app=_app) -> None:
        import uvicorn

        self.sock = _listen(host)
        self.port = self.sock.getsockname()[1]
        self.nonce = "n" * 32
        self.responder = rt._ProbeResponder(app, self.nonce)
        self.server = uvicorn.Server(uvicorn.Config(self.responder, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, kwargs={"sockets": [self.sock]}, daemon=True)
        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started:
            assert time.monotonic() < deadline, "uvicorn did not start"
            time.sleep(0.02)

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(10)
        assert not self.thread.is_alive()


def _get(host: str, port: int) -> str:
    with urlopen(f"http://{host}:{port}/", timeout=3) as r:
        return r.read().decode()


def test_an_attached_socket_is_served_and_closed_with_the_server() -> None:
    served = _Served("127.0.0.1")
    extra = _listen("127.0.0.1")
    extra_port = extra.getsockname()[1]
    try:
        netwatch.serve_socket(served.server, extra)
        assert _get("127.0.0.1", extra_port) == "ours"
    finally:
        served.stop()
    with pytest.raises(OSError):
        socket.create_connection(("127.0.0.1", extra_port), timeout=1).close()


def test_nothing_is_attached_to_a_server_that_is_stopping() -> None:
    served = _Served("127.0.0.1")
    extra = _listen("127.0.0.1")
    try:
        served.server.should_exit = True
        with pytest.raises(RuntimeError):
            netwatch.serve_socket(served.server, extra)
    finally:
        extra.close()
        served.stop()


# ── the watcher ─────────────────────────────────────────────────────────────


class _Switch:
    """A lookup the test flips between an address, none and error."""

    def __init__(self, value: str | None = None) -> None:
        self.value = value

    def __call__(self) -> netwatch.Lookup:
        if self.value is None:
            return netwatch.Lookup("none")
        if self.value == "error":
            return netwatch.Lookup("error", detail="simulated")
        return netwatch.Lookup("ip", self.value)


class _Rig:
    """Wildcard API + MCP servers and a watcher over them (ticked by hand)."""

    def __init__(self, lookup: _Switch, **kw) -> None:
        self.api = _Served()
        self.mcp = _Served()
        self.events: list[dict] = []
        self.logs: list[str] = []
        self.lookup = lookup
        self.watcher = netwatch.NetworkWatcher(
            lookup=lookup,
            emit=self.events.append,
            bind_guard=rt._bind_guard,
            is_self=rt._endpoint_is_self,
            api_bind_host="0.0.0.0",
            api_port=self.api.port,
            api_endpoint_host="127.0.0.1",
            api=netwatch.Listener("API", self.api.server, self.api.port, self.api.responder, self.api.nonce),
            mcp=netwatch.Listener("MCP", self.mcp.server, self.mcp.port, self.mcp.responder, self.mcp.nonce),
            mcp_bind_host="0.0.0.0",
            mcp_port=self.mcp.port,
            mcp_advertised="127.0.0.1",
            log=self.logs.append,
            **kw,
        )

    def ticks(self, n: int) -> None:
        for _ in range(n):
            self.watcher.tick()

    def close(self) -> None:
        self.watcher.stop()
        self.api.stop()
        self.mcp.stop()


def _intruder_binds(host: str, port: int) -> bool:
    """Can another socket take host:port (SO_REUSEADDR + SO_REUSEPORT)?"""
    s = socket.socket()
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        s.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


@needs_lan
def test_an_address_that_appears_later_is_held_then_advertised() -> None:
    rig = _Rig(_Switch(None))
    try:
        rig.ticks(2)
        assert rig.events == []
        if MACOS:  # before: the #54 path is open on the new address
            assert _intruder_binds(LAN, rig.mcp.port)
        rig.lookup.value = LAN
        rig.ticks(1)
        # Held from the first tick that sees it — before it is advertised.
        assert not _intruder_binds(LAN, rig.mcp.port)
        assert not _intruder_binds(LAN, rig.api.port)
        assert rig.events == []
        rig.ticks(1)
        assert rig.events == [{"event": "mcp_endpoint", "mcp_host": LAN, "mcp_port": rig.mcp.port}]
        assert _get(LAN, rig.mcp.port) == "ours"
        snap = rig.watcher.snapshot()
        assert snap["mcp"]["advertised"] == LAN
        assert snap["mcp"]["tailnet"]["state"] == snap["api"]["tailnet"]["state"] == "protected"
        assert snap["problems"] == []
    finally:
        rig.close()
    # Guards close with their server.
    for port in (rig.mcp.port, rig.api.port):
        with pytest.raises(OSError):
            socket.create_connection((LAN, port), timeout=1).close()


@needs_lan
def test_a_vanished_address_is_withdrawn_but_its_guard_is_kept_for_its_return() -> None:
    rig = _Rig(_Switch(LAN))
    try:
        rig.ticks(2)
        rig.lookup.value = None
        rig.ticks(1)
        assert rig.events[-1]["mcp_host"] == LAN  # one tick of absence is a flap
        rig.ticks(1)
        assert rig.events[-1] == {"event": "mcp_endpoint", "mcp_host": "127.0.0.1", "mcp_port": rig.mcp.port}
        assert not _intruder_binds(LAN, rig.mcp.port)  # still held while away
        rig.lookup.value = LAN
        rig.ticks(2)
        assert rig.events[-1]["mcp_host"] == LAN
        assert len(rig.events) == 3
    finally:
        rig.close()


@needs_lan
def test_a_short_flap_does_not_move_the_endpoint() -> None:
    rig = _Rig(_Switch(LAN))
    try:
        rig.ticks(2)
        before = list(rig.events)
        rig.lookup.value = None
        rig.ticks(1)
        rig.lookup.value = LAN
        rig.ticks(3)
        assert rig.events == before
    finally:
        rig.close()


@needs_lan
def test_a_failed_lookup_changes_nothing() -> None:
    rig = _Rig(_Switch(LAN))
    try:
        rig.ticks(2)
        before = list(rig.events)
        rig.lookup.value = "error"
        rig.ticks(5)
        assert rig.events == before
        snap = rig.watcher.snapshot()
        assert snap["mcp"]["advertised"] == LAN
        assert snap["tailscale"]["state"] == "error"
        assert snap["problems"] == ["Tailscale lookup failed: simulated"]
    finally:
        rig.close()


@needs_lan
@pytest.mark.skipif(not MACOS, reason="Linux refuses the squatter's bind next to our wildcard (#49)")
def test_an_address_held_by_another_process_is_reported_and_never_advertised() -> None:
    rig = _Rig(_Switch(None))
    squatter = _listen(LAN, rig.mcp.port)
    try:
        rig.lookup.value = LAN
        rig.ticks(4)
        assert {"event": "alert", "kind": "guard_blocked", "listener": "MCP", "address": f"{LAN}:{rig.mcp.port}"} in rig.events
        assert not any(e.get("mcp_host") == LAN for e in rig.events)
        snap = rig.watcher.snapshot()
        assert snap["mcp"]["advertised"] == "127.0.0.1"
        assert snap["mcp"]["tailnet"]["state"] == "blocked"
        assert any("MCP" in p and "blocked" in p for p in snap["problems"])
        rig.ticks(3)
        assert sum(e["event"] == "alert" for e in rig.events) == 1  # once, not every tick
        squatter.close()
        rig.ticks(2)
        assert rig.events[-1] == {"event": "mcp_endpoint", "mcp_host": LAN, "mcp_port": rig.mcp.port}
        assert not _intruder_binds(LAN, rig.mcp.port)
    finally:
        squatter.close()
        rig.close()


@needs_lan
def test_an_address_this_core_does_not_answer_is_not_advertised() -> None:
    rig = _Rig(_Switch(None))
    rig.watcher._is_self = lambda *a: False
    try:
        rig.lookup.value = LAN
        rig.ticks(4)
        assert rig.events == []
        snap = rig.watcher.snapshot()
        assert snap["mcp"]["tailnet"]["state"] == "error"
        assert snap["mcp"]["advertised"] == "127.0.0.1"
    finally:
        rig.close()


def test_an_address_not_assigned_yet_is_pending_and_not_advertised() -> None:
    rig = _Rig(_Switch("192.0.2.77"))  # TEST-NET-1: not on this host
    try:
        rig.ticks(3)
        assert rig.events == []
        assert rig.watcher.snapshot()["mcp"]["tailnet"]["state"] == "pending"
    finally:
        rig.close()


@needs_lan
def test_an_advertised_address_that_stops_answering_is_withdrawn_at_once() -> None:
    rig = _Rig(_Switch(LAN))
    try:
        rig.ticks(2)
        assert rig.watcher.mcp_advertised == LAN
        rig.lookup.value = None
        rig.ticks(1)
        rig.watcher._is_self = lambda *a: False
        rig.lookup.value = LAN  # comes back, but the recheck fails
        rig.ticks(1)
        assert rig.watcher.mcp_advertised == "127.0.0.1"
    finally:
        rig.close()


def _bind_watcher(lookup, clock, events, bound="100.64.0.5"):
    return netwatch.NetworkWatcher(
        lookup=lookup,
        emit=events.append,
        bind_guard=rt._bind_guard,
        is_self=lambda *a: True,
        api_bind_host=bound or "127.0.0.1",
        api_port=1,
        api_endpoint_host=bound or "127.0.0.1",
        tailscale_requested=True,
        tailscale_bound=bound,
        rebind_after=5.0,
        rebind_retry=30.0,
        clock=lambda: clock[0],
        log=lambda m: None,
    )


@pytest.mark.parametrize(
    "bound, now, target",
    [("100.64.0.5", None, "127.0.0.1"), ("100.64.0.5", "100.64.0.9", "100.64.0.9"), (None, "100.64.0.9", "100.64.0.9")],
)
def test_a_specific_tailnet_bind_asks_for_a_restart_once_the_change_lasts(bound, now, target) -> None:
    clock, events = [0.0], []
    lookup = _Switch(bound)
    w = _bind_watcher(lookup, clock, events, bound)
    w.tick()
    lookup.value = now
    for t in (1.0, 3.0, 4.9):
        clock[0] = t
        w.tick()
    assert events == []
    clock[0] = 6.1
    w.tick()
    assert events == [{"event": "rebind", "bound": bound or "127.0.0.1", "tailscale_ip": now, "target": target}]
    assert w.snapshot()["api"]["restart_requested"] is True
    clock[0] = 30.0
    w.tick()
    assert len(events) == 1  # not again before rebind_retry
    clock[0] = 36.2
    w.tick()
    assert len(events) == 2
    lookup.value = bound
    clock[0] = 70.0
    w.tick()
    assert w.snapshot()["api"]["restart_requested"] is False


def test_a_short_flap_of_a_specific_tailnet_bind_does_not_restart() -> None:
    clock, events = [0.0], []
    lookup = _Switch("100.64.0.5")
    w = _bind_watcher(lookup, clock, events)
    for t, value in ((1, None), (3, "100.64.0.5"), (5, None), (9, "100.64.0.5"), (12, None), (16, "100.64.0.5")):
        lookup.value = value
        clock[0] = t
        w.tick()
    assert events == []


def test_a_failed_lookup_never_triggers_a_restart() -> None:
    clock, events = [0.0], []
    lookup = _Switch("error")
    w = _bind_watcher(lookup, clock, events)
    for t in range(0, 200, 5):
        clock[0] = t
        w.tick()
    assert events == []


def test_the_watcher_thread_stops_promptly_and_survives_a_bad_check() -> None:
    calls = []

    def lookup():
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("bad check")
        return netwatch.Lookup("none")

    w = netwatch.NetworkWatcher(
        lookup=lookup, emit=lambda e: None, bind_guard=rt._bind_guard, is_self=lambda *a: True,
        api_bind_host="127.0.0.1", api_port=1, api_endpoint_host="127.0.0.1", interval=0.05, log=lambda m: None,
    )
    w.start()
    time.sleep(0.5)
    started = time.monotonic()
    assert w.stop(timeout=2)
    assert time.monotonic() - started < 1.5
    assert len(calls) >= 4  # kept going after the exception
    after = len(calls)
    time.sleep(0.3)
    assert len(calls) == after
    assert not any(t.name == "raven-netwatch" and t.is_alive() for t in threading.enumerate())


def test_idle_watcher_checks_about_once_per_interval() -> None:
    calls = []
    w = netwatch.NetworkWatcher(
        lookup=lambda: calls.append(1) or netwatch.Lookup("none"), emit=lambda e: None,
        bind_guard=rt._bind_guard, is_self=lambda *a: True,
        api_bind_host="127.0.0.1", api_port=1, api_endpoint_host="127.0.0.1", interval=0.2, log=lambda m: None,
    )
    w.start()
    time.sleep(2.1)
    w.stop()
    # ~10 at 0.2 s; routing-socket wakeups (macOS) may add a few, never a busy loop.
    assert 5 <= len(calls) <= 30, len(calls)


def test_address_change_messages_wake_the_watcher_and_others_do_not() -> None:
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
    a.setblocking(False)
    try:
        b.send(bytes([0, 0, 5, 0x1]))  # RTM_ADD (a route, e.g. ARP) — ignored
        assert netwatch._drain_address_changes(a) is False
        b.send(bytes([0, 0, 5, 0x1]))
        b.send(bytes([0, 0, 5, 0xC]))  # RTM_NEWADDR
        assert netwatch._drain_address_changes(a) is True
        assert netwatch._drain_address_changes(a) is False  # drained
    finally:
        a.close()
        b.close()


def test_events_stop_quietly_when_the_shell_pipe_is_gone() -> None:
    def broken(line):
        raise BrokenPipeError(32, "Broken pipe")

    emit = netwatch.EventStream(broken)
    emit({"event": "mcp_endpoint"})
    emit({"event": "mcp_endpoint"})


def test_after_readiness_stdout_carries_events_only() -> None:
    script = (
        "import os, sys, subprocess\n"
        "from raven.desktop import netwatch\n"
        "print('readiness', flush=True)\n"
        "emit = netwatch.EventStream.take_stdout()\n"
        "print('stray print')\n"
        "subprocess.run(['echo', 'child output'])\n"
        "emit({'event': 'mcp_endpoint', 'mcp_host': '127.0.0.1', 'mcp_port': 1})\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", script], cwd=REPO_ROOT, capture_output=True, text=True, timeout=30,
        env=dict(os.environ, PYTHONPATH=str(REPO_ROOT)),
    )
    assert out.returncode == 0, out.stderr
    lines = out.stdout.splitlines()
    assert lines[0] == "readiness"
    assert [json.loads(line) for line in lines[1:]] == [{"event": "mcp_endpoint", "mcp_host": "127.0.0.1", "mcp_port": 1}]
    assert "stray print" in out.stderr and "child output" in out.stderr


# ── end to end: the real Core ───────────────────────────────────────────────

_CORE_WITH_SWITCH = r"""
import sys
from raven.desktop import netwatch
ctl = sys.argv.pop(1)
def lookup():
    value = open(ctl).read().strip()
    return netwatch.Lookup("none") if value == "none" else netwatch.Lookup("ip", value)
netwatch.lookup_tailscale = lookup
from raven.desktop.runtime import main
sys.exit(main())
"""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _set(ctl: Path, value: str) -> None:
    tmp = ctl.with_suffix(".tmp")
    tmp.write_text(value)
    os.replace(tmp, ctl)


def _next_event(core: subprocess.Popen[str], timeout: float = 10.0) -> dict:
    import select

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        readable, _, _ = select.select([core.stdout], [], [], 0.1)
        if readable:
            line = core.stdout.readline()
            if line:
                return json.loads(line)
    raise AssertionError("no event from the Core")


def _start(tmp_path: Path, initial: str, *argv: str) -> tuple[subprocess.Popen[str], Path, int, int]:
    ctl = tmp_path / "ctl"
    _set(ctl, initial)
    api_port, mcp_port = _free_port(), _free_port()
    home = tmp_path / "home"
    home.mkdir()
    env = {
        **{k: v for k, v in os.environ.items() if not k.startswith(("RAVEN_", "WIKI_", "PORT_"))},
        "HOME": str(home), "WIKI_VAULTS_DIR": str(tmp_path / "vaults"), "RAVEN_ALLOW_REMOTE": "1",
        "PORT_API": str(api_port), "PYTHONPATH": str(REPO_ROOT), "GEMINI_API_KEY": "",
    }
    core = subprocess.Popen(
        [sys.executable, "-c", _CORE_WITH_SWITCH, str(ctl), *argv, "--mcp", "--mcp-port", str(mcp_port)],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    ready = json.loads(core.stdout.readline())
    assert ready["port"] == api_port, ready
    return core, ctl, api_port, mcp_port


def _info(port: int) -> dict:
    with urlopen(f"http://127.0.0.1:{port}/api/system/info", timeout=5) as r:
        return json.load(r)


def _code(host: str, port: int, path: str = "/mcp") -> int:
    try:
        with urlopen(f"http://{host}:{port}{path}", timeout=3) as r:
            return r.status
    except HTTPError as e:
        return e.code


@needs_lan
def test_core_holds_and_advertises_a_tailnet_address_that_comes_up_later(tmp_path: Path) -> None:
    core, ctl, api_port, mcp_port = _start(tmp_path, "none", "--host", "0.0.0.0")
    try:
        assert _info(api_port)["network"]["mcp"]["advertised"] == "127.0.0.1"
        _set(ctl, LAN)
        assert _next_event(core) == {"event": "mcp_endpoint", "mcp_host": LAN, "mcp_port": mcp_port}
        assert not _intruder_binds(LAN, mcp_port)
        assert not _intruder_binds(LAN, api_port)
        # Auth is unchanged on the new address: no token, no access.
        assert _code(LAN, mcp_port) == 401
        assert _code(LAN, api_port, "/api/vaults") == 401
        net = _info(api_port)["network"]
        assert net["tailscale"]["ip"] == LAN
        assert net["mcp"]["tailnet"] == {"address": f"{LAN}:{mcp_port}", "state": "protected", "detail": ""}
        assert net["api"]["tailnet"]["state"] == "protected"
        assert net["problems"] == []
    finally:
        core.terminate()
        assert core.wait(timeout=15) == 0
    for port in (api_port, mcp_port):
        for host in ("127.0.0.1", LAN):
            with pytest.raises(OSError):
                socket.create_connection((host, port), timeout=1).close()
    assert not any(t for t in ("Traceback", "watcher did not stop") if t in core.stderr.read())


def test_core_on_loopback_reports_the_tailnet_but_never_listens_there(tmp_path: Path) -> None:
    core, ctl, api_port, mcp_port = _start(tmp_path, "100.64.77.1", "--host", "127.0.0.1")
    try:
        net = _info(api_port)["network"]
        assert net["api"]["bind_host"] == "127.0.0.1"
        assert net["api"]["tailnet"]["state"] == "not_listening"
        assert net["mcp"]["advertised"] == "127.0.0.1"
    finally:
        core.terminate()
        assert core.wait(timeout=15) == 0


def test_standalone_api_reports_no_network_state() -> None:
    from fastapi.testclient import TestClient

    from raven.api.server import app
    from raven.core import network_status

    network_status.set_provider(None)
    assert TestClient(app).get("/api/system/info").json()["network"] is None

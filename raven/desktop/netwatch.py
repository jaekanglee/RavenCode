"""Desktop Core — follow the Tailscale address while the Core runs (Issue #58).

The Core used to decide its Tailscale address once, at start, and keep every
network value derived from it: the ``--host tailscale`` bind, the readiness
endpoint, the advertised MCP address and the #54 MCP guard. A tailnet that came
up later, or a new Tailscale IP, left those behind:

* wildcard mode (``0.0.0.0``): the new ``IP:P`` was served by the wildcard
  socket but held by nobody, so on macOS another process could bind it and take
  the agents' requests, Bearer token included (the #54 path, reopened);
* ``--host tailscale`` (one specific address): the API and MCP stayed on the old
  address, and the webview with them.

``NetworkWatcher`` checks the address every second (sooner on macOS, where a
routing socket reports address changes) and keeps the Core consistent with it:

* wildcard API/MCP: the new address is held by a guard socket that the running
  uvicorn server also serves (``serve_socket``), and is checked with the per-start
  identity probe. Only then is it advertised. A guard that cannot be held is
  reported (stderr, an ``alert`` event, ``/api/system/info``) and the advertised
  MCP address stays on loopback — never on an address another process answers.
  Guards are kept until the Core exits, so an address that goes away and comes
  back is protected the moment it returns.
* ``--host tailscale``: the sockets cannot move, so once the mismatch has lasted
  ``rebind_after`` seconds the Core asks the shell for a restart (``rebind``
  event); the shell restarts it through its #44 path. Asked again only after
  ``rebind_retry`` seconds.

A failed lookup (error, timeout) is not "no tailnet": it changes nothing.

Events go to the shell on stdout, one JSON object per line after readiness. The
runtime moves fd 1 to stderr once readiness is out (``EventStream``), so nothing
else in the process — a stray ``print``, a subprocess — can write an event.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import errno
import functools
import ipaddress
import json
import os
import select
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

LOOPBACK_HOST = "127.0.0.1"
TAILNET = ipaddress.ip_network("100.64.0.0/10")
# Tailscale's own service address; the route to it goes over the tailnet interface.
TAILSCALE_SERVICE_IP = "100.100.100.100"

LOOKUP_TIMEOUT = 2.0
POLL_INTERVAL = 1.0
# A routing-socket wakeup is followed by this pause: address changes come in bursts.
WAKE_SETTLE = 0.2
ATTACH_TIMEOUT = 5.0


@dataclass(frozen=True)
class Lookup:
    """One Tailscale address check: ``ip`` (an address), ``none`` or ``error``."""

    state: str
    ip: str | None = None
    detail: str = ""


def lookup_tailscale() -> Lookup:
    """This host's tailnet IPv4 address, without DNS.

    Connecting a UDP socket sends nothing; it only asks the routing table which
    source address reaches Tailscale's service address. Outside 100.64.0.0/10
    the route goes elsewhere: no tailnet. The address must also be bindable
    here — Tailscale's userspace mode routes the range without owning an address.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect((TAILSCALE_SERVICE_IP, 80))
            ip = probe.getsockname()[0]
    except OSError as exc:
        if exc.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EADDRNOTAVAIL):
            return Lookup("none", detail="no route to the tailnet")
        return Lookup("error", detail=f"route lookup failed: {exc}")
    try:
        on_tailnet = ipaddress.ip_address(ip) in TAILNET
    except ValueError:
        return Lookup("error", detail=f"unexpected source address {ip!r}")
    if not on_tailnet:
        return Lookup("none")
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as test:
            test.bind((ip, 0))
    except OSError as exc:
        if exc.errno == errno.EADDRNOTAVAIL:
            return Lookup("none", detail=f"{ip} is routed but not assigned to this host")
        return Lookup("error", detail=f"cannot bind {ip}: {exc}")
    return Lookup("ip", ip)


def _checked(result: Lookup) -> Lookup:
    """Refuse an ``ip`` result that is not one usable IPv4 host address.

    Binding ``""`` or ``0.0.0.0`` would mean the wildcard itself; whatever the
    lookup returned, only a plain unicast IPv4 address is treated as an address.
    """
    if result.state != "ip":
        return result
    try:
        ip = ipaddress.ip_address(result.ip or "")
    except ValueError:
        return Lookup("error", detail=f"lookup returned {result.ip!r}, not an IPv4 address")
    if ip.version != 4 or ip.is_unspecified or ip.is_loopback or ip.is_multicast:
        return Lookup("error", detail=f"lookup returned {result.ip!r}, not a host address")
    return Lookup("ip", str(ip), result.detail)


class TimedLookup:
    """Run a lookup on a worker thread and give up after ``timeout`` seconds.

    A lookup still running from an earlier call is not joined by a second one:
    that call reports an error at once, so a stuck lookup costs one thread, not
    one per tick.
    """

    def __init__(self, lookup: Callable[[], Lookup], timeout: float = LOOKUP_TIMEOUT) -> None:
        self._lookup = lookup
        self._timeout = timeout
        self._running: threading.Event | None = None

    def __call__(self) -> Lookup:
        if self._running is not None and not self._running.is_set():
            return Lookup("error", detail="an earlier Tailscale lookup is still running")
        done = threading.Event()
        box: list[Lookup] = []

        def run() -> None:
            try:
                box.append(self._lookup())
            except Exception as exc:  # noqa: BLE001 — a lookup bug is a failed lookup
                box.append(Lookup("error", detail=f"{type(exc).__name__}: {exc}"))
            finally:
                done.set()

        self._running = done
        threading.Thread(target=run, name="raven-tailscale-lookup", daemon=True).start()
        if not done.wait(self._timeout):
            return Lookup("error", detail=f"Tailscale lookup took longer than {self._timeout:g}s")
        return box[0]


def attach_socket(server, sock: socket.socket) -> concurrent.futures.Future:
    """Start making a running uvicorn ``server`` accept on ``sock`` as well.

    uvicorn takes its sockets only at start. This builds the same protocol
    factory its ``startup`` uses and adds the listener on the server's own event
    loop, so it is served like the others and closed by uvicorn's shutdown. A
    listener added after shutdown began is closed at once. The returned future
    fails if it could not be added; ``sock`` then stays open, bound and
    unserved — the caller decides. Raises at once if the server is not running.
    """
    if not getattr(server, "started", False) or not getattr(server, "servers", None):
        raise RuntimeError("the server is not running")
    loop = server.servers[0].get_loop()

    async def attach() -> None:
        if server.should_exit:
            raise RuntimeError("the server is shutting down")
        config = server.config
        factory = functools.partial(
            config.http_protocol_class,
            config=config,
            server_state=server.server_state,
            app_state=server.lifespan.state,
        )
        listener = await asyncio.get_running_loop().create_server(factory, sock=sock, backlog=config.backlog)
        server.servers.append(listener)
        if server.should_exit:
            listener.close()

    return asyncio.run_coroutine_threadsafe(attach(), loop)


def serve_socket(server, sock: socket.socket, timeout: float = ATTACH_TIMEOUT) -> None:
    """``attach_socket`` and wait for it (raises on failure or timeout)."""
    attach_socket(server, sock).result(timeout)


@dataclass
class Listener:
    """A wildcard (``0.0.0.0``) uvicorn listener whose tailnet address is guarded."""

    name: str
    server: object
    port: int
    responder: object
    nonce: str
    # Address → guard socket (None: Linux already keeps others off it, #49).
    held: dict[str, socket.socket | None] = field(default_factory=dict)
    # Address → "protected" | "blocked" | "pending" | "error".
    state: dict[str, str] = field(default_factory=dict)
    detail: dict[str, str] = field(default_factory=dict)
    # Guards bound but not yet served (attach failed); retried every tick.
    unserved: dict[str, socket.socket] = field(default_factory=dict)
    # An attach still in flight after its timeout: its outcome is used, never repeated.
    attaching: dict[str, concurrent.futures.Future] = field(default_factory=dict)


class EventStream:
    """The shell's event channel: stdout, kept for events only.

    ``take_stdout`` duplicates fd 1 for events and points fd 1 at stderr, so a
    later ``print`` or a child process can no longer write a line the shell
    would read as an event. A closed pipe (shell gone) silences the stream.
    """

    def __init__(self, write: Callable[[str], None]) -> None:
        self._write = write
        self._lock = threading.Lock()
        self._broken = False

    @classmethod
    def take_stdout(cls) -> EventStream:
        sys.stdout.flush()
        out = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
        os.dup2(2, 1)

        def write(line: str) -> None:
            out.write(line)
            out.flush()

        return cls(write)

    def __call__(self, event: dict) -> None:
        line = json.dumps(event, ensure_ascii=False) + "\n"
        with self._lock:
            if self._broken:
                return
            try:
                self._write(line)
            except (OSError, ValueError):
                self._broken = True


def _route_socket() -> socket.socket | None:
    """A routing socket that reports address changes (macOS/BSD), else None."""
    family = getattr(socket, "AF_ROUTE", None)
    if family is None or sys.platform.startswith("linux"):
        return None
    try:
        sock = socket.socket(family, socket.SOCK_RAW, 0)
    except OSError:
        return None
    sock.setblocking(False)
    return sock


# rt_msghdr / ifa_msghdr: u_short msglen, u_char version, u_char type.
_RTM_ADDRESS_TYPES = {0xC, 0xD, 0xE}  # RTM_NEWADDR, RTM_DELADDR, RTM_IFINFO


def _drain_address_changes(sock: socket.socket) -> bool:
    """Read every queued routing message; True if one was an address/interface change."""
    changed = False
    while True:
        try:
            msg = sock.recv(65536)
        except (BlockingIOError, InterruptedError):
            return changed
        except OSError:
            return True
        if not msg:
            return changed
        if len(msg) >= 4 and msg[3] in _RTM_ADDRESS_TYPES:
            changed = True


class NetworkWatcher:
    """Keep the Core's tailnet-facing state consistent with the current address."""

    def __init__(
        self,
        *,
        lookup: Callable[[], Lookup],
        emit: Callable[[dict], None],
        bind_guard: Callable[[str, int], socket.socket | None],
        is_self: Callable[[object, str, int, str], bool],
        api_bind_host: str,
        api_port: int,
        api_endpoint_host: str,
        api: Listener | None = None,
        mcp: Listener | None = None,
        mcp_bind_host: str | None = None,
        mcp_port: int | None = None,
        mcp_advertised: str | None = None,
        tailscale_requested: bool = False,
        tailscale_bound: str | None = None,
        interval: float = POLL_INTERVAL,
        advertise_after: int = 2,
        rebind_after: float = 5.0,
        rebind_retry: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
        log: Callable[[str], None] | None = None,
    ) -> None:
        self._lookup = lookup
        self._emit = emit
        self._bind_guard = bind_guard
        self._is_self = is_self
        self.api_bind_host = api_bind_host
        self.api_port = api_port
        self.api_endpoint_host = api_endpoint_host
        self.api = api
        self.mcp = mcp
        self.mcp_bind_host = mcp_bind_host
        self.mcp_port = mcp_port
        self.mcp_advertised = mcp_advertised
        self.tailscale_requested = tailscale_requested
        self.tailscale_bound = tailscale_bound
        self._interval = interval
        self._advertise_after = advertise_after
        self._rebind_after = rebind_after
        self._rebind_retry = rebind_retry
        self._clock = clock
        self._log = log or (lambda msg: print(msg, file=sys.stderr, flush=True))

        self._lock = threading.Lock()
        self._last: Lookup | None = None
        self._checked_at: float | None = None
        self._last_ip: str | None = None
        self._candidate: str | None = None
        self._candidate_ticks = 0
        self._mismatch_since: float | None = None
        self._rebind_requested_at: float | None = None
        self._alerted: set[tuple[str, str]] = set()
        self._errors: list[str] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._route: socket.socket | None = None

    # ── one check ──────────────────────────────────────────────────────────

    def tick(self) -> None:
        result = _checked(self._lookup())
        with self._lock:
            self._last = result
            self._checked_at = time.time()
        if result.state == "error":
            self._note(f"Tailscale lookup failed ({result.detail}) — keeping the current network state")
            return
        ip = result.ip if result.state == "ip" else None
        returned = ip is not None and ip != self._last_ip
        for listener in (self.api, self.mcp):
            if listener is not None and ip is not None:
                self._guard(listener, ip, recheck=returned)
        self._last_ip = ip
        if self.mcp is not None:
            self._advertise(ip)
        if self.tailscale_requested:
            self._check_bind(ip)

    def _note(self, message: str) -> None:
        with self._lock:
            if self._errors and self._errors[-1] == message:
                return
            self._errors = (self._errors + [message])[-5:]
        self._log(f"⚠️  [Desktop Core] {message}")

    def _set(self, listener: Listener, ip: str, state: str, detail: str = "") -> None:
        with self._lock:
            before = listener.state.get(ip)
            listener.state[ip] = state
            listener.detail[ip] = detail
        if state == before:
            return
        where = f"{ip}:{listener.port}"
        if state == "protected":
            self._log(f"🔒 [Desktop Core] {listener.name} {where} is held by this Core (tailnet address)")
        elif state == "blocked":
            self._note(f"{listener.name} {where} is held by another process ({detail}) — not advertised")
            if (listener.name, ip) not in self._alerted:
                self._alerted.add((listener.name, ip))
                self._emit({"event": "alert", "kind": "guard_blocked", "listener": listener.name, "address": where})
        elif state in ("error", "pending"):
            self._note(f"{listener.name} {where} is not protected yet ({detail}) — retrying")

    def _guard(self, listener: Listener, ip: str, *, recheck: bool) -> None:
        """Hold, serve and verify ``ip:port`` for ``listener``.

        ``recheck`` (the address just appeared or came back) probes a guard we
        already hold again. Nothing here closes a guard: one that stops answering
        is reported and probed again on the next tick, still holding the address.
        """
        if listener.state.get(ip) == "protected" and not recheck:
            return
        if ip not in listener.held and ip not in listener.unserved:
            try:
                sock = self._bind_guard(ip, listener.port)
            except OSError as exc:
                if exc.errno == errno.EADDRINUSE:
                    self._set(listener, ip, "blocked", f"bind: {exc.strerror or exc}")
                elif exc.errno == errno.EADDRNOTAVAIL:
                    self._set(listener, ip, "pending", "address not assigned yet")
                else:
                    self._set(listener, ip, "error", f"bind: {exc}")
                return
            if sock is None:
                listener.held[ip] = None
            else:
                listener.unserved[ip] = sock
        sock = listener.unserved.get(ip)
        if sock is not None:
            try:
                pending = listener.attaching.get(ip) or attach_socket(listener.server, sock)
                listener.attaching[ip] = pending
                pending.result(ATTACH_TIMEOUT)
            except concurrent.futures.TimeoutError:
                # Still in flight: keep it and look at its outcome next time, so the
                # same socket is never handed to the server twice.
                self._set(listener, ip, "error", "the server has not taken the guard yet")
                return
            except Exception as exc:  # noqa: BLE001 — keep the guard (fail closed), retry
                listener.attaching.pop(ip, None)
                self._set(listener, ip, "error", f"could not serve the guard: {type(exc).__name__}: {exc}")
                return
            listener.attaching.pop(ip, None)
            listener.held[ip] = listener.unserved.pop(ip)
        if self._is_self(listener.responder, listener.nonce, listener.port, ip):
            self._set(listener, ip, "protected")
        else:
            self._set(listener, ip, "error", "this Core does not answer on it")

    def _advertise(self, ip: str | None) -> None:
        """Advertise the tailnet address only once it is ours; loopback otherwise."""
        assert self.mcp is not None
        desired = ip if ip is not None and self.mcp.state.get(ip) == "protected" else LOOPBACK_HOST
        if desired == self._candidate:
            self._candidate_ticks += 1
        else:
            self._candidate, self._candidate_ticks = desired, 1
        # A short flap does not move the endpoint, unless what is advertised now is
        # no longer ours — then the change is made at once.
        current = self.mcp_advertised
        unsafe = current not in (None, LOOPBACK_HOST) and self.mcp.state.get(current) != "protected"
        settled = unsafe or self._candidate_ticks >= self._advertise_after
        if settled and desired != self.mcp_advertised:
            with self._lock:
                self.mcp_advertised = desired
            self._log(f"[Desktop Core] MCP endpoint now advertised at {desired}:{self.mcp_port}")
            self._emit({"event": "mcp_endpoint", "mcp_host": desired, "mcp_port": self.mcp_port})

    def _check_bind(self, ip: str | None) -> None:
        """``--host tailscale``: ask for a restart once the bound address is stale."""
        if ip == self.tailscale_bound:
            self._mismatch_since = None
            return
        now = self._clock()
        if self._mismatch_since is None:
            self._mismatch_since = now
        if now - self._mismatch_since < self._rebind_after:
            return
        if self._rebind_requested_at is not None and now - self._rebind_requested_at < self._rebind_retry:
            return
        self._rebind_requested_at = now
        target = ip or LOOPBACK_HOST
        self._log(
            f"[Desktop Core] bound to {self.tailscale_bound or LOOPBACK_HOST} but the tailnet address is "
            f"{ip or 'gone'} — asking the shell to restart the Core"
        )
        self._emit({"event": "rebind", "bound": self.tailscale_bound or LOOPBACK_HOST, "tailscale_ip": ip, "target": target})

    # ── status ─────────────────────────────────────────────────────────────

    def _listener_status(self, listener: Listener | None, ip: str | None) -> dict | None:
        if listener is None or ip is None:
            return None
        return {
            "address": f"{ip}:{listener.port}",
            "state": listener.state.get(ip, "pending"),
            "detail": listener.detail.get(ip, ""),
        }

    def snapshot(self) -> dict:
        """What ``/api/system/info`` reports as ``network`` (actual sockets, not settings)."""
        with self._lock:
            last = self._last
            ip = last.ip if last is not None and last.state == "ip" else None
            stale_bind = self.tailscale_requested and last is not None and last.state != "error" and ip != self.tailscale_bound
            return {
                "tailscale": None
                if last is None
                else {"state": last.state, "ip": last.ip, "detail": last.detail, "checked_at": self._checked_at},
                "api": {
                    "bind_host": self.api_bind_host,
                    "port": self.api_port,
                    "endpoint_host": self.api_endpoint_host,
                    "tailnet": self._listener_status(self.api, ip)
                    if self.api is not None
                    else self._specific_tailnet(self.api_bind_host, self.api_port, ip),
                    "restart_requested": bool(stale_bind and self._rebind_requested_at is not None),
                },
                "mcp": None
                if self.mcp_port is None
                else {
                    "bind_host": self.mcp_bind_host,
                    "port": self.mcp_port,
                    "advertised": self.mcp_advertised,
                    "tailnet": self._listener_status(self.mcp, ip)
                    if self.mcp is not None
                    else self._specific_tailnet(self.mcp_bind_host, self.mcp_port, ip),
                },
                "problems": self._problems(last, ip, stale_bind),
            }

    def _problems(self, last: Lookup | None, ip: str | None, stale_bind: bool) -> list[str]:
        """What is wrong right now — empty when the network state is consistent."""
        problems: list[str] = []
        if last is not None and last.state == "error":
            problems.append(f"Tailscale lookup failed: {last.detail}")
        for listener in (self.api, self.mcp):
            if listener is None or ip is None:
                continue
            state = listener.state.get(ip, "pending")
            if state != "protected":
                problems.append(f"{listener.name} {ip}:{listener.port} {state}: {listener.detail.get(ip, '')}".rstrip(": "))
        if stale_bind:
            problems.append(
                f"API bound to {self.tailscale_bound or LOOPBACK_HOST}, tailnet address is {ip or 'gone'} — restart needed"
            )
        return problems

    @staticmethod
    def _specific_tailnet(bind_host: str | None, port: int | None, ip: str | None) -> dict | None:
        """A specific-address listener reaches the tailnet only on the address it bound."""
        if ip is None or bind_host is None or port is None:
            return None
        if bind_host == ip:
            return {"address": f"{ip}:{port}", "state": "protected", "detail": "bound to this address"}
        return {"address": f"{ip}:{port}", "state": "not_listening", "detail": f"bound to {bind_host}"}

    # ── thread ─────────────────────────────────────────────────────────────

    def safe_tick(self) -> None:
        try:
            self.tick()
        except Exception as exc:  # noqa: BLE001 — the watcher must outlive one bad check
            self._note(f"network check failed: {type(exc).__name__}: {exc}")

    def _wait(self) -> None:
        if self._route is None:
            self._stop.wait(self._interval)
            return
        try:
            readable, _, _ = select.select([self._route], [], [], self._interval)
        except (OSError, ValueError):
            self._route = None
            self._stop.wait(self._interval)
            return
        if readable and _drain_address_changes(self._route):
            self._stop.wait(WAKE_SETTLE)

    def _run(self) -> None:
        while not self._stop.is_set():
            self._wait()
            if self._stop.is_set():
                break
            self.safe_tick()

    def start(self) -> None:
        self._route = _route_socket()
        self._thread = threading.Thread(target=self._run, name="raven-netwatch", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 3.0) -> bool:
        """Stop the thread (no guard is added after this returns True)."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
            alive = self._thread.is_alive()
        else:
            alive = False
        if self._route is not None:
            self._route.close()
            self._route = None
        if not alive:
            # Served guards close with their uvicorn server; these never were.
            for listener in (self.api, self.mcp):
                if listener is not None:
                    for sock in listener.unserved.values():
                        sock.close()
                    listener.unserved.clear()
        return not alive

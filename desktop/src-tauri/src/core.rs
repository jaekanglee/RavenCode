use serde::Deserialize;
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// Default Core API bind host.
///
/// Issue #14: this used to be `0.0.0.0`, handing vault reads and
/// `DELETE /api/vaults/{name}?force=true` to every host on the network.
/// Loopback is the default; remote access is an explicit opt-in
/// (`RAVEN_ALLOW_REMOTE=1`) that the Python runtime enforces, so the shell
/// cannot widen the bind on its own. Even when opted in, the API app carries its
/// own access gate (`raven/core/access.py`): loopback passes, every other
/// source (tailnet included, #24) needs a `raven mcp token add` Bearer token. The value passed here is
/// sent as `--host`, which beats an inherited `RAVEN_HOST` in the runtime.
pub(crate) const DEFAULT_API_HOST: &str = "127.0.0.1";

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RuntimeLaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Whether the Python Core should serve MCP.
///
/// v0.7.184+: defaults to ON. External agents reach Raven over MCP, and the
/// desktop app is the process that is actually running on the operator's
/// machine — leaving MCP opt-in meant the endpoint was silently absent (the
/// GUI is launched from Finder/Dock, so it never sees a shell-exported
/// `RAVEN_DESKTOP_MCP=1` either). Opt out with `RAVEN_DESKTOP_MCP=0`.
pub(crate) fn mcp_enabled_from_env(raw: Option<String>) -> bool {
    match raw {
        None => true,
        Some(v) => {
            let v = v.trim();
            !(v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off"))
        }
    }
}

/// Permission mode for the desktop MCP listener.
///
/// Defaults to `admin` (operator's own machine), matching `.env`'s
/// `RAVEN_MCP_MODE=admin` for the standalone operator instance. A wide MCP bind
/// is sound because the listener is wrapped in `raven.mcp.auth.LanTokenAuth`
/// (every non-loopback client, tailnet included since #26, needs a Bearer token) — see
/// `raven/desktop/runtime.py::_resolve_mcp_host`, which follows the API host.
/// Narrow it with `RAVEN_DESKTOP_MCP_MODE=read|write`. An unrecognized value
/// falls back to `read` — the safe direction — rather than failing the launch.
pub(crate) fn mcp_mode_from_env(raw: Option<String>) -> String {
    match raw.as_deref().map(str::trim) {
        None | Some("") => "admin".to_string(),
        Some("admin") => "admin".to_string(),
        Some("write") => "write".to_string(),
        _ => "read".to_string(),
    }
}

pub(crate) fn runtime_launch_spec(
    program: PathBuf,
    mcp: bool,
    python_path: Option<PathBuf>,
    host: Option<String>,
    mcp_mode: Option<String>,
) -> RuntimeLaunchSpec {
    let mut args = Vec::new();
    // Keep the bundled PYTHONPATH, but block CWD and user site-packages.
    // -I would also ignore PYTHONPATH, so bundled mode uses -P -s instead.
    if python_path.is_some() {
        args.push("-P".into());
        args.push("-s".into());
    }
    args.push("-m".into());
    args.push("raven.desktop.runtime".into());
    if let Some(h) = &host {
        args.push("--host".into());
        args.push(h.clone());
    }
    if mcp {
        args.push("--mcp".into());
        if let Some(m) = &mcp_mode {
            args.push("--mcp-mode".into());
            args.push(m.clone());
        }
    }
    let mut env = Vec::new();
    if let Some(pp) = python_path {
        env.push(("PYTHONPATH".into(), pp.to_string_lossy().into_owned()));
    }
    RuntimeLaunchSpec { program, args, env }
}

/// Readiness line from `raven/desktop/runtime.py`.
///
/// Issue #16: `bind_host` is the address the API really listens on; `host` is
/// where this shell's webview connects (loopback for a loopback/wildcard bind,
/// the address itself for a specific bind). They used to be one constant.
#[derive(Deserialize)]
pub(crate) struct ReadyMessage {
    host: String,
    port: u16,
    bind_host: String,
    #[serde(default)]
    mcp_port: Option<u16>,
    /// MCP는 API와 다른 주소에 바인딩된다 (API는 LAN 전체, MCP는 tailnet/loopback).
    /// 따라서 `host`처럼 loopback으로 정규화하지 않고 실제 바인딩을 그대로 받는다.
    #[serde(default)]
    mcp_host: Option<String>,
}

/// Turn a readiness message into the API and MCP endpoints, or refuse it.
///
/// The API endpoint must be one the reported bind actually serves: loopback for
/// a loopback or wildcard (`0.0.0.0`) bind, the bound address itself otherwise.
/// A wildcard is never used as a URL. An unusable MCP address only drops MCP —
/// MCP is best-effort, the API is not.
pub(crate) fn ready_endpoints(ready: &ReadyMessage) -> Result<(String, Option<String>), String> {
    let bind: IpAddr = ready.bind_host.parse().map_err(|_| {
        format!("Python Core가 해석할 수 없는 bind 주소를 보고했습니다: {:?}", ready.bind_host)
    })?;
    let host: IpAddr = ready.host.parse().map_err(|_| {
        format!("Python Core가 해석할 수 없는 접속 주소를 보고했습니다: {:?}", ready.host)
    })?;
    if ready.port == 0 || host.is_unspecified() {
        return Err(format!(
            "Python Core가 접속할 수 없는 endpoint를 보고했습니다 ({}:{})",
            ready.host, ready.port
        ));
    }
    let served = if bind.is_loopback() || bind.is_unspecified() {
        host.is_loopback()
    } else {
        host == bind
    };
    if !served {
        return Err(format!(
            "Python Core readiness가 일관되지 않습니다: {bind}에 bind했는데 {host}로 접속하라고 보고했습니다"
        ));
    }
    let mcp_endpoint = ready
        .mcp_port
        .and_then(|p| mcp_endpoint_url(ready.mcp_host.as_deref().unwrap_or(&ready.host), p));
    Ok((format!("http://{}", SocketAddr::new(host, ready.port)), mcp_endpoint))
}

/// The MCP URL for an advertised address, or None (logged) when it is not dialable.
fn mcp_endpoint_url(raw: &str, port: u16) -> Option<String> {
    match raw.parse::<IpAddr>() {
        Ok(ip) if port != 0 && !ip.is_unspecified() => Some(format!("http://{}/mcp", SocketAddr::new(ip, port))),
        _ => {
            eprintln!("[core] ignoring unusable MCP endpoint {raw:?}:{port}");
            None
        }
    }
}

/// What a running Core tells the shell after readiness (Issue #58), one JSON
/// object per stdout line — see `raven/desktop/netwatch.py`. The Core keeps
/// stdout for these alone once it is ready.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CoreEvent {
    /// The advertised MCP endpoint moved (a new tailnet address is held and
    /// answered by this Core, or the endpoint fell back to loopback).
    McpEndpoint(String),
    /// A tailnet address could not be protected: another process holds it.
    GuardBlocked { listener: String, address: String },
    /// The Core is bound to a tailnet address that is gone or has changed
    /// (`--host tailscale`); only a restart can move its sockets.
    Rebind { bound: String, target: String },
}

/// Events from the Core with this id; ids are never reused within the shell.
pub(crate) type EventSink = mpsc::Sender<(u64, CoreEvent)>;

static NEXT_CORE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
struct EventLine {
    event: String,
    mcp_host: Option<String>,
    mcp_port: Option<u16>,
    kind: Option<String>,
    listener: Option<String>,
    address: Option<String>,
    bound: Option<String>,
    target: Option<String>,
}

/// Parse one post-readiness stdout line. Anything that is not a known, complete
/// event is None (and is only relayed to stderr).
pub(crate) fn parse_event(line: &str) -> Option<CoreEvent> {
    let line: EventLine = serde_json::from_str(line.trim()).ok()?;
    match line.event.as_str() {
        "mcp_endpoint" => mcp_endpoint_url(line.mcp_host.as_deref()?, line.mcp_port?).map(CoreEvent::McpEndpoint),
        "alert" if line.kind.as_deref() == Some("guard_blocked") => Some(CoreEvent::GuardBlocked {
            listener: line.listener?,
            address: line.address?,
        }),
        "rebind" => Some(CoreEvent::Rebind { bound: line.bound?, target: line.target? }),
        _ => None,
    }
}

/// Relay the Core's stdout after readiness: events to `events`, every line to stderr.
fn relay_events<R: BufRead>(id: u64, reader: &mut R, events: Option<EventSink>) {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let text = String::from_utf8_lossy(&buf);
                let text = text.trim_end_matches(['\r', '\n']);
                eprintln!("[raven-core] {text}");
                if let (Some(sink), Some(event)) = (events.as_ref(), parse_event(text)) {
                    let _ = sink.send((id, event));
                }
            }
        }
    }
}

/// How long the shell waits for the Core's readiness line (Issue #43).
///
/// A normal start takes well under 2 s (macOS: ~0.4–0.7 s, ~2 s with a cold
/// bytecode cache). The Core's own deadlines can legitimately take longer and
/// still end in a readiness line: uvicorn start (10 s), MCP start (10 s, then
/// API-only), the #22 identity probes (a few seconds each) and the #50 MCP stop
/// join (2 s) — about 30 s after imports, which have no deadline of their own.
/// 60 s stays above that path, so a slow but healthy Core is not killed, while
/// a Core that hangs silently no longer holds the shell forever. The webview
/// does not wait on this directly: `core_endpoint` answers `Err` after 15 s and
/// the dashboard keeps asking again (30 attempts).
pub(crate) const CORE_READINESS_TIMEOUT: Duration = Duration::from_secs(60);

/// How often the readiness wait checks for exit, cancellation and the deadline.
const READINESS_POLL: Duration = Duration::from_millis(50);

/// After stdout closes, how long to wait for the Core to exit before calling it hung.
const EOF_EXIT_GRACE: Duration = Duration::from_secs(1);

/// How long a failure waits for the stderr relay to drain after the kill. A
/// grandchild holding the pipe open must not turn the error path into a hang.
const STDERR_DRAIN: Duration = Duration::from_secs(1);

/// Bytes of the Core's stderr kept for the failure message.
const STDERR_TAIL_BYTES: usize = 8 * 1024;

/// Why `ManagedCore::start` returned without a running Core.
#[derive(Debug)]
pub(crate) enum StartError {
    /// The shell aborted the start (app exit). Nothing failed, so there is
    /// nothing to report to the user.
    Cancelled,
    /// Another start or restart is still in progress, so this one was not run
    /// (Issue #44) — running both would put two Cores side by side.
    Busy,
    Failed(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => f.write_str("앱 종료로 Python Core 기동이 취소되었습니다"),
            Self::Busy => f.write_str("Python Core 기동 또는 재시작이 이미 진행 중입니다. 끝난 뒤 다시 시도하세요"),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

/// A Core that has been spawned but has not reported ready yet (Issue #43).
///
/// The child sits here during the readiness wait so another thread — app exit,
/// a newer restart — can kill it with `cancel`; the waiting thread notices
/// within one poll and returns `StartError::Cancelled`.
#[derive(Default)]
pub(crate) struct PendingStart {
    child: Mutex<Option<Child>>,
    cancelled: AtomicBool,
}

impl PendingStart {
    pub(crate) fn cancel(&self) {
        // Flag first: a start that has not parked its child yet sees it and kills
        // the child itself; one that has, loses it here.
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().unwrap_or_else(PoisonError::into_inner).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// The Core's stderr, relayed to the shell's stderr from spawn on, with the
/// tail kept for failure messages. Reading it from the start also means a Core
/// that writes more than a pipe buffer before readiness can no longer block.
struct StderrTail {
    /// `None` once the Core is ready: from then on stderr is only relayed.
    text: Arc<Mutex<Option<String>>>,
    /// Disconnects when the relay thread hits EOF.
    done: mpsc::Receiver<()>,
}

impl StderrTail {
    fn spawn(stderr: Option<ChildStderr>) -> Self {
        let text = Arc::new(Mutex::new(Some(String::new())));
        let (done_tx, done) = mpsc::channel::<()>();
        if let Some(stream) = stderr {
            let sink = Arc::clone(&text);
            let spawned = std::thread::Builder::new()
                .name("raven-core:stderr".into())
                .spawn(move || {
                    let _done = done_tx;
                    relay_lines("core:stderr", &mut BufReader::new(stream), Some(&sink));
                });
            if spawned.is_err() {
                eprintln!("[core] could not start the stderr relay");
            }
        }
        Self { text, done }
    }

    fn stop_keeping(&self) {
        *self.text.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// The stderr tail once the relay has drained (bounded by `STDERR_DRAIN`).
    fn detail(&self) -> String {
        let _ = self.done.recv_timeout(STDERR_DRAIN);
        let text = self.text.lock().unwrap_or_else(PoisonError::into_inner);
        match text.as_deref().unwrap_or("").trim() {
            "" => "stderr 출력 없음".to_string(),
            tail => format!("stderr: {tail}"),
        }
    }
}

/// Relay a child pipe line-by-line to the shell's stderr until EOF.
///
/// The reader thread must outlive `start()`; otherwise the pipe's read end is
/// closed and the child's next write fails with EPIPE. Invalid UTF-8 is relayed
/// lossily instead of ending the relay (which would close the pipe).
fn relay_lines<R: BufRead>(tag: &str, reader: &mut R, tail: Option<&Mutex<Option<String>>>) {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let text = String::from_utf8_lossy(&buf);
                let text = text.trim_end_matches(['\r', '\n']);
                eprintln!("[raven-{tag}] {text}");
                if let Some(tail) = tail {
                    let mut guard = tail.lock().unwrap_or_else(PoisonError::into_inner);
                    let Some(kept) = guard.as_mut() else { continue };
                    kept.push_str(text);
                    kept.push('\n');
                    if kept.len() > STDERR_TAIL_BYTES {
                        let mut cut = kept.len() - STDERR_TAIL_BYTES;
                        while !kept.is_char_boundary(cut) {
                            cut += 1;
                        }
                        kept.drain(..cut);
                    }
                }
            }
        }
    }
}

const DEV_ENV_HINT: &str = "('make install'로 파이썬 개발 환경을 재구축해 보세요)";

/// Kill `child` (if still running) and describe the failure with its stderr.
fn abort(mut child: Child, stderr: &StderrTail, what: String) -> StartError {
    let _ = child.kill();
    let _ = child.wait();
    StartError::Failed(format!("{what}. {}", stderr.detail()))
}

fn exited_before_ready(status: ExitStatus) -> String {
    format!("Python Core가 readiness를 보고하기 전에 종료되었습니다 ({status}) {DEV_ENV_HINT}")
}

pub(crate) struct ManagedCore {
    child: Child,
    /// Tags this Core's events, so one from a Core already replaced is ignored.
    pub id: u64,
    pub endpoint: String,
    pub mcp_endpoint: Option<String>,
    /// The credential this Core got on stdin (Issue #67) — private, never logged or printed.
    session: Option<String>,
}

impl ManagedCore {
    /// This Core's webview credential, or `None` if it was started without one.
    pub(crate) fn session_token(&self) -> Option<String> {
        self.session.clone()
    }
}

/// Env var telling `raven.desktop.runtime` to read the session credential from stdin.
pub(crate) const SESSION_STDIN_ENV: &str = "RAVEN_DESKTOP_SESSION_STDIN";

/// A fresh credential for one Core's webview (Issue #67), or `None` if the OS CSPRNG fails.
///
/// The Core API needs a Bearer token from every source — loopback too, because macOS
/// Docker Desktop forwards a container's `host.docker.internal` connection to the host's
/// loopback. Every Core start (restarts included) gets its own credential, so a restarted
/// Core never accepts the previous one. It reaches the Core on stdin and the webview over
/// the `core_session_token` IPC command, lives only in memory, and is never put in argv,
/// the environment, a file, a log line, the readiness line or a URL.
///
/// 32 bytes from the OS CSPRNG via `getrandom` (macOS `getentropy`, Linux `getrandom(2)`(없으면 `/dev/urandom`),
/// Windows `ProcessPrng`), hex-encoded: `rvs_` + 64 hex = 256 bits. If the OS generator
/// fails there is no weaker fallback: the Core starts without a session credential and
/// the webview asks for an issued token instead (fail closed).
pub(crate) fn new_session_token() -> Option<String> {
    session_token_from(getrandom::fill)
}

fn session_token_from<E>(fill: impl FnOnce(&mut [u8]) -> Result<(), E>) -> Option<String> {
    let mut bytes = [0u8; 32];
    fill(&mut bytes).ok()?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Some(format!("rvs_{hex}"))
}

impl ManagedCore {
    pub(crate) fn start(
        mcp: bool,
        resource_dir: Option<PathBuf>,
        pending: &PendingStart,
        events: Option<EventSink>,
    ) -> Result<Self, StartError> {
        let (python, python_path) = resolve_python(resource_dir.as_deref());
        let host = env::var("RAVEN_DESKTOP_HOST")
            .ok()
            .or_else(|| env::var("RAVEN_HOST").ok())
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| DEFAULT_API_HOST.to_string());
        let mcp_mode = mcp_mode_from_env(env::var("RAVEN_DESKTOP_MCP_MODE").ok());
        let spec = runtime_launch_spec(python, mcp, python_path, Some(host), Some(mcp_mode));
        let mut cmd = Command::new(&spec.program);
        // Issue #23: lets the Core shut itself down if this shell dies without
        // reaching RunEvent::Exit (SIGTERM/SIGHUP, crash) — see runtime.py PARENT_PID_ENV.
        cmd.env("RAVEN_DESKTOP_PARENT_PID", std::process::id().to_string());
        cmd.args(&spec.args)
            .current_dir(safe_workspace(spec.env.iter().any(|(k, _)| k == "PYTHONPATH")));
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }
        // Issue #67: a new credential for every Core, handed over on stdin (see new_session_token).
        let session = new_session_token();
        if session.is_some() {
            cmd.env(SESSION_STDIN_ENV, "1");
        } else {
            // never inherit the flag from the launching environment: the Core would read
            // whatever stdin it inherited (e.g. a terminal) as the credential
            cmd.env_remove(SESSION_STDIN_ENV);
            eprintln!("Raven: OS 난수 생성 실패 — 세션 자격 증명 없이 Core를 시작합니다 (대시보드가 토큰을 묻습니다)");
        }
        Self::launch_inner(cmd, CORE_READINESS_TIMEOUT, pending, events, session)
    }

    /// Spawn `cmd` and wait — at most `timeout` — for its readiness line.
    ///
    /// Issue #43: this used to be a bare blocking `read_line`, so a Core that
    /// neither printed, exited nor closed stdout held the shell forever. Every
    /// way out of the wait now ends with the child killed and reaped, except a
    /// valid, consistent readiness line.
    #[cfg(test)]
    pub(crate) fn launch(cmd: Command, timeout: Duration, pending: &PendingStart) -> Result<Self, StartError> {
        Self::launch_with_events(cmd, timeout, pending, None)
    }

    /// `launch`, with the Core's post-readiness events sent to `events` (Issue #58).
    pub(crate) fn launch_with_events(
        cmd: Command,
        timeout: Duration,
        pending: &PendingStart,
        events: Option<EventSink>,
    ) -> Result<Self, StartError> {
        Self::launch_inner(cmd, timeout, pending, events, None)
    }

    /// `launch_with_events`, writing `secret` and a newline to the child's stdin, then
    /// closing it (Issue #67). A child that already exited just loses the write.
    pub(crate) fn launch_inner(
        mut cmd: Command,
        timeout: Duration,
        pending: &PendingStart,
        events: Option<EventSink>,
        secret: Option<String>,
    ) -> Result<Self, StartError> {
        let id = NEXT_CORE_ID.fetch_add(1, Ordering::Relaxed);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        if secret.is_some() {
            cmd.stdin(Stdio::piped());
        }
        let mut child = cmd.spawn().map_err(|error| {
            StartError::Failed(format!(
                "Python Core 시작 실패 ({}): {error}",
                Path::new(cmd.get_program()).display()
            ))
        })?;
        if let (Some(secret), Some(mut stdin)) = (secret.as_deref(), child.stdin.take()) {
            let _ = writeln!(stdin, "{secret}");
            // dropping `stdin` closes the pipe: the Core reads one line, then EOF
        }
        let stdout = child.stdout.take();
        let stderr = StderrTail::spawn(child.stderr.take());
        let Some(stdout) = stdout else {
            return Err(abort(child, &stderr, "Python Core readiness stream을 열 수 없습니다".into()));
        };

        // First line → channel; the same thread then relays stdout: events (#58)
        // to `events`, every line to stderr.
        let (line_tx, line_rx) = mpsc::sync_channel::<std::io::Result<String>>(1);
        let spawned = std::thread::Builder::new()
            .name("raven-core".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut buf = Vec::new();
                let first = reader
                    .read_until(b'\n', &mut buf)
                    .map(|_| String::from_utf8_lossy(&buf).into_owned());
                let ok = first.is_ok();
                let _ = line_tx.send(first);
                if ok {
                    relay_events(id, &mut reader, events);
                }
            });
        if let Err(error) = spawned {
            return Err(abort(child, &stderr, format!("Python Core readiness reader 시작 실패: {error}")));
        }

        {
            let mut slot = pending.child.lock().unwrap_or_else(PoisonError::into_inner);
            if pending.is_cancelled() {
                drop(slot);
                let _ = child.kill();
                let _ = child.wait();
                return Err(StartError::Cancelled);
            }
            *slot = Some(child);
        }

        let deadline = Instant::now() + timeout;
        let read = loop {
            match line_rx.recv_timeout(deadline.saturating_duration_since(Instant::now()).min(READINESS_POLL)) {
                Ok(read) => break read,
                // The reader always sends before it ends; treat a lost sender as EOF.
                Err(mpsc::RecvTimeoutError::Disconnected) => break Ok(String::new()),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            let mut slot = pending.child.lock().unwrap_or_else(PoisonError::into_inner);
            let Some(running) = slot.as_mut() else {
                return Err(StartError::Cancelled);
            };
            // Exit is checked apart from EOF: a grandchild can hold stdout open
            // after the Core itself is gone.
            // `abort` waits (kill, reap, stderr drain ≤1 s): release the slot lock
            // first so an app-exit `cancel` never waits on it (Issue #44 review).
            if let Ok(Some(status)) = running.try_wait() {
                let child = slot.take().expect("checked above");
                drop(slot);
                return Err(abort(child, &stderr, exited_before_ready(status)));
            }
            if Instant::now() >= deadline {
                let child = slot.take().expect("checked above");
                drop(slot);
                return Err(abort(
                    child,
                    &stderr,
                    format!(
                        "Python Core가 {}초 안에 readiness를 보고하지 않아 종료했습니다",
                        timeout.as_secs_f32()
                    ),
                ));
            }
        };

        let Some(mut child) = pending.child.lock().unwrap_or_else(PoisonError::into_inner).take() else {
            return Err(StartError::Cancelled);
        };
        let line = match read {
            Ok(line) => line,
            Err(error) => {
                return Err(abort(child, &stderr, format!("Python Core readiness 읽기 실패: {error}")))
            }
        };
        if line.is_empty() {
            // stdout closed. Usually the Core is exiting — give it a moment so
            // the message can say how it ended.
            let grace = Instant::now() + EOF_EXIT_GRACE;
            loop {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(abort(child, &stderr, exited_before_ready(status)));
                }
                if Instant::now() >= grace {
                    return Err(abort(
                        child,
                        &stderr,
                        "Python Core가 readiness 없이 stdout을 닫았습니다 (프로세스는 살아 있었음)".into(),
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        let ready: ReadyMessage = match serde_json::from_str(&line) {
            Ok(msg) => msg,
            Err(error) => {
                return Err(abort(
                    child,
                    &stderr,
                    format!("Python Core readiness 형식 오류 ({error}) {DEV_ENV_HINT}"),
                ))
            }
        };
        if let Ok(Some(status)) = child.try_wait() {
            return Err(abort(
                child,
                &stderr,
                format!("Python Core가 readiness 직후 종료되었습니다 ({status})"),
            ));
        }
        let (endpoint, mcp_endpoint) = match ready_endpoints(&ready) {
            Ok(endpoints) => endpoints,
            // The Core already reported ready and is listening; refusing it
            // must not leave it running behind the error dialog.
            Err(error) => return Err(abort(child, &stderr, error)),
        };

        // Both pipes keep being drained for the life of the child (see
        // `relay_lines`): the stdout thread above continues after the first
        // line, and the stderr relay runs until EOF — without keeping a tail.
        stderr.stop_keeping();
        Ok(Self {
            child,
            id,
            endpoint,
            mcp_endpoint,
            session: secret,
        })
    }


    /// Test double: a "running" Core with the given endpoints (the child is a finished `true`).
    #[cfg(test)]
    pub(crate) fn for_test(endpoint: &str, mcp_endpoint: Option<&str>) -> Self {
        Self {
            child: Command::new("true").spawn().expect("spawn true"),
            id: NEXT_CORE_ID.fetch_add(1, Ordering::Relaxed),
            endpoint: endpoint.to_string(),
            mcp_endpoint: mcp_endpoint.map(str::to_string),
            session: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test_with_session(endpoint: &str, session: &str) -> Self {
        let mut core = Self::for_test(endpoint, None);
        core.session = Some(session.to_string());
        core
    }

    #[cfg(test)]
    pub(crate) fn pid(&self) -> u32 {
        self.child.id()
    }

    pub(crate) fn stop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// True if the child process is still running (non-blocking check).
    pub(crate) fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for ManagedCore {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Resolve the Python interpreter and optional PYTHONPATH.
///
/// Priority: RAVEN_PYTHON env → bundled resources → dev venv.
fn resolve_python(resource_dir: Option<&Path>) -> (PathBuf, Option<PathBuf>) {
    if let Some(p) = env::var_os("RAVEN_PYTHON") {
        return (PathBuf::from(p), None);
    }

    // Dev mode (cargo run / desktop-dev): prefer local scripts/.venv over stale bundled resources
    if cfg!(debug_assertions) {
        let dev_venv = dev_workspace_root().join("scripts/.venv/bin/python");
        if dev_venv.exists() {
            return (dev_venv, None);
        }
    }

    // Bundled mode: Resources/resources/python/bin/python3 + Resources/resources/raven/
    if let Some(res) = resource_dir {
        let bundled_python = res
            .join("resources")
            .join("python")
            .join("bin")
            .join("python3");
        let bundled_raven = res.join("resources").join("raven");
        if bundled_python.exists() && bundled_raven.exists() {
            return (bundled_python, Some(bundled_raven));
        }
    }

    // Dev mode fallback: scripts/.venv/bin/python, raven importable from CWD
    (dev_workspace_root().join("scripts/.venv/bin/python"), None)
}

/// Dev-mode workspace root (compile-time path — only valid on the build machine).
fn dev_workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("desktop/src-tauri must be nested under the Raven workspace")
        .to_path_buf()
}

/// Safe working directory for the Python child process.
/// Bundled mode: home dir (CWD irrelevant — PYTHONPATH points at bundled raven).
/// Dev mode: compile-time workspace root (only on the build machine).
fn safe_workspace(bundled: bool) -> PathBuf {
    if bundled {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
    } else {
        let dev = dev_workspace_root();
        if dev.exists() {
            dev
        } else {
            dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ready_endpoints, ReadyMessage};

    fn endpoints(line: &str) -> Result<(String, Option<String>), String> {
        let ready: ReadyMessage = serde_json::from_str(line).expect("valid readiness JSON");
        ready_endpoints(&ready)
    }

    #[test]
    fn loopback_bind_uses_the_loopback_endpoint() {
        let (api, mcp) = endpoints(r#"{"host":"127.0.0.1","port":41000,"bind_host":"127.0.0.1"}"#).unwrap();
        assert_eq!(api, "http://127.0.0.1:41000");
        assert_eq!(mcp, None);
    }

    #[test]
    fn wildcard_bind_is_served_on_loopback_and_never_used_as_a_url() {
        let (api, mcp) = endpoints(
            r#"{"host":"127.0.0.1","port":41000,"bind_host":"0.0.0.0","mcp_port":8766,"mcp_host":"100.64.1.2"}"#,
        )
        .unwrap();
        assert_eq!(api, "http://127.0.0.1:41000");
        assert_eq!(mcp.as_deref(), Some("http://100.64.1.2:8766/mcp"));
        assert!(endpoints(r#"{"host":"0.0.0.0","port":41000,"bind_host":"0.0.0.0"}"#).is_err());
    }

    #[test]
    fn specific_bind_uses_that_address() {
        let (api, _) = endpoints(r#"{"host":"192.168.0.52","port":41000,"bind_host":"192.168.0.52"}"#).unwrap();
        assert_eq!(api, "http://192.168.0.52:41000");
    }

    #[test]
    fn inconsistent_or_unusable_readiness_is_refused() {
        for line in [
            // Issue #16: the old constant — loopback reported while only 192.168.0.52 listens.
            r#"{"host":"127.0.0.1","port":41000,"bind_host":"192.168.0.52"}"#,
            r#"{"host":"192.168.0.9","port":41000,"bind_host":"192.168.0.52"}"#,
            r#"{"host":"192.168.0.52","port":41000,"bind_host":"127.0.0.1"}"#,
            r#"{"host":"192.168.0.52","port":41000,"bind_host":"0.0.0.0"}"#,
            r#"{"host":"127.0.0.1","port":0,"bind_host":"127.0.0.1"}"#,
            r#"{"host":"localhost","port":41000,"bind_host":"127.0.0.1"}"#,
            r#"{"host":"127.0.0.1","port":41000,"bind_host":"evil.example"}"#,
        ] {
            assert!(endpoints(line).is_err(), "{line}");
        }
    }

    #[test]
    fn readiness_without_bind_host_is_a_format_error() {
        assert!(serde_json::from_str::<ReadyMessage>(r#"{"host":"127.0.0.1","port":41000}"#).is_err());
    }

    #[test]
    fn unusable_mcp_address_drops_only_mcp() {
        for mcp_host in ["0.0.0.0", "not-an-ip"] {
            let line = format!(
                r#"{{"host":"127.0.0.1","port":41000,"bind_host":"0.0.0.0","mcp_port":8766,"mcp_host":"{mcp_host}"}}"#
            );
            let (api, mcp) = endpoints(&line).unwrap();
            assert_eq!(api, "http://127.0.0.1:41000");
            assert_eq!(mcp, None, "{mcp_host}");
        }
    }

    #[test]
    fn mcp_without_its_own_host_follows_the_api_host() {
        let (_, mcp) = endpoints(r#"{"host":"127.0.0.1","port":41000,"bind_host":"127.0.0.1","mcp_port":8766}"#).unwrap();
        assert_eq!(mcp.as_deref(), Some("http://127.0.0.1:8766/mcp"));
    }

    mod events {
        use super::super::{parse_event, CoreEvent};

        #[test]
        fn known_events_are_parsed() {
            assert_eq!(
                parse_event(r#"{"event": "mcp_endpoint", "mcp_host": "100.64.1.2", "mcp_port": 8766}"#),
                Some(CoreEvent::McpEndpoint("http://100.64.1.2:8766/mcp".into()))
            );
            assert_eq!(
                parse_event(r#"{"event": "alert", "kind": "guard_blocked", "listener": "MCP", "address": "100.64.1.2:8766"}"#),
                Some(CoreEvent::GuardBlocked { listener: "MCP".into(), address: "100.64.1.2:8766".into() })
            );
            assert_eq!(
                parse_event(r#"{"event": "rebind", "bound": "100.64.1.2", "tailscale_ip": null, "target": "127.0.0.1"}"#),
                Some(CoreEvent::Rebind { bound: "100.64.1.2".into(), target: "127.0.0.1".into() })
            );
        }

        #[test]
        fn anything_else_is_not_an_event() {
            for line in [
                "",
                "INFO: some log line",
                r#"{"host":"127.0.0.1","port":41000,"bind_host":"127.0.0.1"}"#,
                r#"{"event": "unknown"}"#,
                r#"{"event": "mcp_endpoint", "mcp_host": "0.0.0.0", "mcp_port": 8766}"#,
                r#"{"event": "mcp_endpoint", "mcp_host": "not-an-ip", "mcp_port": 8766}"#,
                r#"{"event": "mcp_endpoint", "mcp_host": "100.64.1.2", "mcp_port": 0}"#,
                r#"{"event": "mcp_endpoint", "mcp_host": "100.64.1.2"}"#,
                r#"{"event": "alert", "kind": "other", "listener": "MCP", "address": "x"}"#,
                r#"{"event": "rebind", "bound": "100.64.1.2"}"#,
                r#"{"event": "rebind""#,
            ] {
                assert_eq!(parse_event(line), None, "{line}");
            }
        }
    }

    /// Issue #58: events after readiness reach the sink, tagged with the Core's id.
    #[cfg(unix)]
    mod event_relay {
        use super::super::{CoreEvent, ManagedCore, PendingStart};
        use std::process::Command;
        use std::sync::mpsc;
        use std::time::Duration;

        fn core_printing(after_ready: &str) -> Command {
            let mut cmd = Command::new("sh");
            cmd.arg("-c").arg(format!(
                r#"echo '{{"host":"127.0.0.1","port":41000,"bind_host":"127.0.0.1"}}'; {after_ready}; sleep 30"#
            ));
            cmd
        }

        #[test]
        fn events_reach_the_sink_with_the_core_id_and_noise_does_not() {
            let (sink, events) = mpsc::channel();
            let script = r#"echo 'not json'; echo '{"event": "mcp_endpoint", "mcp_host": "100.64.1.2", "mcp_port": 8766}'; echo '{"event": "bogus"}'; echo '{"event": "rebind", "bound": "100.64.1.2", "target": "127.0.0.1"}'"#;
            let core = ManagedCore::launch_with_events(core_printing(script), Duration::from_secs(10), &PendingStart::default(), Some(sink))
                .unwrap();
            let first = events.recv_timeout(Duration::from_secs(5)).unwrap();
            let second = events.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(first, (core.id, CoreEvent::McpEndpoint("http://100.64.1.2:8766/mcp".into())));
            assert_eq!(second, (core.id, CoreEvent::Rebind { bound: "100.64.1.2".into(), target: "127.0.0.1".into() }));
            assert!(events.recv_timeout(Duration::from_millis(300)).is_err());
            // The readiness line itself is not an event, and the endpoint came from it.
            assert_eq!(core.mcp_endpoint, None);
        }

        #[test]
        fn every_core_has_its_own_id() {
            let a = ManagedCore::launch(core_printing("true"), Duration::from_secs(10), &PendingStart::default()).unwrap();
            let b = ManagedCore::launch(core_printing("true"), Duration::from_secs(10), &PendingStart::default()).unwrap();
            assert_ne!(a.id, b.id);
        }
    }

    /// Issue #43: `launch` against `sh` stand-ins for the Python Core.
    #[cfg(unix)]
    mod readiness_wait {
        use super::super::{ManagedCore, PendingStart, StartError};
        use std::path::PathBuf;
        use std::process::Command;
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        const READY: &str = r#"{"host":"127.0.0.1","port":41000,"bind_host":"127.0.0.1"}"#;

        /// `sh -c script`, with `$PIDFILE` pointing at a fresh per-test file.
        fn core(name: &str, script: &str) -> (Command, PathBuf) {
            let pidfile = std::env::temp_dir().join(format!("raven43-{}-{name}.pid", std::process::id()));
            let _ = std::fs::remove_file(&pidfile);
            let mut cmd = Command::new("sh");
            cmd.arg("-c").arg(script).env("PIDFILE", &pidfile);
            (cmd, pidfile)
        }

        fn pid(pidfile: &PathBuf) -> String {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(text) = std::fs::read_to_string(pidfile) {
                    if !text.trim().is_empty() {
                        return text.trim().to_string();
                    }
                }
                assert!(Instant::now() < deadline, "the stand-in never wrote {pidfile:?}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        /// Whether `pid` still exists a moment from now (killing races the check by microseconds).
        fn alive(pid: &str) -> bool {
            let deadline = Instant::now() + Duration::from_secs(2);
            while exists(pid) {
                if Instant::now() >= deadline {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            false
        }

        fn exists(pid: &str) -> bool {
            Command::new("kill")
                .args(["-0", pid])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success()
        }

        fn failed(result: Result<ManagedCore, StartError>) -> String {
            match result {
                Err(StartError::Failed(message)) => message,
                Err(StartError::Cancelled) => panic!("cancelled, expected a failure"),
                Err(StartError::Busy) => panic!("busy, expected a failure"),
                Ok(core) => panic!("started at {}, expected a failure", core.endpoint),
            }
        }

        // Issue #67: the session credential reaches the Core on stdin (one line, then EOF)
        // and nowhere else; a Core that never reads stdin still starts.
        #[test]
        fn session_secret_is_written_to_stdin_then_closed_and_kept_by_that_core() {
            let script = format!(
                r#"IFS= read -r line; if [ "$line" = "rvs_test_secret" ] && ! read -r more; then echo '{READY}'; else echo "got [$line]" >&2; fi; exec sleep 30"#
            );
            let mut cmd = Command::new("sh");
            cmd.arg("-c").arg(script);
            let core = ManagedCore::launch_inner(cmd, Duration::from_secs(10), &PendingStart::default(), None, Some("rvs_test_secret".into()))
                .expect("the Core sees exactly the secret line, then EOF");
            assert_eq!(core.endpoint, "http://127.0.0.1:41000");
            // what the webview is given (core_session_token) is exactly what this Core read
            assert_eq!(core.session_token().as_deref(), Some("rvs_test_secret"));
        }

        #[test]
        fn a_core_that_ignores_stdin_still_starts_with_a_secret() {
            let (cmd, _pidfile) = core("nostdin", &format!("echo '{READY}'; exec sleep 30"));
            let core = ManagedCore::launch_inner(cmd, Duration::from_secs(10), &PendingStart::default(), None, Some("rvs_x".into()));
            assert!(core.is_ok());
        }

        #[test]
        fn a_core_without_a_secret_has_no_session_token() {
            let (cmd, _pidfile) = core("nosecret", &format!("echo '{READY}'; exec sleep 30"));
            let core = ManagedCore::launch(cmd, Duration::from_secs(10), &PendingStart::default()).unwrap();
            assert_eq!(core.session_token(), None);
        }

        #[test]
        fn session_token_is_256_bits_of_hex_and_never_repeats() {
            use crate::core::new_session_token;
            let token = new_session_token().expect("the OS CSPRNG works here");
            assert!(token.starts_with("rvs_") && token.len() == 4 + 64, "{token}");
            assert!(token[4..].chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
            let many: std::collections::HashSet<String> = (0..2000).map(|_| new_session_token().unwrap()).collect();
            assert_eq!(many.len(), 2000, "every Core start gets a different credential");
            assert!(!many.contains(&token));
        }

        #[test]
        fn a_failing_os_generator_gives_no_credential_and_no_weak_fallback() {
            let token = crate::core::session_token_from(|_buf: &mut [u8]| Err::<(), ()>(()));
            assert_eq!(token, None);
            let src = include_str!("core.rs");
            let start = src.find(concat!("pub(crate) fn new_session", "_token")).expect("fn");
            let end = start + src[start..].find(concat!("impl Managed", "Core {")).expect("impl");
            let body = &src[start..end];
            for weak in [concat!("Random", "State"), concat!("/dev/", "urandom"), concat!("Sys", "Time"), concat!("process", "::id")] {
                assert!(!body.contains(weak), "no non-CSPRNG source in the generator: {weak}");
            }
            assert!(body.contains(concat!("getrandom::", "fill")));
        }

        #[test]
        fn start_makes_a_new_credential_per_core_and_passes_it_on_stdin_only() {
            let src = include_str!("core.rs");
            let start = src.find(concat!("pub(crate) fn ", "start(")).expect("start");
            let end = start + src[start..].find(concat!("pub(crate) fn ", "launch(")).expect("launch");
            let body = &src[start..end];
            assert!(body.contains(concat!("let session = new_session_", "token();")), "fresh per start");
            assert!(!src.contains(concat!("Once", "Lock<String>")), "no credential reused across Core starts");
            assert!(body.contains(concat!("cmd.env(SESSION_STDIN_ENV, ", "\"1\")")));
            assert!(!body.contains(concat!(".arg(session", "")), "never in argv");
            assert!(!body.contains(concat!("env(\"RAVEN_DESKTOP_SESSION", "_TOKEN")), "never in the environment");
        }

        #[test]
        fn readiness_line_starts_the_core_and_drop_stops_it() {
            let (cmd, pidfile) = core("ok", &format!("echo $$ > \"$PIDFILE\"; echo '{READY}'; exec sleep 30"));
            let mut core = ManagedCore::launch(cmd, Duration::from_secs(10), &PendingStart::default()).unwrap();
            assert_eq!(core.endpoint, "http://127.0.0.1:41000");
            assert!(core.is_alive());
            let pid = pid(&pidfile);
            assert!(exists(&pid));
            drop(core);
            assert!(!alive(&pid), "dropping the Core must stop it");
        }

        #[test]
        fn silent_live_core_times_out_and_is_killed() {
            let (cmd, pidfile) = core("silent", "echo $$ > \"$PIDFILE\"; echo still-importing >&2; exec sleep 30");
            let started = Instant::now();
            let message = failed(ManagedCore::launch(cmd, Duration::from_millis(400), &PendingStart::default()));
            let took = started.elapsed();
            assert!(took >= Duration::from_millis(400) && took < Duration::from_secs(3), "{took:?}");
            assert!(message.contains("readiness를 보고하지 않아 종료했습니다"), "{message}");
            assert!(message.contains("still-importing"), "stderr tail missing: {message}");
            assert!(!alive(&pid(&pidfile)), "the timed-out Core must be killed");
        }

        #[test]
        fn readiness_just_after_the_deadline_is_a_timeout() {
            let (cmd, pidfile) = core("late", &format!("echo $$ > \"$PIDFILE\"; sleep 1; echo '{READY}'; exec sleep 30"));
            let message = failed(ManagedCore::launch(cmd, Duration::from_millis(500), &PendingStart::default()));
            assert!(message.contains("readiness를 보고하지 않아"), "{message}");
            assert!(!alive(&pid(&pidfile)));
        }

        #[test]
        fn readiness_just_before_the_deadline_is_accepted() {
            let (cmd, _) = core("early", &format!("sleep 1; echo '{READY}'; exec sleep 30"));
            let core = ManagedCore::launch(cmd, Duration::from_secs(2), &PendingStart::default()).unwrap();
            assert_eq!(core.endpoint, "http://127.0.0.1:41000");
        }

        #[test]
        fn malformed_readiness_is_a_format_error_and_the_core_is_killed() {
            let (cmd, pidfile) = core("garbage", "echo $$ > \"$PIDFILE\"; echo boom-detail >&2; echo not-json; exec sleep 30");
            let message = failed(ManagedCore::launch(cmd, Duration::from_secs(10), &PendingStart::default()));
            assert!(message.contains("readiness 형식 오류"), "{message}");
            assert!(message.contains("boom-detail"), "{message}");
            assert!(!alive(&pid(&pidfile)));
        }

        #[test]
        fn readiness_from_before_issue_16_is_refused() {
            // Issue #16 contract: `bind_host` is required.
            let (cmd, pidfile) = core(
                "old16",
                r#"echo $$ > "$PIDFILE"; echo '{"host":"127.0.0.1","port":41000}'; exec sleep 30"#,
            );
            let message = failed(ManagedCore::launch(cmd, Duration::from_secs(10), &PendingStart::default()));
            assert!(message.contains("readiness 형식 오류") && message.contains("bind_host"), "{message}");
            assert!(!alive(&pid(&pidfile)));
        }

        #[test]
        fn inconsistent_readiness_kills_the_core() {
            let (cmd, pidfile) = core(
                "incons",
                r#"echo $$ > "$PIDFILE"; echo '{"host":"127.0.0.1","port":41000,"bind_host":"192.168.0.52"}'; exec sleep 30"#,
            );
            let message = failed(ManagedCore::launch(cmd, Duration::from_secs(10), &PendingStart::default()));
            assert!(message.contains("일관되지 않습니다"), "{message}");
            assert!(!alive(&pid(&pidfile)));
        }

        #[test]
        fn closed_stdout_on_a_live_core_is_reported_and_killed() {
            let (cmd, pidfile) = core("eof", "echo $$ > \"$PIDFILE\"; exec >&-; exec sleep 30");
            let started = Instant::now();
            let message = failed(ManagedCore::launch(cmd, Duration::from_secs(10), &PendingStart::default()));
            assert!(started.elapsed() < Duration::from_secs(4), "must not wait for the timeout");
            assert!(message.contains("stdout을 닫았습니다"), "{message}");
            assert!(!alive(&pid(&pidfile)));
        }

        #[test]
        fn early_exit_reports_the_status_and_stderr() {
            let (cmd, _) = core("exit", "echo 'Traceback: no module named x' >&2; exit 3");
            let started = Instant::now();
            let message = failed(ManagedCore::launch(cmd, Duration::from_secs(10), &PendingStart::default()));
            assert!(started.elapsed() < Duration::from_secs(4));
            assert!(message.contains("readiness를 보고하기 전에 종료되었습니다"), "{message}");
            assert!(message.contains('3'), "{message}");
            assert!(message.contains("no module named x"), "{message}");
        }

        #[test]
        fn early_exit_is_seen_even_when_a_grandchild_keeps_the_pipes_open() {
            // The Core is gone but a leftover child still holds stdout/stderr: no EOF
            // arrives, so exit must be noticed on its own and stderr draining bounded.
            let (cmd, pidfile) = core("orphanpipe", "sleep 30 & echo $! > \"$PIDFILE\"; exit 4");
            let started = Instant::now();
            let message = failed(ManagedCore::launch(cmd, Duration::from_secs(20), &PendingStart::default()));
            let took = started.elapsed();
            let grandchild = pid(&pidfile);
            let _ = Command::new("kill").arg(&grandchild).status();
            assert!(took < Duration::from_secs(4), "{took:?}");
            assert!(message.contains("종료되었습니다"), "{message}");
        }

        #[test]
        fn stderr_beyond_a_pipe_buffer_before_readiness_does_not_block() {
            // 256 KiB of warnings before the readiness line: with nobody reading
            // stderr until readiness, the Core blocked on write and never got there.
            let (cmd, _) = core(
                "flood",
                &format!("i=0; while [ $i -lt 4096 ]; do echo 'warning: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' >&2; i=$((i+1)); done; echo '{READY}'; exec sleep 30"),
            );
            let core = ManagedCore::launch(cmd, Duration::from_secs(20), &PendingStart::default()).unwrap();
            assert_eq!(core.endpoint, "http://127.0.0.1:41000");
        }

        #[test]
        fn cancel_during_the_wait_kills_the_core() {
            let (cmd, pidfile) = core("cancel", "echo $$ > \"$PIDFILE\"; exec sleep 30");
            let pending = Arc::new(PendingStart::default());
            let p2 = Arc::clone(&pending);
            let waiter = std::thread::spawn(move || ManagedCore::launch(cmd, Duration::from_secs(20), &p2));
            let pid = pid(&pidfile);
            pending.cancel();
            assert!(!alive(&pid), "cancel must kill the waiting Core itself");
            let started = Instant::now();
            assert!(matches!(waiter.join().unwrap(), Err(StartError::Cancelled)));
            assert!(started.elapsed() < Duration::from_secs(2));
        }

        #[test]
        fn cancel_before_spawn_never_leaves_a_core_running() {
            // The child may be killed before it can write a pidfile, so look for
            // its unique command line instead (read-only `pgrep`).
            let marker = format!("sleep 31.{}", std::process::id());
            let (cmd, _) = core("precancel", &format!("exec {marker}"));
            let pending = PendingStart::default();
            pending.cancel();
            assert!(matches!(ManagedCore::launch(cmd, Duration::from_secs(20), &pending), Err(StartError::Cancelled)));
            std::thread::sleep(Duration::from_millis(200));
            let found = Command::new("pgrep").args(["-f", &marker]).output().unwrap();
            assert!(found.stdout.is_empty(), "cancelled start left {marker} running");
        }

        #[test]
        fn a_start_after_repeated_failures_succeeds() {
            for (name, script) in [("r1", "exec sleep 30"), ("r2", "echo nope; exec sleep 30"), ("r3", "exit 1")] {
                let (cmd, _) = core(name, script);
                let _ = failed(ManagedCore::launch(cmd, Duration::from_millis(300), &PendingStart::default()));
            }
            let (cmd, _) = core("r4", &format!("echo '{READY}'; exec sleep 30"));
            assert!(ManagedCore::launch(cmd, Duration::from_secs(10), &PendingStart::default()).is_ok());
        }

        #[test]
        fn missing_program_is_a_start_failure_naming_it() {
            let message = failed(ManagedCore::launch(
                Command::new("/nonexistent/raven-python"),
                Duration::from_secs(1),
                &PendingStart::default(),
            ));
            assert!(message.contains("Python Core 시작 실패") && message.contains("/nonexistent/raven-python"), "{message}");
        }
    }
}

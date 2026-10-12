use serde::Deserialize;
use std::env;
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
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
    let mcp_endpoint = ready.mcp_port.and_then(|p| {
        let raw = ready.mcp_host.as_deref().unwrap_or(&ready.host);
        match raw.parse::<IpAddr>() {
            Ok(ip) if p != 0 && !ip.is_unspecified() => Some(format!("http://{}/mcp", SocketAddr::new(ip, p))),
            _ => {
                eprintln!("[core] ignoring unusable MCP endpoint {raw:?}:{p}");
                None
            }
        }
    });
    Ok((format!("http://{}", SocketAddr::new(host, ready.port)), mcp_endpoint))
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
    pub endpoint: String,
    pub mcp_endpoint: Option<String>,
}

impl ManagedCore {
    pub(crate) fn start(
        mcp: bool,
        resource_dir: Option<PathBuf>,
        pending: &PendingStart,
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
        Self::launch(cmd, CORE_READINESS_TIMEOUT, pending)
    }

    /// Spawn `cmd` and wait — at most `timeout` — for its readiness line.
    ///
    /// Issue #43: this used to be a bare blocking `read_line`, so a Core that
    /// neither printed, exited nor closed stdout held the shell forever. Every
    /// way out of the wait now ends with the child killed and reaped, except a
    /// valid, consistent readiness line.
    pub(crate) fn launch(
        mut cmd: Command,
        timeout: Duration,
        pending: &PendingStart,
    ) -> Result<Self, StartError> {
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|error| {
            StartError::Failed(format!(
                "Python Core 시작 실패 ({}): {error}",
                Path::new(cmd.get_program()).display()
            ))
        })?;
        let stdout = child.stdout.take();
        let stderr = StderrTail::spawn(child.stderr.take());
        let Some(stdout) = stdout else {
            return Err(abort(child, &stderr, "Python Core readiness stream을 열 수 없습니다".into()));
        };

        // First line → channel; the same thread then keeps relaying stdout.
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
                    relay_lines("core", &mut reader, None);
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
            endpoint,
            mcp_endpoint,
        })
    }


    /// Test double: a "running" Core with the given endpoints (the child is a finished `true`).
    #[cfg(test)]
    pub(crate) fn for_test(endpoint: &str, mcp_endpoint: Option<&str>) -> Self {
        Self {
            child: Command::new("true").spawn().expect("spawn true"),
            endpoint: endpoint.to_string(),
            mcp_endpoint: mcp_endpoint.map(str::to_string),
        }
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

use serde::Deserialize;
use std::env;
use std::io::{BufRead, BufReader, Read};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

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

pub(crate) struct ManagedCore {
    child: Child,
    pub endpoint: String,
    pub mcp_endpoint: Option<String>,
}

impl ManagedCore {
    pub(crate) fn start(mcp: bool, resource_dir: Option<PathBuf>) -> Result<Self, String> {
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
            .current_dir(safe_workspace(spec.env.iter().any(|(k, _)| k == "PYTHONPATH")))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }
        let mut child = cmd.spawn().map_err(|error| {
            format!(
                "Python Core 시작 실패 ({}): {error}",
                spec.program.display()
            )
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Python Core readiness stream을 열 수 없습니다".to_string())?;
        let stderr = child.stderr.take();

        let mut line = String::new();
        let mut stdout_reader = BufReader::new(stdout);
        stdout_reader
            .read_line(&mut line)
            .map_err(|error| format!("Python Core readiness 읽기 실패: {error}"))?;

        let ready: ReadyMessage = match serde_json::from_str(&line) {
            Ok(msg) => msg,
            Err(error) => {
                // A Core that is still running (e.g. a version that omits a
                // required field) would never close stderr — stop it first so
                // reading the rest cannot block the shell forever.
                let _ = child.kill();
                let _ = child.wait();
                let mut err_msg = String::new();
                if let Some(err_stream) = stderr {
                    let mut stderr_reader = BufReader::new(err_stream);
                    let _ = stderr_reader.read_to_string(&mut err_msg);
                }
                let err_msg_trimmed = err_msg.trim();
                let detail = if err_msg_trimmed.is_empty() {
                    "Python 프로세스가 응답 출력을 생성하지 않고 즉시 종료되었습니다.".to_string()
                } else {
                    format!("stderr: {err_msg_trimmed}")
                };
                return Err(format!(
                    "Python Core readiness 형식 오류 ({error}). {detail} ('make install'로 파이썬 개발 환경을 재구축해 보세요)"
                ));
            }
        };

        let (endpoint, mcp_endpoint) = match ready_endpoints(&ready) {
            Ok(endpoints) => endpoints,
            Err(error) => {
                // The Core already reported ready and is listening; refusing it
                // must not leave it running behind the error dialog.
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };

        // Keep draining both pipes for the life of the child. Dropping the
        // handles here closed the read ends, so every later `sys.stderr.write`
        // in the Python Core (e.g. hybrid_search's sqlite-vec warning) raised
        // BrokenPipeError inside the request handler → 500 on /hybrid-search.
        forward_pipe("core", stdout_reader);
        if let Some(err_stream) = stderr {
            forward_pipe("core:stderr", BufReader::new(err_stream));
        }

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

/// Relay a child pipe line-by-line to the shell's stderr until EOF.
///
/// The reader thread must outlive `start()`; otherwise the pipe's read end is
/// closed and the child's next write fails with EPIPE.
fn forward_pipe<R: Read + Send + 'static>(tag: &'static str, reader: BufReader<R>) {
    std::thread::Builder::new()
        .name(format!("raven-{tag}"))
        .spawn(move || {
            for line in reader.lines() {
                match line {
                    Ok(text) => eprintln!("[raven-{tag}] {text}"),
                    Err(_) => break,
                }
            }
        })
        .ok();
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
}

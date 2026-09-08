use serde::Deserialize;
use std::env;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

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
/// `RAVEN_MCP_MODE=admin` for the standalone operator instance. MCP has no
/// authentication, so this is only sound because the listener binds the
/// tailnet address rather than the API's 0.0.0.0 — see
/// `raven/desktop/runtime.py::_resolve_mcp_host`. Narrow it with
/// `RAVEN_DESKTOP_MCP_MODE=read|write`. An unrecognized value falls back to
/// `read` — the safe direction — rather than failing the launch.
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
    // Bundled mode: -P prevents CWD from shadowing the bundled raven package
    if python_path.is_some() {
        args.push("-P".into());
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

#[derive(Deserialize)]
struct ReadyMessage {
    host: String,
    port: u16,
    #[serde(default)]
    mcp_port: Option<u16>,
    /// MCP는 API와 다른 주소에 바인딩된다 (API는 LAN 전체, MCP는 tailnet/loopback).
    /// 따라서 `host`처럼 loopback으로 정규화하지 않고 실제 바인딩을 그대로 받는다.
    #[serde(default)]
    mcp_host: Option<String>,
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
            .unwrap_or_else(|| "0.0.0.0".to_string());
        let mcp_mode = mcp_mode_from_env(env::var("RAVEN_DESKTOP_MCP_MODE").ok());
        let spec = runtime_launch_spec(python, mcp, python_path, Some(host), Some(mcp_mode));
        let mut cmd = Command::new(&spec.program);
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

        if ready.host != "127.0.0.1" || ready.port == 0 {
            return Err("Python Core가 유효한 loopback endpoint를 보고하지 않았습니다".to_string());
        }

        // Keep draining both pipes for the life of the child. Dropping the
        // handles here closed the read ends, so every later `sys.stderr.write`
        // in the Python Core (e.g. hybrid_search's sqlite-vec warning) raised
        // BrokenPipeError inside the request handler → 500 on /hybrid-search.
        forward_pipe("core", stdout_reader);
        if let Some(err_stream) = stderr {
            forward_pipe("core:stderr", BufReader::new(err_stream));
        }

        let mcp_endpoint = ready.mcp_port.map(|p| {
            let host = ready.mcp_host.as_deref().unwrap_or(&ready.host);
            format!("http://{host}:{p}/mcp")
        });

        Ok(Self {
            child,
            endpoint: format!("http://{}:{}", ready.host, ready.port),
            mcp_endpoint,
        })
    }

    pub(crate) fn stop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
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

mod core;

use std::sync::Mutex;
use tauri::{command, Manager, RunEvent, State, WebviewWindow, WindowEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;

/// Reveals the window and, if the webview's content process died while the
/// window was hidden (macOS reclaims suspended WKWebView renderers, leaving
/// the window permanently blank on redisplay), forces a reload to recover.
const RECOVER_IF_BLANK_JS: &str =
    "if (!document.getElementById('root')?.hasChildNodes()) { location.reload(); }";

fn show_and_recover(window: &WebviewWindow) {
    window.show().unwrap();
    window.set_focus().unwrap();
    let _ = window.eval(RECOVER_IF_BLANK_JS);
}

#[derive(Default)]
struct CoreState(Mutex<Option<core::ManagedCore>>);

impl CoreState {
    fn start(&self, mcp: bool, resource_dir: Option<std::path::PathBuf>) -> Result<(), String> {
        let core = core::ManagedCore::start(mcp, resource_dir)?;
        eprintln!("Raven Python Core ready at {}", core.endpoint);
        if let Some(ref mcp_ep) = core.mcp_endpoint {
            eprintln!("Raven MCP endpoint at {mcp_ep}");
        }
        *self
            .0
            .lock()
            .map_err(|_| "Python Core 상태 lock이 손상되었습니다".to_string())? = Some(core);
        Ok(())
    }

    fn stop(&self) {
        if let Ok(mut state) = self.0.lock() {
            if let Some(mut core) = state.take() {
                core.stop();
            }
        }
    }
}

/// Exposes the managed Python Core endpoint to the webview (waits until ready).
#[command]
async fn core_endpoint(state: State<'_, CoreState>) -> Result<String, String> {
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(15);
    while start.elapsed() < timeout {
        if let Ok(guard) = state.0.lock() {
            if let Some(ref core) = *guard {
                return Ok(core.endpoint.clone());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err("Python Core startup timed out".to_string())
}

/// Exposes the MCP HTTP endpoint to the webview (waits until core is ready, empty string if disabled).
#[command]
async fn mcp_endpoint(state: State<'_, CoreState>) -> Result<String, String> {
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(15);
    while start.elapsed() < timeout {
        if let Ok(guard) = state.0.lock() {
            if let Some(ref core) = *guard {
                return Ok(core.mcp_endpoint.clone().unwrap_or_default());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Ok(String::new())
}

/// Exposes the desktop app version.
#[command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

pub fn run() {
    let mcp_enabled = core::mcp_enabled_from_env(std::env::var("RAVEN_DESKTOP_MCP").ok());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(CoreState::default())
        .invoke_handler(tauri::generate_handler![core_endpoint, mcp_endpoint, app_version])
        .setup(move |app| {
            // Python Core는 setup 훅에서 동기적으로 기다리지 않고 별도 task로 기동한다.
            // setup 훅이 Err를 반환하면 Tauri 내부가 응답 불가능한 패닉(panic→abort, FFI 경계라
            // unwind 불가)으로 처리하므로, 여기서 실패를 직접 흡수해 다이얼로그 후 종료한다.
            let handle = app.handle().clone();
            let resource_dir = app.path().resource_dir().ok();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = handle.state::<CoreState>().start(mcp_enabled, resource_dir) {
                    let msg = format!("Raven failed to start:\n{e}");
                    eprintln!("{msg}");
                    let _ = std::process::Command::new("osascript")
                        .args([
                            "-e",
                            &format!(
                                "display dialog \"{}\" with title \"Raven\" buttons {{\"OK\"}} default button \"OK\" with icon stop",
                                msg.replace('"', "\\\"").replace('\n', "\\n")
                            ),
                        ])
                        .status();
                    handle.exit(1);
                }
            });

            let show_i = MenuItem::with_id(app, "show", "Open Dashboard", true, None::<&str>)?;
            let restart_i = MenuItem::with_id(app, "restart", "Restart Backend", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Raven", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &restart_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "restart" => {
                        let state = app.state::<CoreState>();
                        state.stop();
                        let resource_dir = app.path().resource_dir().ok();
                        let mcp_enabled = std::env::var("RAVEN_DESKTOP_MCP")
                            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                            .unwrap_or(false);
                        if let Err(e) = state.start(mcp_enabled, resource_dir) {
                            eprintln!("Failed to restart core: {}", e);
                        }
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            show_and_recover(&window);
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    window.hide().unwrap();
                }
                // macOS can silently kill/suspend the WKWebView content process
                // (e.g. memory pressure, long time hidden) while the window
                // itself survives — the next time the window is actually
                // looked at is when it regains focus, so recover-check there
                // rather than only on the tray/dock show path.
                WindowEvent::Focused(true) => {
                    if let Some(webview) = window.app_handle().get_webview_window("main") {
                        let _ = webview.eval(RECOVER_IF_BLANK_JS);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(|app, event| {
            match event {
                RunEvent::Exit | RunEvent::ExitRequested { .. } => {
                    app.state::<CoreState>().stop();
                }
                RunEvent::Reopen { has_visible_windows, .. } => {
                    if !has_visible_windows {
                        if let Some(window) = app.get_webview_window("main") {
                            show_and_recover(&window);
                        }
                    }
                }
                _ => {}
            }
        }),
        Err(e) => {
            let msg = format!("Raven failed to start:\n{e}");
            eprintln!("{msg}");
            // Native macOS dialog instead of panic → abort
            let _ = std::process::Command::new("osascript")
                .args([
                    "-e",
                    &format!(
                        "display dialog \"{}\" with title \"Raven\" buttons {{\"OK\"}} default button \"OK\" with icon stop",
                        msg.replace('"', "\\\"").replace('\n', "\\n")
                    ),
                ])
                .status();
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::core::{mcp_enabled_from_env, mcp_mode_from_env, runtime_launch_spec};
    use std::path::PathBuf;

    #[test]
    fn runtime_launch_spec_invokes_python_desktop_module() {
        let python = PathBuf::from("/tmp/python");
        let spec = runtime_launch_spec(python.clone(), false, None, None, None);
        assert_eq!(spec.program, python);
        assert_eq!(spec.args, vec!["-m", "raven.desktop.runtime"]);
        assert!(spec.env.is_empty());
    }

    #[test]
    fn runtime_launch_spec_with_mcp_adds_flag() {
        let python = PathBuf::from("/tmp/python");
        let spec = runtime_launch_spec(python.clone(), true, None, None, Some("admin".into()));
        assert_eq!(
            spec.args,
            vec!["-m", "raven.desktop.runtime", "--mcp", "--mcp-mode", "admin"]
        );
    }

    #[test]
    fn runtime_launch_spec_with_python_path_sets_env() {
        let python = PathBuf::from("/tmp/python");
        let pp = PathBuf::from("/app/Resources/raven");
        let spec = runtime_launch_spec(python, false, Some(pp.clone()), None, None);
        assert_eq!(spec.args, vec!["-P", "-m", "raven.desktop.runtime"]);
        assert_eq!(
            spec.env,
            vec![("PYTHONPATH".to_string(), pp.to_string_lossy().into_owned())]
        );
    }

    #[test]
    fn mcp_defaults_to_enabled_when_env_unset() {
        // v0.7.184 회귀 가드: 기본 OFF였던 탓에 GUI 실행 시 MCP 엔드포인트가
        // 조용히 없었고, 외부 에이전트가 "안 떠 있다"를 반복해서 겪었다.
        assert!(mcp_enabled_from_env(None));
        assert!(mcp_enabled_from_env(Some("1".into())));
        assert!(mcp_enabled_from_env(Some("true".into())));
    }

    #[test]
    fn mcp_opts_out_only_on_explicit_falsey() {
        assert!(!mcp_enabled_from_env(Some("0".into())));
        assert!(!mcp_enabled_from_env(Some("false".into())));
        assert!(!mcp_enabled_from_env(Some("off".into())));
    }

    #[test]
    fn mcp_mode_defaults_to_admin_and_degrades_garbage_to_read() {
        assert_eq!(mcp_mode_from_env(None), "admin");
        assert_eq!(mcp_mode_from_env(Some("admin".into())), "admin");
        assert_eq!(mcp_mode_from_env(Some("write".into())), "write");
        assert_eq!(mcp_mode_from_env(Some("read".into())), "read");
        // 오타/미지의 값은 권한을 넓히는 쪽이 아니라 좁히는 쪽으로 떨어져야 한다.
        assert_eq!(mcp_mode_from_env(Some("root".into())), "read");
        assert_eq!(mcp_mode_from_env(Some("ADMIN".into())), "read");
    }

    #[test]
    fn runtime_launch_spec_with_host_adds_flag() {
        let python = PathBuf::from("/tmp/python");
        let spec = runtime_launch_spec(python, false, None, Some("0.0.0.0".to_string()), None);
        assert_eq!(
            spec.args,
            vec!["-m", "raven.desktop.runtime", "--host", "0.0.0.0"]
        );
    }
}

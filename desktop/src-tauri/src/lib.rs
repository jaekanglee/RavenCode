mod core;

use std::sync::Mutex;
use tauri::{command, Manager, RunEvent, State, WebviewWindow, WindowEvent};
use tauri::menu::{Menu, MenuItem, MenuItemBuilder, SubmenuBuilder};
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

/// Snapshot of the managed Python Core, for the dashboard's admin page.
#[derive(serde::Serialize)]
struct CoreStatus {
    running: bool,
    endpoint: Option<String>,
    mcp_endpoint: Option<String>,
}

/// Reports whether the Python Core child process is alive, plus its endpoints.
#[command]
fn core_status(state: State<'_, CoreState>) -> CoreStatus {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(managed) = guard.as_mut() {
            return CoreStatus {
                running: managed.is_alive(),
                endpoint: Some(managed.endpoint.clone()),
                mcp_endpoint: managed.mcp_endpoint.clone(),
            };
        }
    }
    CoreStatus { running: false, endpoint: None, mcp_endpoint: None }
}

/// Stops and relaunches the Python Core — shared by the tray "Restart Backend"
/// item and the dashboard's admin page restart button.
fn do_restart_core(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<CoreState>();
    state.stop();
    let resource_dir = app.path().resource_dir().ok();
    let mcp_enabled = core::mcp_enabled_from_env(std::env::var("RAVEN_DESKTOP_MCP").ok());
    state.start(mcp_enabled, resource_dir)
}

/// Restarts the Python Core on demand (invoked from the dashboard admin page).
#[command]
fn restart_core(app: tauri::AppHandle) -> Result<(), String> {
    do_restart_core(&app)
}

/// Resolves where an exported file should land inside `dir`.
///
/// 웹뷰가 준 이름은 신뢰하지 않는다 — 경로 성분을 버리고 파일명만 취하며,
/// 같은 이름이 있으면 덮어쓰지 않고 번호를 붙인다 (wry 기본 다운로드 동작과 동일).
fn resolve_download_target(dir: &std::path::Path, filename: &str) -> Result<std::path::PathBuf, String> {
    use std::path::Path;

    let name = Path::new(filename)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .ok_or_else(|| format!("잘못된 파일명입니다: {filename:?}"))?;

    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();

    let mut target = dir.join(name);
    let mut counter = 1;
    while target.exists() {
        target = dir.join(format!("{stem} ({counter}){ext}"));
        counter += 1;
    }
    Ok(target)
}

/// Writes an exported file (문서 .md 내보내기 등) into the user's Downloads
/// folder and returns the saved path.
///
/// 브라우저에서 통하는 Blob + `<a download>` 저장이 데스크톱 앱에서는 **조용히
/// 아무 일도 하지 않는다**: wry 0.55의 `navigation_policy`는 다운로드 내비게이션을
/// 만나면 `has_download_handler`가 false일 때 `WKNavigationActionPolicy::Cancel`을
/// 돌려주고, 그 플래그는 웹뷰 빌더에 `on_download` 훅을 건 경우에만 true가 된다.
/// Raven의 창은 tauri.conf.json이 만들기 때문에 빌더 훅을 걸 수 없으므로,
/// 파일 저장을 커맨드로 처리한다 (신규 의존성 ❌ — `dirs`는 이미 쓰고 있다).
#[command]
fn save_download_file(filename: String, contents: String) -> Result<String, String> {
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "다운로드 폴더를 찾지 못했습니다.".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("폴더를 만들지 못했습니다: {e}"))?;
    let target = resolve_download_target(&dir, &filename)?;
    std::fs::write(&target, contents).map_err(|e| format!("파일을 저장하지 못했습니다: {e}"))?;
    Ok(target.display().to_string())
}

pub fn run() {
    let mcp_enabled = core::mcp_enabled_from_env(std::env::var("RAVEN_DESKTOP_MCP").ok());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(CoreState::default())
        .invoke_handler(tauri::generate_handler![
            core_endpoint,
            mcp_endpoint,
            app_version,
            core_status,
            restart_core,
            save_download_file
        ])
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "reload" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("location.reload()");
                }
            }
        })
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

            // 데스크탑 앱은 브라우저가 아니라 웹뷰라 기본 Cmd+R/Ctrl+R 새로고침이 없다 —
            // View 메뉴에 accelerator를 달아 웹뷰를 강제 새로고침한다(창 포커스 여부와 무관하게 앱 전역 메뉴).
            let reload_i = MenuItemBuilder::new("Reload")
                .id("reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let view_menu = SubmenuBuilder::new(app, "View").item(&reload_i).build()?;
            let app_menu = Menu::default(app.handle())?;
            app_menu.append(&view_menu)?;
            app.set_menu(app_menu)?;

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
                        if let Err(e) = do_restart_core(app) {
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
    use super::resolve_download_target;
    use std::path::PathBuf;

    // v0.7.184+: 문서 내보내기 파일 저장 경로 규칙.
    // 웹뷰에서 온 파일명이라 경로 탈출을 허용하면 안 되고, 기존 파일을 덮어써서도 안 된다.

    #[test]
    fn download_target_keeps_korean_filename() {
        let dir = std::env::temp_dir().join("raven-dl-test-korean");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = resolve_download_target(&dir, "내보내기-시험-문서.md").unwrap();
        assert_eq!(target, dir.join("내보내기-시험-문서.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_target_strips_path_components() {
        let dir = std::env::temp_dir().join("raven-dl-test-traversal");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = resolve_download_target(&dir, "../../etc/passwd").unwrap();
        assert_eq!(target, dir.join("passwd"));
        let target = resolve_download_target(&dir, "/tmp/evil.md").unwrap();
        assert_eq!(target, dir.join("evil.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_target_numbers_instead_of_overwriting() {
        let dir = std::env::temp_dir().join("raven-dl-test-dedupe");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("note.md"), "first").unwrap();
        assert_eq!(resolve_download_target(&dir, "note.md").unwrap(), dir.join("note (1).md"));
        std::fs::write(dir.join("note (1).md"), "second").unwrap();
        assert_eq!(resolve_download_target(&dir, "note.md").unwrap(), dir.join("note (2).md"));
        // 원본은 그대로 남아 있어야 한다.
        assert_eq!(std::fs::read_to_string(dir.join("note.md")).unwrap(), "first");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_target_rejects_empty_and_dot_names() {
        let dir = std::env::temp_dir().join("raven-dl-test-bad");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(resolve_download_target(&dir, "").is_err());
        assert!(resolve_download_target(&dir, "..").is_err());
        assert!(resolve_download_target(&dir, "/").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

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

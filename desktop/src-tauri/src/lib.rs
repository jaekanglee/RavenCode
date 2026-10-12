mod core;

use std::sync::{Arc, Mutex, PoisonError};
use tauri::{command, Manager, RunEvent, State, WebviewWindow, WindowEvent};
use tauri::menu::{Menu, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;

/// Reveals the window and, if the webview's content process died while the
/// window was hidden (macOS reclaims suspended WKWebView renderers, leaving
/// the window permanently blank on redisplay), forces a reload to recover.
///
/// Issue #1 A-1: a broken JS bundle keeps `#root` empty, so an unconditional
/// reload repeated on every focus. The script now caps automatic reloads
/// (3 until a healthy screen is seen, state in sessionStorage) and then draws
/// a static notice instead — see blank_recovery.js for the full policy.
const RECOVER_IF_BLANK_JS: &str = concat!(
    include_str!("blank_recovery.js"),
    "\n__ravenBlankRecovery();\n"
);

fn show_and_recover(window: &WebviewWindow) {
    window.show().unwrap();
    window.set_focus().unwrap();
    let _ = window.eval(RECOVER_IF_BLANK_JS);
}

/// The running Core, plus the start still waiting for readiness (Issue #43) so
/// `stop` (app exit) can abort it instead of leaving it behind.
///
/// Issue #44: the pending slot is also the "a start is running" marker. Only one
/// start or restart runs at a time; one requested meanwhile is refused with
/// `StartError::Busy` rather than queued or allowed to cancel the running one —
/// either of those let an older start's Core (already listening, not yet stored)
/// live next to the newer one. The readiness wait never holds a lock.
///
/// The third field is the API endpoint last handed to the webview. It outlives
/// the Core (a failed restart leaves none running), so a later restart on another
/// port is still recognised as a move.
///
/// The fourth is where every Core started from here sends its post-readiness
/// events (Issue #58); set once in `setup`, absent in tests that do not need it.
#[derive(Default)]
struct CoreState(
    Mutex<Option<core::ManagedCore>>,
    Mutex<Option<Arc<core::PendingStart>>>,
    Mutex<Option<String>>,
    Mutex<Option<core::EventSink>>,
);

/// Frees the "a start is running" slot however `start_with` ends — a panic in a
/// launch must not leave every later restart refused as `Busy`.
struct StartSlot<'a>(&'a CoreState);

impl Drop for StartSlot<'_> {
    fn drop(&mut self) {
        *self.0.pending() = None;
    }
}

impl CoreState {
    fn start(&self, mcp: bool, resource_dir: Option<std::path::PathBuf>) -> Result<bool, core::StartError> {
        let events = self.3.lock().unwrap_or_else(PoisonError::into_inner).clone();
        self.start_with(|pending| core::ManagedCore::start(mcp, resource_dir, pending, events))
    }

    /// Replace the running Core (if any) with a new one; `Ok(true)` when its API
    /// endpoint changed — the webview still points at the old one then.
    fn start_with(
        &self,
        launch: impl FnOnce(&core::PendingStart) -> Result<core::ManagedCore, core::StartError>,
    ) -> Result<bool, core::StartError> {
        let pending = {
            let mut slot = self.pending();
            if slot.is_some() {
                return Err(core::StartError::Busy);
            }
            Arc::clone(slot.insert(Arc::new(core::PendingStart::default())))
        };
        // Declared after `pending`, dropped before it: runs once this start is
        // over — its Core stored or gone — and only then lets another start in.
        let _slot = StartSlot(self);
        // The running Core goes first, so two Cores never run side by side.
        if let Some(mut previous) = self.0.lock().ok().and_then(|mut state| state.take()) {
            previous.stop();
        }
        let result = match launch(&pending) {
            // Cancelled after the child left the cancel slot (it was parsing the
            // line, or timing out): the start failed, but nobody is waiting on it
            // any more — the app is exiting. Not a failure to report.
            Err(core::StartError::Failed(error)) if pending.is_cancelled() => {
                eprintln!("[core] superseded start ended with: {error}");
                Err(core::StartError::Cancelled)
            }
            other => other,
        };
        let result = result.and_then(|core| {
            let mut state = self
                .0
                .lock()
                .map_err(|_| core::StartError::Failed("Python Core 상태 lock이 손상되었습니다".into()))?;
            // `stop` cancels before it takes the state lock, so a start that
            // finished after it ran sees the flag here and drops (stops) its Core.
            if pending.is_cancelled() {
                return Err(core::StartError::Cancelled);
            }
            eprintln!("Raven Python Core ready at {}", core.endpoint);
            if let Some(ref mcp_ep) = core.mcp_endpoint {
                eprintln!("Raven MCP endpoint at {mcp_ep}");
            }
            let mut served = self.2.lock().unwrap_or_else(PoisonError::into_inner);
            let changed = served.as_ref().is_some_and(|before| *before != core.endpoint);
            *served = Some(core.endpoint.clone());
            *state = Some(core);
            Ok(changed)
        });
        result
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, Option<Arc<core::PendingStart>>> {
        self.1.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn stop(&self) {
        // Cancel, but leave the slot to the start itself: it clears it once its
        // child is gone, so nothing new can start next to a Core still winding down.
        let pending = self.pending().clone();
        if let Some(pending) = pending {
            pending.cancel();
        }
        if let Ok(mut state) = self.0.lock() {
            if let Some(mut core) = state.take() {
                core.stop();
            }
        }
    }
}

/// Exposes the managed Python Core endpoint to the webview (waits until ready).
#[command]
async fn core_endpoint(app: tauri::AppHandle) -> Result<String, String> {
    off_runtime(move || {
        core_endpoint_within(
            &app.state::<CoreState>(),
            CORE_READY_TIMEOUT,
            CORE_READY_POLL,
        )
    })
    .await
}

/// Exposes the MCP HTTP endpoint to the webview (waits until core is ready; empty string if MCP
/// is off, an error if the Core isn't ready in time).
#[command]
async fn mcp_endpoint(app: tauri::AppHandle) -> Result<String, String> {
    off_runtime(move || {
        mcp_endpoint_within(
            &app.state::<CoreState>(),
            CORE_READY_TIMEOUT,
            CORE_READY_POLL,
        )
    })
    .await
}

/// Runs a Core wait from an async command without occupying an async runtime worker.
///
/// Issue #1 A-2: the wait used to run inline in the async command, so `std::thread::sleep`
/// pinned a runtime worker for up to `CORE_READY_TIMEOUT` per call, and concurrent calls
/// beyond the worker count stalled every other async task. The wait itself (timeout, poll,
/// return contract) is unchanged — it only moves to the blocking pool. It reads the state and
/// never holds the lock across a sleep, so a cancelled caller leaves nothing behind.
async fn off_runtime<T: Send + 'static>(
    wait: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(wait)
        .await
        .map_err(|e| format!("Python Core wait failed: {e}"))?
}

const CORE_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const CORE_READY_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// Waits until the Python Core is running, then reads a value from it.
///
/// Issue #1 A-4: running out of time is an error, never a default value. `mcp_endpoint`
/// used to answer `Ok("")` on timeout, which the webview cannot tell apart from a Core that
/// runs with MCP disabled — a failed or stuck Core start looked like "MCP off".
fn wait_for_core<T>(
    state: &CoreState,
    timeout: std::time::Duration,
    poll: std::time::Duration,
    read: impl Fn(&core::ManagedCore) -> T,
) -> Result<T, String> {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if let Ok(guard) = state.0.lock() {
            if let Some(ref core) = *guard {
                return Ok(read(core));
            }
        }
        std::thread::sleep(poll);
    }
    Err("Python Core startup timed out".to_string())
}

fn core_endpoint_within(
    state: &CoreState,
    timeout: std::time::Duration,
    poll: std::time::Duration,
) -> Result<String, String> {
    wait_for_core(state, timeout, poll, |core| core.endpoint.clone())
}

/// `Ok("")` only when the Core is running without MCP (disabled, or MCP gave up at startup —
/// see raven/desktop/runtime.py "MCP is best-effort"). Not ready in time → `Err`.
fn mcp_endpoint_within(
    state: &CoreState,
    timeout: std::time::Duration,
    poll: std::time::Duration,
) -> Result<String, String> {
    wait_for_core(state, timeout, poll, |core| core.mcp_endpoint.clone().unwrap_or_default())
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
/// item and the dashboard's admin page restart button. Refused with
/// `StartError::Busy` while another start or restart runs (Issue #44).
///
/// `Ok(true)` when the API endpoint moved: the port is 8765 when free, otherwise
/// OS-assigned, so a restart can change it, and the dashboard reads it once at load.
fn do_restart_core(app: &tauri::AppHandle) -> Result<bool, core::StartError> {
    let resource_dir = app.path().resource_dir().ok();
    let mcp_enabled = core::mcp_enabled_from_env(std::env::var("RAVEN_DESKTOP_MCP").ok());
    app.state::<CoreState>().start(mcp_enabled, resource_dir)
}

/// What the tray tells the user after "Restart Backend" (Issue #44): it used to
/// only reach stderr. `None` when there is nothing to say (success, app exit).
fn tray_restart_notice(result: &Result<bool, core::StartError>) -> Option<String> {
    match result {
        Ok(_) | Err(core::StartError::Cancelled) => None,
        Err(core::StartError::Busy) => Some(format!("Backend를 재시작하지 않았습니다.\n{}", core::StartError::Busy)),
        Err(error) => Some(format!("Backend 재시작에 실패했습니다.\n{error}")),
    }
}

static TRAY_NOTICE_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Tray "Restart Backend". The menu callback runs on the main thread, so the
/// restart itself goes to the blocking pool (Issue #43), and its outcome is shown
/// in a non-blocking dialog (Issue #44, like the startup failure notice of #1 A-3).
fn restart_from_tray(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = do_restart_core(&app);
        if matches!(result, Ok(true)) {
            // Nothing in the page is waiting on this restart, so reload it here
            // (the dashboard's own restart reloads itself once the call returns).
            // Only on a real move: the page's requests would otherwise go to
            // whatever now holds the old port. A read the page has in flight may
            // be sent again by the IPC layer; that is harmless for reads.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("location.reload()");
            }
        }
        if let Some(notice) = tray_restart_notice(&result) {
            use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
            eprintln!("{notice}");
            // One notice at a time: repeated clicks during a long start would
            // otherwise stack a dialog per click.
            if !TRAY_NOTICE_OPEN.swap(true, std::sync::atomic::Ordering::SeqCst) {
                app.dialog()
                    .message(notice)
                    .title("Raven")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| TRAY_NOTICE_OPEN.store(false, std::sync::atomic::Ordering::SeqCst));
            }
        }
    });
}

/// Restarts the Python Core on demand (invoked from the dashboard admin page).
///
/// Issue #43: async + blocking pool, so the readiness wait (up to 60 s) never
/// freezes the main thread — Quit stays responsive and cancels the restart.
///
/// The webview is not reloaded from here even when the endpoint moved: a reload
/// while this call is in flight can make the IPC layer send it again. The
/// dashboard compares `core_endpoint` after it returns and reloads itself.
#[command]
async fn restart_core(app: tauri::AppHandle) -> Result<(), String> {
    off_runtime(move || do_restart_core(&app).map(|_| ()).map_err(|e| e.to_string())).await
}

/// What the shell does about one Core event (Issue #58).
#[derive(Debug, PartialEq, Eq)]
enum EventAction {
    Nothing,
    /// Tell the user (non-blocking warning dialog).
    Notify(String),
    /// Restart the Core through the #44 path (then reload if the endpoint moved).
    Restart,
    /// Restart at this time, if this Core is still the running one then.
    RestartAt(std::time::Instant),
}

/// The shortest time between two network-triggered restarts. The Core already
/// waits for a stable mismatch (5 s) and asks again after 30 s while it lasts; this
/// keeps a flapping tailnet from restarting the Core in a loop even if a Core
/// asked sooner (each new Core starts its own 5 s wait).
const NETWORK_RESTART_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(20);

/// Apply `event` from the Core `id` to `state`. Events from a Core that is no
/// longer the running one are dropped — it has been replaced or stopped.
fn handle_core_event(
    state: &CoreState,
    id: u64,
    event: core::CoreEvent,
    last_network_restart: &mut Option<std::time::Instant>,
) -> EventAction {
    let mut running = state.0.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(core) = running.as_mut().filter(|core| core.id == id) else {
        return EventAction::Nothing;
    };
    match event {
        core::CoreEvent::McpEndpoint(endpoint) => {
            eprintln!("Raven MCP endpoint moved to {endpoint}");
            core.mcp_endpoint = Some(endpoint);
            EventAction::Nothing
        }
        core::CoreEvent::GuardBlocked { listener, address } => EventAction::Notify(format!(
            "Tailscale 주소 {address}의 {listener} 포트를 다른 프로세스가 먼저 잡고 있어 보호하지 못했습니다.\n\
             그 주소로 접속하는 요청(Bearer 토큰 포함)은 Raven이 아니라 그 프로세스로 갈 수 있습니다. \
             Raven은 이 주소를 MCP 주소로 알리지 않습니다. 그 프로세스를 확인해 종료하세요."
        )),
        core::CoreEvent::Rebind { bound, target } => {
            eprintln!("[core] Core bound to {bound}, tailnet address now {target}");
            network_restart_due(last_network_restart)
        }
    }
}

/// `Restart` now (and record it), or `RestartAt` once the minimum interval has passed.
fn network_restart_due(last_network_restart: &mut Option<std::time::Instant>) -> EventAction {
    let now = std::time::Instant::now();
    if let Some(at) = last_network_restart.map(|last| last + NETWORK_RESTART_MIN_INTERVAL).filter(|at| *at > now) {
        eprintln!("[core] network restart deferred until the 20s minimum interval has passed");
        return EventAction::RestartAt(at);
    }
    *last_network_restart = Some(now);
    eprintln!("[core] restarting the Core for the new tailnet address");
    EventAction::Restart
}

/// Whether `id` is the Core running now.
fn is_running_core(state: &CoreState, id: u64) -> bool {
    state.0.lock().unwrap_or_else(PoisonError::into_inner).as_ref().is_some_and(|core| core.id == id)
}

/// What the user is told when a network-triggered restart did not succeed.
fn network_restart_notice(result: &Result<bool, core::StartError>) -> Option<String> {
    match result {
        // Another start owns the slot; the Core asks again later if still needed.
        Ok(_) | Err(core::StartError::Cancelled | core::StartError::Busy) => None,
        Err(error) => Some(format!(
            "Tailscale 주소가 바뀌어 Backend를 다시 시작했지만 실패했습니다.\n{error}\n트레이의 Restart Backend로 다시 시도하세요."
        )),
    }
}

static EVENT_NOTICE_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn show_warning(app: &tauri::AppHandle, open: &'static std::sync::atomic::AtomicBool, notice: String) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    eprintln!("{notice}");
    if !open.swap(true, std::sync::atomic::Ordering::SeqCst) {
        app.dialog()
            .message(notice)
            .title("Raven")
            .kind(MessageDialogKind::Warning)
            .show(move |_| open.store(false, std::sync::atomic::Ordering::SeqCst));
    }
}

/// Handle Core events for the life of the app, on their own thread (Issue #58):
/// a restart waits up to the readiness timeout and must not hold the main thread.
fn spawn_core_event_loop(app: &tauri::AppHandle) {
    let (sink, events) = std::sync::mpsc::channel::<(u64, core::CoreEvent)>();
    *app.state::<CoreState>().3.lock().unwrap_or_else(PoisonError::into_inner) = Some(sink);
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("raven-core-events".into()).spawn(move || {
        use std::sync::mpsc::RecvTimeoutError;
        let mut last_network_restart = None;
        // A rebind that arrived within the minimum interval: (Core id, when to act).
        let mut deferred: Option<(u64, std::time::Instant)> = None;
        loop {
            let next = match deferred {
                Some((_, at)) => events.recv_timeout(at.saturating_duration_since(std::time::Instant::now())),
                None => events.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            let action = match next {
                Ok((id, event)) => match handle_core_event(&app.state::<CoreState>(), id, event, &mut last_network_restart) {
                    EventAction::RestartAt(at) => {
                        deferred = Some((id, at));
                        EventAction::Nothing
                    }
                    other => other,
                },
                Err(RecvTimeoutError::Timeout) => match deferred.take() {
                    // Still the Core that asked: nothing has restarted it meanwhile.
                    Some((id, _)) if is_running_core(&app.state::<CoreState>(), id) => {
                        network_restart_due(&mut last_network_restart)
                    }
                    _ => EventAction::Nothing,
                },
                Err(RecvTimeoutError::Disconnected) => break,
            };
            match action {
                EventAction::Nothing | EventAction::RestartAt(_) => {}
                EventAction::Notify(notice) => show_warning(&app, &EVENT_NOTICE_OPEN, notice),
                EventAction::Restart => {
                    deferred = None;
                    let result = do_restart_core(&app);
                    if matches!(result, Ok(true)) {
                        // The old endpoint is gone with its address; nothing in the
                        // page is waiting on this restart (see restart_from_tray).
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("location.reload()");
                        }
                    }
                    if let Some(notice) = network_restart_notice(&result) {
                        show_warning(&app, &EVENT_NOTICE_OPEN, notice);
                    }
                }
            }
        }
    });
    if spawned.is_err() {
        eprintln!("[core] could not start the Core event thread — network changes will not be followed");
    }
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

fn startup_failure_message(error: &dyn std::fmt::Display) -> String {
    format!("Raven failed to start:\n{error}")
}

/// Tells the user the Python Core didn't start, then exits with code 1 once they acknowledge it.
///
/// Issue #1 A-3: this used to shell out to macOS-only `osascript` and wait on its `.status()`,
/// pinning the async runtime worker until OK was clicked. `show` returns at once — the plugin
/// presents the dialog on the main thread (macOS/Windows/Linux alike) and runs the callback on
/// its own thread after the user responds, so the exit still happens only after the notice
/// has been seen, without blocking a worker or the event loop.
fn report_startup_failure_and_exit(app: &tauri::AppHandle, error: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let msg = startup_failure_message(&error);
    eprintln!("{msg}");
    let exit_handle = app.clone();
    app.dialog()
        .message(msg)
        .title("Raven")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(move |_| exit_handle.exit(1));
}

pub fn run() {
    let mcp_enabled = core::mcp_enabled_from_env(std::env::var("RAVEN_DESKTOP_MCP").ok());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
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
            // Before the first start, so that Core's events are delivered too.
            spawn_core_event_loop(&handle);
            // Issue #43: the readiness wait blocks (bounded by CORE_READINESS_TIMEOUT),
            // so it runs on the blocking pool rather than an async runtime worker.
            tauri::async_runtime::spawn_blocking(move || {
                match handle.state::<CoreState>().start(mcp_enabled, resource_dir) {
                    Ok(_) => {}
                    // App exit, or a tray restart got in first and owns the start — not a failure.
                    Err(e @ (core::StartError::Cancelled | core::StartError::Busy)) => {
                        eprintln!("Raven Python Core initial start skipped: {e}")
                    }
                    Err(core::StartError::Failed(e)) => report_startup_failure_and_exit(&handle, &e),
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
                    "restart" => restart_from_tray(app),
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
                // Tauri only defines `Reopen` on macOS (Dock icon click); matching it
                // unconditionally broke the Linux/Windows build (Issue #40).
                #[cfg(target_os = "macos")]
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
            // No event loop or AppHandle exists yet, so tauri_plugin_dialog can't show anything
            // here (Issue #1 A-3) — report on stderr and keep the exit code.
            eprintln!("{}", startup_failure_message(&e));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    // Issue #1 A-4: mcp_endpoint는 Core가 준비되지 않은 채 타임아웃되면 Ok("")를 돌려줬다 —
    // "MCP 꺼짐"(정상 빈 값)과 구분되지 않는 실패 위장. 타임아웃은 Err로 전파한다.
    use super::{
        core::ManagedCore, core_endpoint_within, mcp_endpoint_within, off_runtime, CoreState,
        CORE_READY_POLL, CORE_READY_TIMEOUT,
    };
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    const T: Duration = Duration::from_millis(300);
    const P: Duration = Duration::from_millis(10);

    fn ready(mcp: Option<&str>) -> CoreState {
        let state = CoreState::default();
        *state.0.lock().unwrap() = Some(ManagedCore::for_test("http://127.0.0.1:5555", mcp));
        state
    }

    #[test]
    fn mcp_endpoint_returns_running_endpoint() {
        let state = ready(Some("http://100.64.0.1:8766/mcp"));
        assert_eq!(
            mcp_endpoint_within(&state, T, P),
            Ok("http://100.64.0.1:8766/mcp".to_string())
        );
    }

    #[test]
    fn mcp_endpoint_is_empty_only_when_core_runs_without_mcp() {
        // MCP 꺼짐(RAVEN_DESKTOP_MCP=0) 또는 Python이 MCP를 best-effort로 포기한 정상 기동.
        let state = ready(None);
        assert_eq!(mcp_endpoint_within(&state, T, P), Ok(String::new()));
    }

    #[test]
    fn mcp_endpoint_timeout_is_an_error_not_empty() {
        // Core가 기동하지 못함(연결·readiness 실패로 상태가 비어 있음) 또는 아직 준비 중.
        let state = CoreState::default();
        let start = Instant::now();
        let got = mcp_endpoint_within(&state, T, P);
        assert!(start.elapsed() >= T, "타임아웃 전에 돌아오면 안 된다");
        assert_eq!(got, Err("Python Core startup timed out".to_string()));
    }

    #[test]
    fn mcp_endpoint_poisoned_state_is_an_error_not_empty() {
        let state = Arc::new(CoreState::default());
        let s2 = state.clone();
        let _ = std::thread::spawn(move || {
            let _g = s2.0.lock().unwrap();
            panic!("poison the Core state lock");
        })
        .join();
        assert!(state.0.is_poisoned());
        assert!(mcp_endpoint_within(&state, T, P).is_err());
    }

    #[test]
    fn mcp_endpoint_waits_for_core_that_becomes_ready() {
        let state = Arc::new(CoreState::default());
        let s2 = state.clone();
        let setter = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            *s2.0.lock().unwrap() = Some(ManagedCore::for_test(
                "http://127.0.0.1:5555",
                Some("http://127.0.0.1:8766/mcp"),
            ));
        });
        assert_eq!(
            mcp_endpoint_within(&state, Duration::from_secs(5), P),
            Ok("http://127.0.0.1:8766/mcp".to_string())
        );
        setter.join().unwrap();
    }

    #[test]
    fn core_endpoint_unchanged_ready_and_timeout() {
        assert_eq!(
            core_endpoint_within(&ready(None), T, P),
            Ok("http://127.0.0.1:5555".to_string())
        );
        assert_eq!(
            core_endpoint_within(&CoreState::default(), T, P),
            Err("Python Core startup timed out".to_string())
        );
    }

    // Issue #1 A-2: core_endpoint/mcp_endpoint는 async 커맨드인데 대기 루프가 std::thread::sleep으로
    // 런타임 워커 스레드를 붙잡았다 — Core가 늦으면 호출 하나가 워커 하나를 최대 15초 점유하고,
    // 동시 호출이 워커 수(코어 수)를 넘으면 다른 async 작업까지 밀린다. 실제 Tauri async 런타임
    // (tauri::async_runtime)에서 커맨드와 같은 경로(off_runtime)를 돌려 확인한다.
    fn on_runtime<F: std::future::Future + Send + 'static>(
        f: F,
    ) -> tauri::async_runtime::JoinHandle<F::Output>
    where
        F::Output: Send + 'static,
    {
        tauri::async_runtime::spawn(f)
    }

    #[test]
    fn core_wait_does_not_hold_runtime_workers() {
        // 워커 수(기본 = CPU 수)보다 훨씬 많은 대기를 걸어 둔다. 대기가 워커를 붙잡으면 뒤에 온
        // 작업은 타임아웃 몇 배 동안 실행되지 못한다.
        const N: usize = 64;
        const WAIT: Duration = Duration::from_millis(600);
        let state = Arc::new(CoreState::default());
        let t0 = Instant::now();
        let waits: Vec<_> = (0..N)
            .map(|_| {
                let s = state.clone();
                on_runtime(off_runtime(move || mcp_endpoint_within(&s, WAIT, P)))
            })
            .collect();
        std::thread::sleep(Duration::from_millis(50));
        let spawned = Instant::now();
        let probe =
            tauri::async_runtime::block_on(on_runtime(async move { spawned.elapsed() })).unwrap();
        assert!(
            probe < Duration::from_millis(200),
            "Core 대기 중 다른 async 작업이 {probe:?} 동안 실행되지 못했다"
        );
        let results: Vec<_> = tauri::async_runtime::block_on(async move {
            let mut out = Vec::new();
            for w in waits {
                out.push(w.await.unwrap());
            }
            out
        });
        let total = t0.elapsed();
        // 동시 호출 결과는 모두 같은 계약(타임아웃 오류)이고, 전체가 타임아웃 한 번 남짓에 끝난다.
        assert!(results
            .iter()
            .all(|r| r == &Err("Python Core startup timed out".to_string())));
        assert!(
            total < WAIT * 2,
            "{N}개 동시 대기가 {total:?} 걸렸다 (워커 순차 처리)"
        );
    }

    #[test]
    fn core_wait_off_runtime_keeps_ready_and_mcp_contract() {
        // 실제 정책 상수(15초/100ms)로: 이미 준비된 Core는 폴링 간격을 기다리지 않고 바로 답한다.
        for (mcp, want) in [
            (
                Some("http://127.0.0.1:8766/mcp"),
                "http://127.0.0.1:8766/mcp",
            ),
            (None, ""),
        ] {
            let s = Arc::new(ready(mcp));
            let s2 = s.clone();
            let t = Instant::now();
            let core = tauri::async_runtime::block_on(on_runtime(off_runtime(move || {
                core_endpoint_within(&s2, CORE_READY_TIMEOUT, CORE_READY_POLL)
            })))
            .unwrap();
            let mcp_got = tauri::async_runtime::block_on(on_runtime(off_runtime(move || {
                mcp_endpoint_within(&s, CORE_READY_TIMEOUT, CORE_READY_POLL)
            })))
            .unwrap();
            assert!(
                t.elapsed() < CORE_READY_POLL,
                "준비된 Core 응답이 {:?} 지연됐다",
                t.elapsed()
            );
            assert_eq!(core, Ok("http://127.0.0.1:5555".to_string()));
            assert_eq!(mcp_got, Ok(want.to_string()));
        }
    }

    #[test]
    fn core_wait_off_runtime_timeout_keeps_error_string() {
        let state = Arc::new(CoreState::default());
        let t = Instant::now();
        let got = tauri::async_runtime::block_on(on_runtime(off_runtime(move || {
            core_endpoint_within(&state, T, P)
        })))
        .unwrap();
        assert!(t.elapsed() >= T, "타임아웃 전에 돌아오면 안 된다");
        assert_eq!(got, Err("Python Core startup timed out".to_string()));
    }

    #[test]
    fn core_wait_concurrent_callers_all_see_core_once_ready() {
        const N: usize = 32;
        let state = Arc::new(CoreState::default());
        let waits: Vec<_> = (0..N)
            .map(|i| {
                let s = state.clone();
                on_runtime(off_runtime(move || {
                    let got = if i % 2 == 0 {
                        mcp_endpoint_within(&s, Duration::from_secs(5), P)
                    } else {
                        core_endpoint_within(&s, Duration::from_secs(5), P)
                            .map(|_| "core".to_string())
                    };
                    got.map(|v| (v, Instant::now()))
                }))
            })
            .collect();
        std::thread::sleep(Duration::from_millis(100));
        let ready_at = Instant::now();
        *state.0.lock().unwrap() = Some(ManagedCore::for_test(
            "http://127.0.0.1:5555",
            Some("http://127.0.0.1:8766/mcp"),
        ));
        tauri::async_runtime::block_on(async move {
            for (i, w) in waits.into_iter().enumerate() {
                let (v, at) = w.await.unwrap().unwrap();
                let want = if i % 2 == 0 {
                    "http://127.0.0.1:8766/mcp"
                } else {
                    "core"
                };
                assert_eq!(v, want);
                assert!(
                    at.duration_since(ready_at) < Duration::from_millis(200),
                    "준비 후 {:?} 늦게 답했다",
                    at.duration_since(ready_at)
                );
            }
        });
    }

    #[test]
    fn core_wait_cancelled_caller_leaves_state_usable() {
        // 웹뷰가 사라져 invoke 작업이 취소돼도 대기는 상태를 읽기만 한다 — lock이 오염되거나
        // 값이 바뀌지 않고, 다음 호출은 정상으로 답한다.
        let state = Arc::new(CoreState::default());
        let s = state.clone();
        let w = on_runtime(off_runtime(move || {
            mcp_endpoint_within(&s, Duration::from_secs(2), P)
        }));
        std::thread::sleep(Duration::from_millis(30));
        w.abort();
        *state.0.lock().unwrap() = Some(ManagedCore::for_test("http://127.0.0.1:5555", None));
        assert!(!state.0.is_poisoned());
        let s = state.clone();
        let got = tauri::async_runtime::block_on(on_runtime(off_runtime(move || {
            mcp_endpoint_within(&s, T, P)
        })))
        .unwrap();
        assert_eq!(got, Ok(String::new()));
        assert!(state.0.lock().unwrap().is_some());
    }

    // Issue #1 A-1: 셸이 eval하는 복구 스크립트가 예산 가드 진입점을 실제로 호출한다.
    // 동작 자체는 dashboard/tests/desktop.blank-recovery.test.ts가 같은 파일로 검증한다.
    #[test]
    fn recover_script_invokes_guarded_entrypoint() {
        let js = super::RECOVER_IF_BLANK_JS;
        assert!(js.contains("function __ravenBlankRecovery(env)"));
        assert!(js.trim_end().ends_with("__ravenBlankRecovery();"));
        assert!(js.contains("var MAX_RELOADS = 3;"));
        assert!(!js.contains("if (!document.getElementById('root')?.hasChildNodes()) { location.reload(); }"));
    }

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
        assert_eq!(spec.args, vec!["-P", "-s", "-m", "raven.desktop.runtime"]);
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

    #[test]
    fn core_api_defaults_to_loopback_not_all_interfaces() {
        // Issue #14 회귀 가드: 기본 bind가 0.0.0.0이던 시절, 인증 없는 Core API가
        // 사설망 전체에 열려 vault 읽기와 DELETE /api/vaults/{name}?force=true
        // (shutil.rmtree)까지 노출됐다. 기본값은 loopback이어야 한다.
        assert_eq!(super::core::DEFAULT_API_HOST, "127.0.0.1");

        let spec = runtime_launch_spec(
            PathBuf::from("/tmp/python"),
            false,
            None,
            Some(super::core::DEFAULT_API_HOST.to_string()),
            None,
        );
        assert_eq!(
            spec.args,
            vec!["-m", "raven.desktop.runtime", "--host", "127.0.0.1"]
        );
    }

    #[test]
    fn default_capability_allows_backup_dialogs() {
        // 백업 내보내기/가져오기 대화상자. 권한이 빠지면 invoke가 조용히 거부된다
        // (f2a70b0 app_version 권한 누락과 같은 유형).
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let perms: Vec<&str> = caps["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        for p in ["dialog:allow-open", "dialog:allow-save"] {
            assert!(perms.contains(&p), "{p} 권한 누락");
        }
    }

    // Issue #1 A-3: 시작 실패 안내는 osascript(macOS 전용) 대신 tauri_plugin_dialog로 띄운다.
    // osascript 시절에는 따옴표·줄바꿈을 AppleScript용으로 이스케이프했다 — 이제 원문 그대로 전달.
    #[test]
    fn startup_failure_message_keeps_error_text_verbatim() {
        let err = "Python Core 시작 실패 (\"/x/python\"): No such file\nline2";
        assert_eq!(
            super::startup_failure_message(&err),
            format!("Raven failed to start:\n{err}")
        );
    }

    #[test]
    fn startup_failure_has_no_platform_specific_dialog() {
        let src = include_str!("lib.rs");
        let shell_out = concat!("Command::new(\"", "osascript");
        assert!(
            !src.contains(shell_out),
            "시작 실패 안내가 다시 osascript를 호출한다"
        );
        assert!(
            src.contains(".dialog()"),
            "tauri_plugin_dialog 경로가 사라졌다"
        );
    }

    // Issue #40: `RunEvent::Reopen`은 Tauri에서 macOS 전용 variant다. cfg 없이 매칭하면
    // Linux/Windows 빌드가 E0599로 깨진다. macOS CI만으로는 잡히지 않으므로 소스로 지킨다.
    #[test]
    fn reopen_arm_is_macos_only() {
        let src = include_str!("lib.rs");
        let arm = concat!("RunEvent::", "Reopen {");
        let at = src.find(arm).expect("Reopen 처리부가 사라졌다");
        let before = src[..at].trim_end().lines().last().unwrap_or("").trim();
        assert_eq!(before, "#[cfg(target_os = \"macos\")]");
    }

    /// Issue #43: a start still waiting for readiness belongs to `CoreState` too.
    #[cfg(unix)]
    mod pending_start {
        use super::super::{core, CoreState};
        use core::{ManagedCore, StartError};
        use std::process::Command;
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        const READY: &str = r#"{"host":"127.0.0.1","port":41000,"bind_host":"127.0.0.1"}"#;

        fn sh(name: &str, script: &str) -> (Command, std::path::PathBuf) {
            let pidfile = std::env::temp_dir().join(format!("raven43-lib-{}-{name}.pid", std::process::id()));
            let _ = std::fs::remove_file(&pidfile);
            let mut cmd = Command::new("sh");
            cmd.arg("-c").arg(script).env("PIDFILE", &pidfile);
            (cmd, pidfile)
        }

        fn pid(pidfile: &std::path::Path) -> String {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(text) = std::fs::read_to_string(pidfile).ok().filter(|t| !t.trim().is_empty()) {
                    return text.trim().to_string();
                }
                assert!(Instant::now() < deadline, "no pid in {pidfile:?}");
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

        #[test]
        fn stop_kills_a_start_that_is_still_waiting() {
            let state = Arc::new(CoreState::default());
            let (cmd, pidfile) = sh("stop", "echo $$ > \"$PIDFILE\"; exec sleep 30");
            let s2 = Arc::clone(&state);
            let waiter = std::thread::spawn(move || {
                s2.start_with(|p| ManagedCore::launch(cmd, Duration::from_secs(20), p))
            });
            let pid = pid(&pidfile);
            state.stop(); // app exit
            assert!(!alive(&pid), "stop must not leave the pending Core running");
            assert!(matches!(waiter.join().unwrap(), Err(StartError::Cancelled)));
            assert!(state.0.lock().unwrap().is_none());
            assert!(state.1.lock().unwrap().is_none());
        }

        #[test]
        fn a_start_that_finishes_after_stop_does_not_survive() {
            let state = CoreState::default();
            let (cmd, _) = sh("race", &format!("echo '{READY}'; exec sleep 30"));
            let mut started_pid = 0;
            let result = state.start_with(|p| {
                let core = ManagedCore::launch(cmd, Duration::from_secs(10), p)?;
                started_pid = core.pid();
                state.stop(); // lands between readiness and storing the Core
                Ok(core)
            });
            assert!(matches!(result, Err(StartError::Cancelled)));
            assert!(state.0.lock().unwrap().is_none());
            assert!(!alive(&started_pid.to_string()), "the late Core must be stopped");
        }

        #[test]
        fn a_newer_start_is_refused_while_one_is_pending() {
            // Issue #44 policy (it used to cancel the pending one): refuse, and
            // leave the running start alone; app exit still cancels it.
            let state = Arc::new(CoreState::default());
            let (slow, pidfile) = sh("older", "echo $$ > \"$PIDFILE\"; exec sleep 30");
            let s2 = Arc::clone(&state);
            let older = std::thread::spawn(move || {
                s2.start_with(|p| ManagedCore::launch(slow, Duration::from_secs(20), p))
            });
            let older_pid = pid(&pidfile);
            let mut ran = false;
            let newer = state.start_with(|_| {
                ran = true;
                unreachable!()
            });
            assert!(matches!(newer, Err(StartError::Busy)), "{newer:?}");
            assert!(!ran, "a refused start must not spawn anything");
            assert!(exists(&older_pid), "the pending start must keep running");
            state.stop(); // app exit
            assert!(!alive(&older_pid));
            assert!(matches!(older.join().unwrap(), Err(StartError::Cancelled)));
            assert!(state.1.lock().unwrap().is_none());
        }

        #[test]
        fn a_superseded_start_that_then_fails_is_not_reported_as_a_failure() {
            // App exit cancels the start after its child left the cancel slot;
            // the start then fails on its own (here: bad JSON). Reporting that
            // would put up a failure dialog while the app is exiting.
            let state = CoreState::default();
            let (cmd, _) = sh("superseded", "echo not-json; exec sleep 30");
            let result = state.start_with(|p| {
                p.cancel();
                ManagedCore::launch(cmd, Duration::from_secs(10), &core::PendingStart::default())
            });
            assert!(matches!(result, Err(StartError::Cancelled)), "{result:?}");
        }

        #[test]
        fn a_new_start_stops_the_core_already_running() {
            let state = CoreState::default();
            let (first, _) = sh("first", &format!("echo '{READY}'; exec sleep 30"));
            state.start_with(|p| ManagedCore::launch(first, Duration::from_secs(10), p)).unwrap();
            let first_pid = state.0.lock().unwrap().as_ref().unwrap().pid().to_string();
            let (second, _) = sh("second", "exit 1");
            let _ = state.start_with(|p| ManagedCore::launch(second, Duration::from_secs(10), p));
            assert!(!alive(&first_pid), "two Cores must not run side by side");
        }

        #[test]
        fn a_retry_after_failed_starts_is_stored() {
            let state = CoreState::default();
            for (name, script) in [("f1", "exec sleep 30"), ("f2", "exit 2")] {
                let (cmd, _) = sh(name, script);
                let result = state.start_with(|p| ManagedCore::launch(cmd, Duration::from_millis(300), p));
                assert!(matches!(result, Err(StartError::Failed(_))));
                assert!(state.0.lock().unwrap().is_none());
            }
            let (cmd, _) = sh("ok", &format!("echo '{READY}'; exec sleep 30"));
            state.start_with(|p| ManagedCore::launch(cmd, Duration::from_secs(10), p)).unwrap();
            assert_eq!(state.0.lock().unwrap().as_ref().unwrap().endpoint, "http://127.0.0.1:41000");
            assert!(state.1.lock().unwrap().is_none());
            state.stop();
        }
    }

    /// Issue #44: overlapping restarts (dashboard + tray, or during the first start).
    #[cfg(unix)]
    mod restart_policy {
        use super::super::{core, CoreState};
        use core::{ManagedCore, StartError};
        use std::process::Command;
        use std::sync::{Arc, Barrier, Mutex};
        use std::time::{Duration, Instant};

        const READY: &str = r#"{"host":"127.0.0.1","port":41000,"bind_host":"127.0.0.1"}"#;

        fn ready_core() -> Command {
            let mut cmd = Command::new("sh");
            cmd.arg("-c").arg(format!("echo '{READY}'; exec sleep 30"));
            cmd
        }

        fn exists(pid: u32) -> bool {
            Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success()
        }

        fn gone_soon(pid: u32) -> bool {
            let deadline = Instant::now() + Duration::from_secs(2);
            while exists(pid) {
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            true
        }

        #[test]
        fn a_restart_during_another_start_never_runs_a_second_core() {
            // Start A is past readiness (its Core is listening) but not stored yet
            // when restart B arrives — the window where the old policy let B spawn
            // a second Core next to A's.
            let state = Arc::new(CoreState::default());
            let gate = Arc::new(Barrier::new(2));
            let a_pid = Arc::new(Mutex::new(0u32));
            let (s2, g2, p2) = (Arc::clone(&state), Arc::clone(&gate), Arc::clone(&a_pid));
            let a = std::thread::spawn(move || {
                s2.start_with(|p| {
                    let core = ManagedCore::launch(ready_core(), Duration::from_secs(10), p)?;
                    *p2.lock().unwrap() = core.pid();
                    g2.wait(); // A is ready…
                    g2.wait(); // …and stays unstored until B has had its go.
                    Ok(core)
                })
            });
            gate.wait();
            let a_pid = *a_pid.lock().unwrap();
            let mut b_overlapped = false;
            let b = state.start_with(|p| {
                let core = ManagedCore::launch(ready_core(), Duration::from_secs(10), p)?;
                b_overlapped = exists(a_pid);
                Ok(core)
            });
            gate.wait();
            let a = a.join().unwrap();
            assert!(!b_overlapped, "restart B ran a Core while start A's Core was still alive");
            assert!(matches!(b, Err(StartError::Busy)), "{b:?}");
            assert!(a.is_ok(), "{a:?}");
            assert!(exists(a_pid), "A's Core is the one kept");
            state.stop();
            assert!(gone_soon(a_pid));
        }

        #[test]
        fn concurrent_restarts_keep_one_core_and_leak_none() {
            // 10 restarts fired at once and 10 back to back: at no point two
            // live Cores, and at the end exactly one — the stored one.
            let state = Arc::new(CoreState::default());
            let pids = Arc::new(Mutex::new(Vec::<u32>::new()));
            let run = |state: &CoreState, pids: &Mutex<Vec<u32>>| {
                state.start_with(|p| {
                    let core = ManagedCore::launch(ready_core(), Duration::from_secs(10), p)?;
                    let mut seen = pids.lock().unwrap();
                    let live_others = seen.iter().filter(|&&other| exists(other)).count();
                    assert_eq!(live_others, 0, "another Core was alive next to this one");
                    seen.push(core.pid());
                    Ok(core)
                })
            };
            let gate = Arc::new(Barrier::new(10));
            let burst: Vec<_> = (0..10)
                .map(|_| {
                    let (state, pids, gate) = (Arc::clone(&state), Arc::clone(&pids), Arc::clone(&gate));
                    std::thread::spawn(move || {
                        gate.wait();
                        run(&state, &pids)
                    })
                })
                .collect();
            let results: Vec<_> = burst.into_iter().map(|t| t.join().unwrap()).collect();
            assert!(results.iter().any(|r| r.is_ok()));
            assert!(results.iter().all(|r| matches!(r, Ok(_) | Err(StartError::Busy))), "{results:?}");
            for _ in 0..10 {
                run(&state, &pids).unwrap();
            }
            let stored = state.0.lock().unwrap().as_ref().unwrap().pid();
            let seen = pids.lock().unwrap().clone();
            assert!(seen.len() >= 11);
            for pid in &seen {
                if *pid != stored {
                    assert!(gone_soon(*pid), "replaced Core {pid} still running");
                }
            }
            assert!(exists(stored));
            assert!(state.1.lock().unwrap().is_none(), "no start may stay marked as running");
            state.stop();
            assert!(gone_soon(stored));
        }

        #[test]
        fn a_failed_restart_frees_the_slot_for_a_retry() {
            let state = CoreState::default();
            let mut garbage = Command::new("sh");
            garbage.arg("-c").arg("echo not-json; exec sleep 30");
            let failed = state.start_with(|p| ManagedCore::launch(garbage, Duration::from_secs(10), p));
            assert!(matches!(failed, Err(StartError::Failed(_))), "{failed:?}");
            assert!(state.start_with(|p| ManagedCore::launch(ready_core(), Duration::from_secs(10), p)).is_ok());
            state.stop();
        }

        #[test]
        fn exit_during_a_restart_cancels_it_and_frees_the_slot() {
            // stop() cancels the wait; the start itself then frees the slot, so a
            // later start is not refused forever.
            let state = Arc::new(CoreState::default());
            let s2 = Arc::clone(&state);
            let (tx, rx) = std::sync::mpsc::channel();
            let restart = std::thread::spawn(move || {
                s2.start_with(|p| {
                    let mut silent = Command::new("sh");
                    silent.arg("-c").arg("exec sleep 30");
                    let result = ManagedCore::launch(silent, Duration::from_secs(20), p);
                    let _ = tx.send(());
                    result
                })
            });
            std::thread::sleep(Duration::from_millis(200));
            state.stop();
            rx.recv_timeout(Duration::from_secs(2)).expect("cancel must end the wait");
            assert!(matches!(restart.join().unwrap(), Err(StartError::Cancelled)));
            assert!(state.0.lock().unwrap().is_none());
            assert!(state.1.lock().unwrap().is_none());
        }

        #[test]
        fn a_restart_reports_when_the_api_endpoint_moved() {
            let state = CoreState::default();
            let at = |port: u16| {
                let mut cmd = Command::new("sh");
                cmd.arg("-c").arg(format!(
                    r#"echo '{{"host":"127.0.0.1","port":{port},"bind_host":"127.0.0.1"}}'; exec sleep 30"#
                ));
                cmd
            };
            let first = state.start_with(|p| ManagedCore::launch(at(41000), Duration::from_secs(10), p));
            assert!(!first.unwrap(), "the first start has nothing to compare with");
            let same = state.start_with(|p| ManagedCore::launch(at(41000), Duration::from_secs(10), p));
            assert!(!same.unwrap());
            let moved = state.start_with(|p| ManagedCore::launch(at(41001), Duration::from_secs(10), p));
            assert!(moved.unwrap());
            state.stop();
        }

        #[test]
        fn a_move_after_a_failed_restart_is_still_reported() {
            // The failed restart leaves no Core to compare with; the webview
            // still points at the first endpoint (review S1).
            let state = CoreState::default();
            let at = |port: u16| {
                let mut cmd = Command::new("sh");
                cmd.arg("-c").arg(format!(
                    r#"echo '{{"host":"127.0.0.1","port":{port},"bind_host":"127.0.0.1"}}'; exec sleep 30"#
                ));
                cmd
            };
            assert!(!state.start_with(|p| ManagedCore::launch(at(41000), Duration::from_secs(10), p)).unwrap());
            let mut garbage = Command::new("sh");
            garbage.arg("-c").arg("echo not-json; exec sleep 30");
            assert!(state.start_with(|p| ManagedCore::launch(garbage, Duration::from_secs(10), p)).is_err());
            assert!(state.0.lock().unwrap().is_none());
            assert!(state.start_with(|p| ManagedCore::launch(at(41001), Duration::from_secs(10), p)).unwrap());
            state.stop();
        }

        #[test]
        fn a_panicking_start_does_not_leave_restarts_refused() {
            let state = CoreState::default();
            let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = state.start_with(|_| panic!("launch blew up"));
            }));
            assert!(panicked.is_err());
            assert!(state.1.lock().unwrap().is_none(), "the slot must be freed by the unwind");
            assert!(state.start_with(|p| ManagedCore::launch(ready_core(), Duration::from_secs(10), p)).is_ok());
            state.stop();
        }

        #[test]
        fn tray_restart_failures_are_shown_and_exit_is_not() {
            use super::super::tray_restart_notice;
            assert_eq!(tray_restart_notice(&Ok(false)), None);
            assert_eq!(tray_restart_notice(&Ok(true)), None);
            assert_eq!(tray_restart_notice(&Err(StartError::Cancelled)), None);
            let busy = tray_restart_notice(&Err(StartError::Busy)).unwrap();
            assert!(busy.contains("재시작하지 않았습니다") && busy.contains("진행 중"), "{busy}");
            let failed = tray_restart_notice(&Err(StartError::Failed("readiness 형식 오류 (x)".into()))).unwrap();
            assert!(failed.contains("실패") && failed.contains("readiness 형식 오류 (x)"), "{failed}");
        }

        #[test]
        fn tray_restart_runs_off_the_main_thread_and_tells_the_user() {
            let src = include_str!("lib.rs");
            assert!(src.contains(concat!("\"restart\" => ", "restart_from_tray(app),")), "tray arm changed");
            let start = src.find(concat!("fn restart_from_tray", "(")).expect("restart_from_tray");
            let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
            assert!(body.contains("spawn_blocking"), "tray restart runs on the menu (main) thread again");
            assert!(body.contains("tray_restart_notice") && body.contains(".show("), "tray failures are not shown");
            assert!(!body.contains(".blocking_show"), "the notice must not block");
            assert!(body.contains("TRAY_NOTICE_OPEN.swap"), "repeated clicks must not stack dialogs");
            assert!(body.contains("location.reload()"), "a tray restart that moved the API must reload the page");
            let cmd = src.find(concat!("async fn restart_core", "(")).expect("restart_core");
            let cmd_body = &src[cmd..cmd + src[cmd..].find("\n}\n").unwrap()];
            assert!(!cmd_body.contains("reload"), "restart_core must not reload the page under its own IPC call");
        }
    }

    /// Issue #58: what the shell does with a running Core's events.
    mod core_events {
        use super::super::{
            core::{CoreEvent, ManagedCore, StartError},
            handle_core_event, is_running_core, network_restart_notice, CoreState, EventAction,
        };
        use std::time::{Duration, Instant};

        fn running(mcp: Option<&str>) -> (CoreState, u64) {
            let state = CoreState::default();
            let core = ManagedCore::for_test("http://127.0.0.1:5555", mcp);
            let id = core.id;
            *state.0.lock().unwrap() = Some(core);
            (state, id)
        }

        fn mcp_of(state: &CoreState) -> Option<String> {
            state.0.lock().unwrap().as_ref().and_then(|c| c.mcp_endpoint.clone())
        }

        #[test]
        fn a_moved_mcp_endpoint_replaces_the_one_shown() {
            let (state, id) = running(Some("http://127.0.0.1:8766/mcp"));
            let action = handle_core_event(&state, id, CoreEvent::McpEndpoint("http://100.64.1.2:8766/mcp".into()), &mut None);
            assert_eq!(action, EventAction::Nothing);
            assert_eq!(mcp_of(&state).as_deref(), Some("http://100.64.1.2:8766/mcp"));
        }

        #[test]
        fn events_from_a_replaced_or_stopped_core_are_ignored() {
            let (state, id) = running(Some("http://127.0.0.1:8766/mcp"));
            let stale = id + 1_000_000;
            for event in [
                CoreEvent::McpEndpoint("http://100.64.1.2:8766/mcp".into()),
                CoreEvent::GuardBlocked { listener: "MCP".into(), address: "100.64.1.2:8766".into() },
                CoreEvent::Rebind { bound: "100.64.1.2".into(), target: "127.0.0.1".into() },
            ] {
                assert_eq!(handle_core_event(&state, stale, event, &mut None), EventAction::Nothing);
            }
            assert_eq!(mcp_of(&state).as_deref(), Some("http://127.0.0.1:8766/mcp"));
            let empty = CoreState::default();
            let event = CoreEvent::Rebind { bound: "100.64.1.2".into(), target: "127.0.0.1".into() };
            assert_eq!(handle_core_event(&empty, id, event, &mut None), EventAction::Nothing);
        }

        #[test]
        fn a_blocked_guard_is_shown_to_the_user() {
            let (state, id) = running(None);
            let event = CoreEvent::GuardBlocked { listener: "MCP".into(), address: "100.64.1.2:8766".into() };
            match handle_core_event(&state, id, event, &mut None) {
                EventAction::Notify(text) => {
                    assert!(text.contains("100.64.1.2:8766") && text.contains("MCP"), "{text}");
                    assert!(text.contains("보호하지 못했습니다"), "{text}");
                }
                other => panic!("expected a notice, got {other:?}"),
            }
        }

        #[test]
        fn a_rebind_restarts_at_most_once_per_interval_and_a_later_one_waits_for_it() {
            let (state, id) = running(None);
            let rebind = || CoreEvent::Rebind { bound: "100.64.1.2".into(), target: "127.0.0.1".into() };
            let mut last = None;
            assert_eq!(handle_core_event(&state, id, rebind(), &mut last), EventAction::Restart);
            let first = last.unwrap();
            match handle_core_event(&state, id, rebind(), &mut last) {
                EventAction::RestartAt(at) => assert_eq!(at, first + Duration::from_secs(20)),
                other => panic!("expected a deferred restart, got {other:?}"),
            }
            assert_eq!(last, Some(first), "a deferral is not a restart");
            last = Some(Instant::now() - Duration::from_secs(21));
            assert_eq!(handle_core_event(&state, id, rebind(), &mut last), EventAction::Restart);
        }

        #[test]
        fn a_deferred_restart_only_applies_to_the_core_that_asked() {
            let (state, id) = running(None);
            assert!(is_running_core(&state, id));
            assert!(!is_running_core(&state, id + 1_000_000));
            *state.0.lock().unwrap() = None;
            assert!(!is_running_core(&state, id));
        }

        #[test]
        fn only_a_real_failure_of_a_network_restart_is_reported() {
            assert_eq!(network_restart_notice(&Ok(true)), None);
            assert_eq!(network_restart_notice(&Ok(false)), None);
            assert_eq!(network_restart_notice(&Err(StartError::Busy)), None);
            assert_eq!(network_restart_notice(&Err(StartError::Cancelled)), None);
            let text = network_restart_notice(&Err(StartError::Failed("boom".into()))).unwrap();
            assert!(text.contains("boom") && text.contains("Restart Backend"), "{text}");
        }

        #[test]
        fn the_event_loop_restarts_off_the_main_thread_and_reloads_on_a_move() {
            let src = include_str!("lib.rs");
            let start = src.find(concat!("fn spawn_core_event_loop", "(")).expect("spawn_core_event_loop");
            let body = &src[start..start + 3500];
            assert!(body.contains("std::thread::Builder::new()"), "events must be handled on their own thread");
            assert!(body.contains("do_restart_core(&app)") && body.contains("Ok(true)") && body.contains("location.reload()"));
            let setup = src.find("spawn_core_event_loop(&handle)").expect("event loop wired in setup");
            let first_start = src.find("handle.state::<CoreState>().start(").expect("initial start");
            assert!(setup < first_start, "the sink must exist before the first Core starts");
        }
    }
}

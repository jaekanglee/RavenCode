# 데스크톱 Core 헬스체크·자동 복구·원인 로그 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 셸이 10초마다 Core의 API·MCP를 확인한다. 장애가 나면 Core를 재시작하고, 3회 안에 복구되지 않으면 경고 다이얼로그를 띄운다. 관리 화면에는 실제 상태를 보여 주고, 원인은 회전 로그 파일에 남긴다.

**Architecture:** 판정은 I/O가 없는 상태 기계 `health::Monitor`가 맡는다. 감시 스레드(`lib.rs`)는 관측을 넣고 돌려받은 행동만 실행한다. 로그는 `core_log`(std만 쓰는 회전 파일)가 맡고, Core의 stderr 중계와 셸의 수명 주기 지점에서 기록한다. 대시보드는 `core_status`에 더해진 `health`·`log_path`를 `CoreHealthPanel`로 그린다. Python은 바꾸지 않는다.

**Tech Stack:** Rust (Tauri 2, std::net·std::fs), React 19 + vitest.

**Spec:** `docs/superpowers/specs/2026-10-19-desktop-core-health-design.md`

**Commit 정책:** AGENTS.md §6에 따라 작업마다 commit하지 않는다. 모든 작업과 검증을 마친 뒤 사용자 승인을 받아 한 번에 commit하고 push한다.

---

## 파일 구성

| 파일 | 책임 |
|---|---|
| `desktop/src-tauri/src/core_log.rs` (신규) | 회전 로그 `RotatingLog`, UTC 시각, Core 마지막 경고 보관, 전역 기록 함수 |
| `desktop/src-tauri/src/health.rs` (신규) | `/healthz` 탐침, 판정 상태 기계 `Monitor`, 관리 화면용 `Snapshot` |
| `desktop/src-tauri/src/core.rs` | stderr와 이벤트를 로그로 보냄. `ManagedCore::pid`·`exit_status`. 시작·실패·중지를 기록 |
| `desktop/src-tauri/src/lib.rs` | `HealthState`, 감시 스레드, `observe_core`, 행동 실행, 다이얼로그, `core_status` 확장, `reveal_core_log`, setup·종료 연결 |
| `desktop/src-tauri/permissions/default.toml`, `capabilities/default.json` | `allow-reveal-core-log` |
| `dashboard/src/components/ui/StatusDot.tsx` (신규) | 상태 점 |
| `dashboard/src/components/CoreHealthPanel.tsx` (신규) | 백엔드 상태 표시 (표시 전용) |
| `dashboard/src/routes/VaultManage.tsx` | 인라인 상태 블록을 `CoreHealthPanel`로 교체하고 로그 열기 연결 |
| `dashboard/tests/CoreHealthPanel.test.tsx` (신규) | 표시 계약 |

명령은 모두 저장소 루트에서 실행한다. cargo는 `cd desktop/src-tauri && cargo test --lib <filter>`, vitest는 `cd dashboard && npx vitest run <file>`.

---

### Task 1: 회전 로그 `core_log.rs`

**Files:**
- Create: `desktop/src-tauri/src/core_log.rs`
- Modify: `desktop/src-tauri/src/lib.rs:1` (`mod core;` 아래에 `mod core_log;`)

- [ ] **Step 1: 테스트와 빈 껍데기 작성**

`lib.rs` 1행 아래에 추가:
```rust
mod core_log;
```

`desktop/src-tauri/src/core_log.rs`를 아래 테스트 모듈만 담아 만들고, 본문은 Step 3에서 채운다.
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("raven-core-log-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn rotated(path: &Path, index: usize) -> PathBuf {
        let mut name = OsString::from(path.as_os_str());
        name.push(format!(".{index}"));
        PathBuf::from(name)
    }

    #[test]
    fn timestamps_are_utc_iso8601() {
        let at = |s: u64| utc_timestamp(UNIX_EPOCH + Duration::from_secs(s));
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(at(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(at(1_792_385_779), "2026-10-19T04:56:19Z");
    }

    #[test]
    fn writes_tagged_lines_and_creates_the_directory() {
        let dir = temp_dir("write");
        let path = dir.join("nested").join("core.log");
        let mut log = RotatingLog::new(path.clone(), 1024, 3);
        log.write(UNIX_EPOCH, "shell", "core spawn pid=1");
        log.write(UNIX_EPOCH, "core", "⚠️ MCP skipped");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "1970-01-01T00:00:00Z [shell] core spawn pid=1\n1970-01-01T00:00:00Z [core] ⚠️ MCP skipped\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_at_the_limit_and_keeps_three_files() {
        let dir = temp_dir("rotate");
        let path = dir.join("core.log");
        // 한 줄 = 시각 20 + " [t] " 5 + 본문 41 + 개행 1 = 67바이트 → 한도 100이면 줄마다 회전
        let mut log = RotatingLog::new(path.clone(), 100, 3);
        for i in 0..10 {
            log.write(UNIX_EPOCH, "t", &format!("{i}{}", "x".repeat(40)));
        }
        assert!(path.exists() && rotated(&path, 1).exists() && rotated(&path, 2).exists());
        assert!(!rotated(&path, 3).exists(), "core.log 포함 3개만 남는다");
        assert!(fs::read_to_string(&path).unwrap().contains("] 9x"));
        assert!(fs::read_to_string(rotated(&path, 1)).unwrap().contains("] 8x"));
        assert!(fs::read_to_string(rotated(&path, 2)).unwrap().contains("] 7x"));
        for p in [path.clone(), rotated(&path, 1), rotated(&path, 2)] {
            assert!(fs::metadata(&p).unwrap().len() <= 100, "{}", p.display());
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unwritable_path_is_ignored() {
        let dir = temp_dir("unwritable");
        fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("file");
        fs::write(&blocker, "").unwrap();
        // 부모가 파일이라 디렉터리를 만들 수 없다 — 패닉 없이 넘어가야 한다.
        let mut log = RotatingLog::new(blocker.join("core.log"), 1024, 3);
        log.write(UNIX_EPOCH, "t", "no panic");
        log.write(UNIX_EPOCH, "t", "still no panic");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remembers_only_the_latest_warning() {
        let slot = LastWarning::default();
        slot.note("INFO: started");
        assert_eq!(slot.get(), None);
        slot.note("⚠️  [Desktop Core] MCP port 8766 already in use — API only.");
        slot.note("plain line");
        assert_eq!(slot.get().as_deref(), Some("⚠️  [Desktop Core] MCP port 8766 already in use — API only."));
        slot.note(&format!("⚠️ {}", "y".repeat(500)));
        assert_eq!(slot.get().unwrap().chars().count(), 300);
        slot.clear();
        assert_eq!(slot.get(), None);
    }

    #[test]
    fn the_global_log_is_a_no_op_before_init() {
        log("t", "ignored");
        assert!(path().is_none());
    }
}
```

- [ ] **Step 2: 실패 확인**

Run: `cd desktop/src-tauri && cargo test --lib core_log`
Expected: 컴파일 실패 (`RotatingLog`, `utc_timestamp`, `LastWarning` 등 미정의)

- [ ] **Step 3: 구현** — 테스트 모듈 위에 추가

```rust
//! 원인 로그 (spec 2026-10-19-desktop-core-health-design).
//!
//! Core의 stderr, Core 시작·종료, 헬스 상태 변화를 `<app_log_dir>/core.log`에 남긴다.
//! 5MB가 차면 `.1`·`.2`로 넘기고 최대 3개만 둔다. 기록 실패는 조용히 넘어간다 —
//! 로그 때문에 앱이 멈추면 안 된다. 토큰과 손님 이벤트 본문은 여기로 보내지 않는다.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// 파일 하나의 크기 한도.
pub(crate) const MAX_BYTES: u64 = 5 * 1024 * 1024;
/// `core.log`를 포함해 남기는 파일 수.
pub(crate) const KEEP: usize = 3;
/// 다이얼로그에 넣는 경고 줄의 최대 길이(문자).
const WARNING_CHARS: usize = 300;

pub(crate) struct RotatingLog {
    path: PathBuf,
    max_bytes: u64,
    keep: usize,
    file: Option<File>,
    size: u64,
}

impl RotatingLog {
    pub(crate) fn new(path: PathBuf, max_bytes: u64, keep: usize) -> Self {
        Self { path, max_bytes, keep: keep.max(1), file: None, size: 0 }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// `<UTC 시각> [tag] text` 한 줄을 덧붙인다. 실패하면 그 줄은 버린다.
    pub(crate) fn write(&mut self, now: SystemTime, tag: &str, text: &str) {
        let line = format!("{} [{tag}] {text}\n", utc_timestamp(now));
        if self.try_write(line.as_bytes()).is_err() {
            // 다음 줄에서 다시 연다 (디렉터리가 지워졌거나 잠시 쓸 수 없었던 경우).
            self.file = None;
        }
    }

    fn try_write(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        if self.file.is_none() {
            if let Some(dir) = self.path.parent() {
                fs::create_dir_all(dir)?;
            }
            let file = OpenOptions::new().create(true).append(true).open(&self.path)?;
            self.size = file.metadata()?.len();
            self.file = Some(file);
        }
        if self.size > 0 && self.size + bytes.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        let Some(file) = self.file.as_mut() else { return Ok(()) };
        file.write_all(bytes)?;
        self.size += bytes.len() as u64;
        Ok(())
    }

    /// `core.log` → `.1`, `.1` → `.2` …. 가장 오래된 파일은 지운다.
    fn rotate(&mut self) -> std::io::Result<()> {
        self.file = None;
        if self.keep > 1 {
            let _ = fs::remove_file(self.rotated(self.keep - 1));
            for i in (1..self.keep - 1).rev() {
                let _ = fs::rename(self.rotated(i), self.rotated(i + 1));
            }
            fs::rename(&self.path, self.rotated(1))?;
        } else {
            fs::remove_file(&self.path)?;
        }
        self.file = Some(OpenOptions::new().create(true).append(true).open(&self.path)?);
        self.size = 0;
        Ok(())
    }

    fn rotated(&self, index: usize) -> PathBuf {
        let mut name = OsString::from(self.path.as_os_str());
        name.push(format!(".{index}"));
        PathBuf::from(name)
    }
}

/// `2026-10-19T04:56:19Z`. 로컬 시각대는 의존성 없이 구할 수 없어 UTC로 쓴다.
pub(crate) fn utc_timestamp(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant의 civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3_600, rem % 3_600 / 60, rem % 60)
}

/// Core가 stderr로 보낸 가장 최근 경고(`⚠️`) 줄 — 포기 다이얼로그의 원인 단서.
#[derive(Default)]
pub(crate) struct LastWarning(Mutex<Option<String>>);

impl LastWarning {
    pub(crate) fn note(&self, line: &str) {
        if line.contains('⚠') {
            let kept: String = line.trim().chars().take(WARNING_CHARS).collect();
            *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(kept);
        }
    }

    pub(crate) fn clear(&self) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    pub(crate) fn get(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
}

static LOG: OnceLock<Mutex<RotatingLog>> = OnceLock::new();
static LAST_WARNING: OnceLock<LastWarning> = OnceLock::new();

fn last() -> &'static LastWarning {
    LAST_WARNING.get_or_init(LastWarning::default)
}

/// setup에서 한 번 부른다. 이후 호출은 무시된다.
pub(crate) fn init(path: PathBuf) {
    let _ = LOG.set(Mutex::new(RotatingLog::new(path, MAX_BYTES, KEEP)));
}

/// 로그 파일 위치 (`init` 전에는 `None`).
pub(crate) fn path() -> Option<PathBuf> {
    LOG.get().map(|log| log.lock().unwrap_or_else(PoisonError::into_inner).path().to_path_buf())
}

/// 한 줄 기록. `init` 전(테스트 등)에는 아무것도 하지 않는다.
pub(crate) fn log(tag: &str, text: &str) {
    if let Some(log) = LOG.get() {
        log.lock().unwrap_or_else(PoisonError::into_inner).write(SystemTime::now(), tag, text);
    }
}

/// Core stderr 한 줄: 기록하고, 경고면 기억한다.
pub(crate) fn core_stderr(line: &str) {
    log("core", line);
    last().note(line);
}

/// 새 Core가 뜬다 — 이전 Core의 경고는 잊는다.
pub(crate) fn core_starting() {
    last().clear();
}

pub(crate) fn last_warning() -> Option<String> {
    last().get()
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd desktop/src-tauri && cargo test --lib core_log`
Expected: 6 passed. `core_stderr`·`core_starting`·`last_warning`·`init` 미사용 경고는 Task 4·5에서 사라진다.

---

### Task 2: `/healthz` 탐침 (`health.rs` 앞부분)

**Files:**
- Create: `desktop/src-tauri/src/health.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (`mod core_log;` 아래에 `mod health;`)

- [ ] **Step 1: 테스트 작성** — `lib.rs`에 `mod health;`를 추가하고, `health.rs`에는 우선 테스트 모듈만 둔다.

```rust
#[cfg(test)]
mod probe_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// 연결을 한 번 받아 `reply`를 보내는 테스트 서버. `None`이면 읽기만 하고 답하지 않는다.
    fn serve_once(reply: Option<&'static str>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                // 요청을 끝까지 읽고 답한다 — 읽지 않은 데이터를 남긴 채 닫으면 RST가 나가
                // 클라이언트가 응답을 못 읽는다 (uvicorn도 요청을 다 읽고 답한다).
                let mut request = Vec::new();
                let mut buf = [0u8; 512];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                match reply {
                    Some(text) => {
                        let _ = stream.write_all(text.as_bytes());
                    }
                    None => thread::sleep(Duration::from_secs(2)),
                }
            }
        });
        format!("http://{addr}/mcp")
    }

    #[test]
    fn healthz_200_is_ok() {
        let endpoint = serve_once(Some("HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n{\"ok\":true}"));
        assert_eq!(probe_healthz(&endpoint, Duration::from_secs(2)), Probe::Ok);
    }

    #[test]
    fn another_status_is_a_failure() {
        let endpoint = serve_once(Some("HTTP/1.1 500 Internal Server Error\r\n\r\n"));
        assert_eq!(probe_healthz(&endpoint, Duration::from_secs(2)), Probe::Fail("HTTP 500".into()));
    }

    #[test]
    fn silence_is_a_timeout() {
        let endpoint = serve_once(None);
        assert_eq!(
            probe_healthz(&endpoint, Duration::from_millis(300)),
            Probe::Fail("0.3초 안에 응답 없음".into())
        );
    }

    #[test]
    fn a_closed_port_is_refused() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        assert_eq!(probe_healthz(&format!("http://{addr}"), Duration::from_secs(1)), Probe::Fail("연결 거부".into()));
    }

    #[test]
    fn endpoints_parse_to_socket_addresses() {
        assert_eq!(endpoint_addr("http://127.0.0.1:8766/mcp"), Some("127.0.0.1:8766".parse().unwrap()));
        assert_eq!(endpoint_addr("http://127.0.0.1:8765"), Some("127.0.0.1:8765".parse().unwrap()));
        assert_eq!(endpoint_addr("http://[::1]:8765"), Some("[::1]:8765".parse().unwrap()));
        assert_eq!(endpoint_addr("https://example.com"), None);
        assert_eq!(endpoint_addr("http://localhost:8765"), None);
    }
}
```

- [ ] **Step 2: 실패 확인**

Run: `cd desktop/src-tauri && cargo test --lib probe_tests`
Expected: 컴파일 실패 (`probe_healthz`, `Probe`, `endpoint_addr` 미정의)

- [ ] **Step 3: 구현** — 테스트 모듈 위에 추가

```rust
//! Core 헬스체크 (spec 2026-10-19-desktop-core-health-design).
//!
//! `probe_healthz`는 루프백 `GET /healthz` 탐침이다. `Monitor`는 I/O 없는 판정 상태
//! 기계다. 감시 스레드(lib.rs `spawn_health_monitor`)가 10초마다 관측을 넣고, 돌려받은
//! 행동(재시작, 포기, 복구됨)을 실행한다.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// 탐침 주기.
pub(crate) const PROBE_INTERVAL: Duration = Duration::from_secs(10);
/// 탐침 하나의 타임아웃 (연결, 쓰기, 읽기 각각).
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Probe {
    Ok,
    Fail(String),
}

/// `http://host:port[/path]`의 소켓 주소. Core는 IP로만 보고하므로 이름 해석은 하지 않는다.
pub(crate) fn endpoint_addr(endpoint: &str) -> Option<SocketAddr> {
    endpoint.strip_prefix("http://")?.split('/').next()?.parse().ok()
}

/// `GET /healthz`가 `timeout` 안에 200으로 답하면 `Ok`. 두 `/healthz` 모두 토큰이 필요 없다.
pub(crate) fn probe_healthz(endpoint: &str, timeout: Duration) -> Probe {
    let Some(addr) = endpoint_addr(endpoint) else {
        return Probe::Fail(format!("주소를 해석할 수 없음 ({endpoint})"));
    };
    match healthz_status(addr, timeout) {
        Ok(200) => Probe::Ok,
        Ok(code) => Probe::Fail(format!("HTTP {code}")),
        Err(why) => Probe::Fail(why),
    }
}

fn healthz_status(addr: SocketAddr, timeout: Duration) -> Result<u16, String> {
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| describe(&e, timeout))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    write!(stream, "GET /healthz HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n")
        .map_err(|e| describe(&e, timeout))?;
    // 상태 줄("HTTP/1.1 200 OK")만 읽는다.
    let mut head = Vec::with_capacity(64);
    let mut chunk = [0u8; 64];
    while !head.contains(&b'\n') && head.len() < 256 {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => head.extend_from_slice(&chunk[..n]),
            Err(e) => return Err(describe(&e, timeout)),
        }
    }
    let line = String::from_utf8_lossy(&head);
    let mut parts = line.split_whitespace();
    match (parts.next(), parts.next().and_then(|code| code.parse().ok())) {
        (Some(version), Some(code)) if version.starts_with("HTTP/") => Ok(code),
        _ => Err("HTTP 응답이 아님".into()),
    }
}

fn describe(error: &std::io::Error, timeout: Duration) -> String {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::ConnectionRefused => "연결 거부".into(),
        ErrorKind::TimedOut | ErrorKind::WouldBlock => format!("{}초 안에 응답 없음", timeout.as_secs_f32()),
        _ => error.to_string(),
    }
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd desktop/src-tauri && cargo test --lib probe_tests`
Expected: 5 passed

---

### Task 3: 판정 상태 기계 `Monitor`

**Files:**
- Modify: `desktop/src-tauri/src/health.rs`

- [ ] **Step 1: 테스트 작성** — `health.rs` 끝에 추가

```rust
#[cfg(test)]
mod monitor_tests {
    use super::*;
    use std::time::Instant;

    fn at(t0: Instant, secs: u64) -> Instant {
        t0 + Duration::from_secs(secs)
    }
    fn running(id: u64, api: Probe, mcp: McpSeen) -> Observation {
        Observation { core_id: Some(id), seen: Seen::Running { api, mcp } }
    }
    fn ok(id: u64) -> Observation {
        running(id, Probe::Ok, McpSeen::Probe(Probe::Ok))
    }
    fn mcp_fail(id: u64) -> Observation {
        running(id, Probe::Ok, McpSeen::Probe(Probe::Fail("연결 거부".into())))
    }
    fn api_fail(id: u64) -> Observation {
        running(id, Probe::Fail("3초 안에 응답 없음".into()), McpSeen::Probe(Probe::Ok))
    }
    fn gone(id: Option<u64>) -> Observation {
        Observation { core_id: id, seen: Seen::Gone("signal: 9 (SIGKILL)".into()) }
    }
    /// t0에 Core 1을 처음 보고(유예 t0+15까지) 정상인 모니터.
    fn settled(t0: Instant) -> Monitor {
        let mut m = Monitor::default();
        assert_eq!(m.observe(t0, 0, ok(1)), Action::None);
        m
    }
    fn restart(attempt: u32, reason: &str) -> Action {
        Action::Restart { attempt, reason: reason.into() }
    }

    #[test]
    fn two_failed_probes_in_a_row_restart_the_core() {
        let t0 = Instant::now();
        let mut m = settled(t0);
        assert_eq!(m.observe(at(t0, 20), 20, mcp_fail(1)), Action::None);
        assert_eq!(m.snapshot().mcp, "ok", "한 번 실패로는 장애가 아니다");
        assert_eq!(m.observe(at(t0, 30), 30, mcp_fail(1)), restart(1, "MCP 응답 없음: 연결 거부"));
        let s = m.snapshot();
        assert_eq!((s.mcp, s.phase, s.restarts), ("down", "recovering", 1));
        assert_eq!(s.last_error.as_deref(), Some("MCP 응답 없음: 연결 거부"));
        assert_eq!(s.last_error_at_ms, Some(30));
    }

    #[test]
    fn a_single_failure_is_forgiven() {
        let t0 = Instant::now();
        let mut m = settled(t0);
        assert_eq!(m.observe(at(t0, 20), 20, api_fail(1)), Action::None);
        assert_eq!(m.observe(at(t0, 30), 30, ok(1)), Action::None);
        assert_eq!(m.observe(at(t0, 40), 40, api_fail(1)), Action::None);
        assert_eq!(m.snapshot().phase, "healthy");
    }

    #[test]
    fn an_exited_core_restarts_at_once() {
        let t0 = Instant::now();
        let mut m = settled(t0);
        assert_eq!(m.observe(at(t0, 20), 20, gone(Some(1))), restart(1, "Core 프로세스 없음 (signal: 9 (SIGKILL))"));
        assert_eq!((m.snapshot().api, m.snapshot().mcp), ("down", "down"));
    }

    #[test]
    fn missing_mcp_restarts_at_once_even_in_grace() {
        let t0 = Instant::now();
        let mut m = Monitor::default();
        let missing = running(1, Probe::Ok, McpSeen::Missing);
        assert_eq!(m.observe(t0, 0, missing), restart(1, "MCP가 시작되지 않음 (API만 실행 중)"));
        assert_eq!(m.snapshot().mcp, "missing");
    }

    #[test]
    fn failures_during_the_grace_period_are_ignored() {
        let t0 = Instant::now();
        let mut m = settled(t0);
        assert_eq!(m.observe(at(t0, 5), 5, mcp_fail(1)), Action::None);
        assert_eq!(m.observe(at(t0, 10), 10, mcp_fail(1)), Action::None);
        assert_eq!(m.observe(at(t0, 20), 20, mcp_fail(1)), Action::None, "유예가 끝난 뒤 첫 실패");
        assert_eq!(m.observe(at(t0, 30), 30, mcp_fail(1)), restart(1, "MCP 응답 없음: 연결 거부"));
    }

    #[test]
    fn restarts_wait_30s_then_60s_and_give_up_after_three() {
        let t0 = Instant::now();
        let mut m = settled(t0);
        m.observe(at(t0, 20), 20, mcp_fail(1));
        assert!(matches!(m.observe(at(t0, 30), 30, mcp_fail(1)), Action::Restart { attempt: 1, .. }));
        // 재시작 결과 Core 2 (유예 t40~t55)
        assert_eq!(m.observe(at(t0, 40), 40, mcp_fail(2)), Action::None);
        m.observe(at(t0, 60), 60, mcp_fail(2));
        assert!(matches!(m.observe(at(t0, 70), 70, mcp_fail(2)), Action::Restart { attempt: 2, .. }), "#1로부터 40초 ≥ 30초");
        // Core 3 (유예 t80~t95)
        m.observe(at(t0, 80), 80, mcp_fail(3));
        m.observe(at(t0, 100), 100, mcp_fail(3));
        assert_eq!(m.observe(at(t0, 110), 110, mcp_fail(3)), Action::None, "#2로부터 40초 < 60초");
        assert_eq!(m.observe(at(t0, 120), 120, mcp_fail(3)), Action::None, "50초 < 60초");
        assert!(matches!(m.observe(at(t0, 130), 130, mcp_fail(3)), Action::Restart { attempt: 3, .. }));
        // Core 4 (유예 t140~t155)
        m.observe(at(t0, 140), 140, mcp_fail(4));
        m.observe(at(t0, 160), 160, mcp_fail(4));
        assert_eq!(
            m.observe(at(t0, 170), 170, mcp_fail(4)),
            Action::GiveUp { reason: "MCP 응답 없음: 연결 거부".into() }
        );
        assert_eq!(m.snapshot().phase, "gave_up");
        assert_eq!(m.observe(at(t0, 180), 180, mcp_fail(4)), Action::None, "다이얼로그는 한 번만");
        assert_eq!(m.observe(at(t0, 190), 190, ok(4)), Action::Recovered);
        assert_eq!(m.snapshot().phase, "healthy");
    }

    #[test]
    fn recovery_is_reported_once_and_the_incident_ends_after_ten_quiet_minutes() {
        let t0 = Instant::now();
        let mut m = settled(t0);
        m.observe(at(t0, 20), 20, mcp_fail(1));
        m.observe(at(t0, 30), 30, mcp_fail(1));
        assert_eq!(m.observe(at(t0, 40), 40, ok(2)), Action::Recovered, "유예 중이라도 정상 응답이면 복구");
        assert_eq!(m.observe(at(t0, 50), 50, ok(2)), Action::None);
        assert_eq!((m.snapshot().phase, m.snapshot().restarts), ("healthy", 1));
        assert_eq!(m.observe(at(t0, 629), 629, ok(2)), Action::None);
        assert_eq!(m.snapshot().restarts, 1, "마지막 장애(t30)로부터 10분 전");
        m.observe(at(t0, 630), 630, ok(2));
        assert_eq!(m.snapshot().restarts, 0, "10분 정상 → 장애 종료");
        m.observe(at(t0, 640), 640, mcp_fail(2));
        assert!(matches!(m.observe(at(t0, 650), 650, mcp_fail(2)), Action::Restart { attempt: 1, .. }));
    }

    #[test]
    fn a_core_started_by_hand_resets_the_count() {
        let t0 = Instant::now();
        let mut m = settled(t0);
        m.observe(at(t0, 20), 20, mcp_fail(1));
        m.observe(at(t0, 30), 30, mcp_fail(1)); // 자동 재시작 #1 요청
        m.observe(at(t0, 40), 40, ok(2)); // 그 결과 (횟수 유지)
        assert_eq!(m.snapshot().restarts, 1);
        m.observe(at(t0, 100), 100, ok(3)); // 사람이 재시작한 Core
        assert_eq!(m.snapshot().restarts, 0);
    }

    #[test]
    fn a_failed_restart_is_retried_after_the_gap() {
        let t0 = Instant::now();
        let mut m = settled(t0);
        assert!(matches!(m.observe(at(t0, 20), 20, gone(Some(1))), Action::Restart { attempt: 1, .. }));
        // 재시작이 실패해 저장된 Core가 없다
        assert_eq!(m.observe(at(t0, 30), 30, gone(None)), Action::None, "10초 < 30초");
        assert!(matches!(m.observe(at(t0, 50), 50, gone(None)), Action::Restart { attempt: 2, .. }));
    }

    #[test]
    fn mcp_turned_off_is_not_watched() {
        let t0 = Instant::now();
        let mut m = Monitor::default();
        for s in [0, 20, 30, 40] {
            assert_eq!(m.observe(at(t0, s), s, running(1, Probe::Ok, McpSeen::Off)), Action::None);
        }
        let snapshot = m.snapshot();
        assert_eq!((snapshot.api, snapshot.mcp, snapshot.checked_at_ms), ("ok", "off", Some(40)));
    }
}
```

- [ ] **Step 2: 실패 확인**

Run: `cd desktop/src-tauri && cargo test --lib monitor_tests`
Expected: 컴파일 실패 (`Monitor`, `Observation`, `Seen`, `McpSeen`, `Action` 미정의)

- [ ] **Step 3: 구현** — `health.rs`의 탐침 코드 아래, 테스트 모듈 위에 추가. 파일 위쪽 `use`에 `use serde::Serialize;`와 `use std::time::Instant;`를 더한다.

```rust
/// 탐침 실패를 장애로 보기까지의 연속 횟수.
const FAILS_TO_DOWN: u32 = 2;
/// 새 Core를 처음 본 뒤 판정을 쉬는 시간.
pub(crate) const READY_GRACE: Duration = Duration::from_secs(15);
/// 장애 한 건의 자동 재시작 한도.
pub(crate) const MAX_RESTARTS: u32 = 3;
/// 재시작 #2, #3 전에 이전 재시작으로부터 기다리는 시간.
const RESTART_GAPS: [Duration; 2] = [Duration::from_secs(30), Duration::from_secs(60)];
/// 마지막 장애로부터 이만큼 정상이면 장애 한 건이 끝난다.
const INCIDENT_QUIET: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum McpSeen {
    /// `RAVEN_DESKTOP_MCP=0` — 감시하지 않는다.
    Off,
    /// MCP가 켜져 있는데 Core가 MCP 없이 준비됐다 (포트 충돌, 시작 타임아웃).
    Missing,
    Probe(Probe),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Seen {
    /// Core 프로세스가 없다 — 종료됐거나 마지막 시작이 실패했다.
    Gone(String),
    Running { api: Probe, mcp: McpSeen },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Observation {
    /// 지금 저장된 Core의 id. 저장된 Core가 없으면 `None`.
    pub core_id: Option<u64>,
    pub seen: Seen,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Action {
    None,
    /// Core를 재시작한다 (#44 경로).
    Restart { attempt: u32, reason: String },
    /// 이번 장애의 자동 복구를 포기한다 — 다이얼로그를 한 번 띄운다.
    GiveUp { reason: String },
    /// 장애였던 Core가 다시 정상으로 답한다.
    Recovered,
}

/// 관리 화면용 상태 (`core_status.health`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Snapshot {
    /// ok | down | unknown
    pub api: &'static str,
    /// ok | down | missing | off | unknown
    pub mcp: &'static str,
    /// healthy | recovering | gave_up
    pub phase: &'static str,
    pub restarts: u32,
    pub max_restarts: u32,
    pub checked_at_ms: Option<u64>,
    pub last_error: Option<String>,
    pub last_error_at_ms: Option<u64>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            api: "unknown",
            mcp: "unknown",
            phase: "healthy",
            restarts: 0,
            max_restarts: MAX_RESTARTS,
            checked_at_ms: None,
            last_error: None,
            last_error_at_ms: None,
        }
    }
}

struct Incident {
    restarts: u32,
    last_restart: Option<Instant>,
    /// 마지막으로 장애를 본 시각 — 여기서 `INCIDENT_QUIET`이 지나야 끝난다.
    last_bad: Instant,
    down: bool,
    gave_up: bool,
}

struct Verdict {
    down: Option<String>,
    /// 이번 탐침이 모두 정상이었다 (복구 판정용).
    clean: bool,
}

#[derive(Default)]
pub(crate) struct Monitor {
    core_id: Option<u64>,
    grace_until: Option<Instant>,
    api_fails: u32,
    mcp_fails: u32,
    /// 방금 자동 재시작을 요청했다 — 다음에 보이는 새 Core는 그 결과다.
    restart_requested: bool,
    incident: Option<Incident>,
    snapshot: Snapshot,
}

impl Monitor {
    pub(crate) fn snapshot(&self) -> Snapshot {
        self.snapshot.clone()
    }

    /// 관측 하나를 반영하고 할 일을 돌려준다. `wall_ms`는 화면 표시용 시각(epoch ms).
    pub(crate) fn observe(&mut self, now: Instant, wall_ms: u64, observation: Observation) -> Action {
        if observation.core_id.is_some() && observation.core_id != self.core_id {
            self.new_core(now, observation.core_id);
        }
        self.snapshot.checked_at_ms = Some(wall_ms);
        let verdict = match observation.seen {
            Seen::Gone(how) => {
                self.snapshot.api = "down";
                if self.snapshot.mcp != "off" {
                    self.snapshot.mcp = "down";
                }
                Verdict { down: Some(format!("Core 프로세스 없음 ({how})")), clean: false }
            }
            Seen::Running { api, mcp } => {
                let counting = !self.grace_until.is_some_and(|until| now < until);
                self.judge(api, mcp, counting)
            }
        };
        let action = match verdict.down {
            Some(reason) => self.on_down(now, wall_ms, reason),
            None => self.on_fine(now, verdict.clean),
        };
        self.snapshot.phase = match &self.incident {
            Some(incident) if incident.down && incident.gave_up => "gave_up",
            Some(incident) if incident.down => "recovering",
            _ => "healthy",
        };
        self.snapshot.restarts = self.incident.as_ref().map_or(0, |incident| incident.restarts);
        action
    }

    fn new_core(&mut self, now: Instant, id: Option<u64>) {
        self.core_id = id;
        self.grace_until = Some(now + READY_GRACE);
        self.api_fails = 0;
        self.mcp_fails = 0;
        self.snapshot.api = "unknown";
        if self.snapshot.mcp != "off" {
            self.snapshot.mcp = "unknown";
        }
        if !std::mem::take(&mut self.restart_requested) {
            // 사람(트레이·관리 화면·내부망 스위치)이나 네트워크 재시작이 띄운 Core — 처음부터 다시 센다.
            self.incident = None;
        }
    }

    fn judge(&mut self, api: Probe, mcp: McpSeen, counting: bool) -> Verdict {
        let clean = api == Probe::Ok && matches!(mcp, McpSeen::Off | McpSeen::Probe(Probe::Ok));
        let mut down = None;
        match api {
            Probe::Ok => {
                self.api_fails = 0;
                self.snapshot.api = "ok";
            }
            Probe::Fail(why) if counting => {
                self.api_fails += 1;
                if self.api_fails >= FAILS_TO_DOWN {
                    self.snapshot.api = "down";
                    down = Some(format!("API 응답 없음: {why}"));
                }
            }
            Probe::Fail(_) => {}
        }
        match mcp {
            McpSeen::Off => self.snapshot.mcp = "off",
            McpSeen::Missing => {
                self.snapshot.mcp = "missing";
                down = down.or(Some("MCP가 시작되지 않음 (API만 실행 중)".into()));
            }
            McpSeen::Probe(Probe::Ok) => {
                self.mcp_fails = 0;
                self.snapshot.mcp = "ok";
            }
            McpSeen::Probe(Probe::Fail(why)) if counting => {
                self.mcp_fails += 1;
                if self.mcp_fails >= FAILS_TO_DOWN {
                    self.snapshot.mcp = "down";
                    down = down.or(Some(format!("MCP 응답 없음: {why}")));
                }
            }
            McpSeen::Probe(Probe::Fail(_)) => {}
        }
        Verdict { down, clean }
    }

    fn on_down(&mut self, now: Instant, wall_ms: u64, reason: String) -> Action {
        self.snapshot.last_error = Some(reason.clone());
        self.snapshot.last_error_at_ms = Some(wall_ms);
        let incident = self.incident.get_or_insert(Incident {
            restarts: 0,
            last_restart: None,
            last_bad: now,
            down: true,
            gave_up: false,
        });
        incident.last_bad = now;
        incident.down = true;
        if incident.gave_up {
            return Action::None;
        }
        if incident.restarts >= MAX_RESTARTS {
            incident.gave_up = true;
            return Action::GiveUp { reason };
        }
        if let Some(last) = incident.last_restart {
            let gap = RESTART_GAPS[(incident.restarts as usize - 1).min(RESTART_GAPS.len() - 1)];
            if now.duration_since(last) < gap {
                return Action::None;
            }
        }
        incident.restarts += 1;
        incident.last_restart = Some(now);
        let attempt = incident.restarts;
        self.restart_requested = true;
        self.api_fails = 0;
        self.mcp_fails = 0;
        Action::Restart { attempt, reason }
    }

    fn on_fine(&mut self, now: Instant, clean: bool) -> Action {
        let Some(incident) = self.incident.as_mut() else { return Action::None };
        if incident.down && clean {
            incident.down = false;
            return Action::Recovered;
        }
        if !incident.down && now.duration_since(incident.last_bad) >= INCIDENT_QUIET {
            self.incident = None;
        }
        Action::None
    }
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd desktop/src-tauri && cargo test --lib health`
Expected: probe_tests 5개와 monitor_tests 10개, 모두 15 passed

---

### Task 4: Core 수명 주기와 출력을 로그로 (`core.rs`)

**Files:**
- Modify: `desktop/src-tauri/src/core.rs` (`CoreEvent`, `relay_events`, `relay_lines`, `StderrTail::spawn`, `abort`, `launch_inner`, `ManagedCore`)
- Modify: `desktop/src-tauri/src/lib.rs` (`start_with`의 준비 완료 지점)

- [ ] **Step 1: 테스트 작성** — `core.rs`의 기존 `#[cfg(test)] mod tests` 안에 추가

```rust
    #[test]
    fn event_summaries_leave_guest_details_out() {
        let guest = CoreEvent::GuestRequest { name: "홍길동".into(), ip: "10.0.0.7".into(), code: "4821".into() };
        assert_eq!(guest.summary(), "guest_request");
        assert_eq!(
            CoreEvent::McpEndpoint("http://127.0.0.1:8766/mcp".into()).summary(),
            "mcp_endpoint http://127.0.0.1:8766/mcp"
        );
        assert_eq!(
            CoreEvent::Rebind { bound: "100.64.0.1".into(), target: "100.64.0.2".into() }.summary(),
            "rebind bound=100.64.0.1 target=100.64.0.2"
        );
        assert_eq!(
            CoreEvent::GuardBlocked { listener: "MCP".into(), address: "100.64.0.1".into() }.summary(),
            "guard_blocked listener=MCP address=100.64.0.1"
        );
    }

    #[test]
    fn exit_status_describes_how_the_core_ended() {
        let mut alive = ManagedCore::for_test_alive("http://127.0.0.1:1", None);
        assert_eq!(alive.exit_status(), None);
        let mut done = ManagedCore::for_test("http://127.0.0.1:1", None);
        let deadline = Instant::now() + Duration::from_secs(2);
        let status = loop {
            if let Some(status) = done.exit_status() {
                break status;
            }
            assert!(Instant::now() < deadline, "true가 끝나지 않았다");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(status, "exit status: 0");
        assert!(alive.pid() > 0);
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cd desktop/src-tauri && cargo test --lib event_summaries exit_status_describes`
Expected: 컴파일 실패 (`summary`, `for_test_alive`, `exit_status` 미정의, `pid`가 test 전용 아님은 통과)

- [ ] **Step 3: 구현**

(a) `CoreEvent` 정의(`pub(crate) enum CoreEvent { … }`) 바로 아래에 추가:
```rust
impl CoreEvent {
    /// 로그용 한 줄. 손님 요청은 종류만 남긴다 (이름·IP·코드는 로그에 넣지 않는다).
    pub(crate) fn summary(&self) -> String {
        match self {
            Self::McpEndpoint(endpoint) => format!("mcp_endpoint {endpoint}"),
            Self::GuardBlocked { listener, address } => format!("guard_blocked listener={listener} address={address}"),
            Self::Rebind { bound, target } => format!("rebind bound={bound} target={target}"),
            Self::GuestRequest { .. } => "guest_request".into(),
        }
    }
}
```

(b) `relay_events`의 이벤트 전달부를 바꾼다:
```rust
                eprintln!("[raven-core] {text}");
                if let Some(event) = parse_event(text) {
                    crate::core_log::log("core:event", &event.summary());
                    if let Some(sink) = events.as_ref() {
                        let _ = sink.send((id, event));
                    }
                }
```
(기존: `if let (Some(sink), Some(event)) = (events.as_ref(), parse_event(text)) { let _ = sink.send((id, event)); }`)

(c) `relay_lines`에 줄 콜백을 더한다:
```rust
fn relay_lines<R: BufRead>(tag: &str, reader: &mut R, tail: Option<&Mutex<Option<String>>>, on_line: fn(&str)) {
```
본문의 `eprintln!("[raven-{tag}] {text}");` 바로 아래에 `on_line(text);`를 넣는다. 그리고 `StderrTail::spawn`의 호출을 바꾼다:
```rust
                    relay_lines("core:stderr", &mut BufReader::new(stream), Some(&sink), crate::core_log::core_stderr);
```

(d) `abort` 첫 줄에 실패 기록을 넣는다:
```rust
fn abort(mut child: Child, stderr: &StderrTail, what: String) -> StartError {
    crate::core_log::log("shell", &format!("core start failed: {what}"));
    let _ = child.kill();
```

(e) `launch_inner`에서 `let mut child = cmd.spawn()…?;` 바로 아래에 넣는다:
```rust
        crate::core_log::core_starting();
        crate::core_log::log("shell", &format!("core spawn pid={}", child.id()));
```

(f) `ManagedCore`: `pid()`에서 `#[cfg(test)]`를 지우고, `stop`과 새 메서드·테스트 헬퍼를 넣는다:
```rust
    pub(crate) fn pid(&self) -> u32 {
        self.child.id()
    }

    /// 프로세스가 끝났으면 어떻게 끝났는지 (`exit status: 1`, `signal: 9 (SIGKILL)`), 살아 있으면 `None`.
    pub(crate) fn exit_status(&mut self) -> Option<String> {
        self.child.try_wait().ok().flatten().map(|status| status.to_string())
    }

    pub(crate) fn stop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let status = self.child.wait().map_or_else(|e| e.to_string(), |s| s.to_string());
            crate::core_log::log("shell", &format!("core stop pid={} ({status})", self.child.id()));
        }
    }

    /// Test double: a Core whose child keeps running (`sleep 30`, killed on drop).
    #[cfg(test)]
    pub(crate) fn for_test_alive(endpoint: &str, mcp_endpoint: Option<&str>) -> Self {
        Self {
            child: Command::new("sleep").arg("30").spawn().expect("spawn sleep"),
            id: NEXT_CORE_ID.fetch_add(1, Ordering::Relaxed),
            endpoint: endpoint.to_string(),
            mcp_endpoint: mcp_endpoint.map(str::to_string),
            session: None,
        }
    }
```

(g) `lib.rs` `start_with`의 `eprintln!("Raven Python Core ready at {}", core.endpoint);` 바로 위에 넣는다:
```rust
            core_log::log(
                "shell",
                &format!(
                    "core ready pid={} api={} mcp={}",
                    core.pid(),
                    core.endpoint,
                    core.mcp_endpoint.as_deref().unwrap_or("없음")
                ),
            );
```

- [ ] **Step 4: 통과와 회귀 확인**

Run: `cd desktop/src-tauri && cargo test --lib`
Expected: 새 테스트 2개를 포함해 전부 통과 (기존 110여 개 + Task 1~3)

---

### Task 5: 감시 스레드, 다이얼로그, `core_status`, `reveal_core_log` (`lib.rs`)

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src-tauri/permissions/default.toml`, `desktop/src-tauri/capabilities/default.json`

- [ ] **Step 1: 테스트 작성** — `lib.rs`의 `mod tests` 안에 추가

```rust
    #[test]
    fn health_notice_names_the_symptom_the_warning_and_the_log() {
        let text = super::health_notice(
            "MCP 응답 없음: 연결 거부",
            Some("⚠️  [Desktop Core] MCP port 8766 already in use — API only."),
            Some(std::path::Path::new("/tmp/core.log")),
        );
        assert!(text.contains("• 증상: MCP 응답 없음: 연결 거부"));
        assert!(text.contains("자동 재시작 3회"));
        assert!(text.contains("MCP port 8766 already in use"));
        assert!(text.contains("로그: /tmp/core.log"));
        let bare = super::health_notice("API 응답 없음", None, None);
        assert!(!bare.contains("마지막 경고") && !bare.contains("로그:"));
    }

    #[test]
    fn reveal_core_log_is_registered_allowed_and_takes_nothing_from_the_webview() {
        let caps: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let perms: Vec<&str> = caps["permissions"].as_array().unwrap().iter().filter_map(|p| p.as_str()).collect();
        assert!(perms.contains(&"allow-reveal-core-log"));
        let toml = include_str!("../permissions/default.toml");
        assert!(toml.contains(r#"commands.allow = ["reveal_core_log"]"#));
        let src = include_str!("lib.rs");
        assert!(src.contains(concat!("core_status,\n            reveal_core_log,")));
        assert!(src.contains(concat!("fn reveal_core_log", "() -> Result<(), String>")));
    }

    #[test]
    fn health_monitor_starts_in_setup_and_stops_on_exit() {
        let src = include_str!("lib.rs");
        let setup = &src[src.find(".setup(move |app| {").unwrap()..];
        assert!(setup.contains(concat!("spawn_health_", "monitor(")));
        assert!(setup.contains(concat!("core_log::", "init(")));
        assert!(src.matches(concat!(".stopping", ".store(true")).count() >= 2, "ExitRequested와 Exit 둘 다 감시를 멈춘다");
    }

    #[test]
    fn observe_core_reports_a_missing_core_and_skips_a_running_start() {
        let state = super::CoreState::default();
        let seen = super::observe_core(&state, true).unwrap();
        assert_eq!(seen.core_id, None);
        assert!(matches!(seen.seen, crate::health::Seen::Gone(_)));
        *state.pending() = Some(Arc::new(core::PendingStart::default()));
        assert!(super::observe_core(&state, true).is_none(), "시작 중에는 관측하지 않는다");
    }

    #[test]
    fn observe_core_probes_a_live_core_and_flags_missing_mcp() {
        let state = super::CoreState::default();
        *state.0.lock().unwrap() = Some(core::ManagedCore::for_test_alive("http://127.0.0.1:1", None));
        match super::observe_core(&state, true).unwrap().seen {
            crate::health::Seen::Running { api: crate::health::Probe::Fail(_), mcp: crate::health::McpSeen::Missing } => {}
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            super::observe_core(&state, false).unwrap().seen,
            crate::health::Seen::Running { mcp: crate::health::McpSeen::Off, .. }
        ));
    }
```
테스트 모듈에 `Arc`가 import돼 있지 않으면 `use std::sync::Arc;`를 더한다.

- [ ] **Step 2: 실패 확인**

Run: `cd desktop/src-tauri && cargo test --lib health_notice reveal_core_log health_monitor_starts observe_core`
Expected: 컴파일 실패 (`health_notice`, `observe_core` 미정의)

- [ ] **Step 3: 구현**

(a) 관리 상태 — `CoreState` 정의 아래에 추가:
```rust
/// The health monitor's latest view for `core_status`, and the flag that stops it on exit
/// (spec 2026-10-19-desktop-core-health-design).
#[derive(Default)]
struct HealthState {
    snapshot: Mutex<health::Snapshot>,
    stopping: std::sync::atomic::AtomicBool,
}
```

(b) `CoreStatus`와 `core_status`를 바꾼다:
```rust
struct CoreStatus {
    running: bool,
    endpoint: Option<String>,
    mcp_endpoint: Option<String>,
    /// What the health monitor last saw (spec 2026-10-19-desktop-core-health-design).
    health: health::Snapshot,
    log_path: Option<String>,
}

/// Reports whether the Python Core child process is alive, its endpoints, and what the
/// health monitor last saw of its API and MCP.
#[command]
fn core_status(state: State<'_, CoreState>, health: State<'_, HealthState>) -> CoreStatus {
    let snapshot = health.snapshot.lock().unwrap_or_else(PoisonError::into_inner).clone();
    let log_path = core_log::path().map(|path| path.display().to_string());
    if let Ok(mut guard) = state.0.lock() {
        if let Some(managed) = guard.as_mut() {
            return CoreStatus {
                running: managed.is_alive(),
                endpoint: Some(managed.endpoint.clone()),
                mcp_endpoint: managed.mcp_endpoint.clone(),
                health: snapshot,
                log_path,
            };
        }
    }
    CoreStatus { running: false, endpoint: None, mcp_endpoint: None, health: snapshot, log_path }
}
```
(`CoreStatus` 위의 derive는 그대로 둔다.)

(c) `core_status` 아래에 로그 열기 명령:
```rust
/// Shows the Core log in Finder (admin page "로그 폴더 열기"). Takes nothing from the
/// webview — the path is the shell's own (spec 2026-10-19-desktop-core-health-design).
#[command]
fn reveal_core_log() -> Result<(), String> {
    let path = core_log::path().ok_or("로그 위치를 알 수 없습니다")?;
    // 아직 한 줄도 안 썼으면 파일이 없다 — 폴더라도 보여 준다.
    let target = if path.exists() { path } else { path.parent().map(std::path::Path::to_path_buf).ok_or("로그 위치를 알 수 없습니다")? };
    tauri_plugin_opener::reveal_item_in_dir(target).map_err(|e| e.to_string())
}
```

(d) 감시 스레드와 도우미 — `spawn_core_event_loop` 함수 아래에 추가:
```rust
/// Milliseconds since the epoch, for the admin page's "마지막 확인 N초 전".
fn wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// What the health monitor sees of the stored Core, or `None` while a start or
/// restart is running (its own wait and errors cover that window).
fn observe_core(state: &CoreState, mcp_enabled: bool) -> Option<health::Observation> {
    if state.pending().is_some() {
        return None;
    }
    let (core_id, exited, endpoint, mcp_endpoint) = {
        let mut guard = state.0.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(core) = guard.as_mut() else {
            return Some(health::Observation {
                core_id: None,
                seen: health::Seen::Gone("마지막 시작이 실패해 실행 중인 Core가 없음".into()),
            });
        };
        (core.id, core.exit_status(), core.endpoint.clone(), core.mcp_endpoint.clone())
    };
    // The probes run outside the lock: `core_status` and restarts must not wait on them.
    let seen = match exited {
        Some(how) => health::Seen::Gone(how),
        None => health::Seen::Running {
            api: health::probe_healthz(&endpoint, health::PROBE_TIMEOUT),
            mcp: match (mcp_enabled, mcp_endpoint) {
                (false, _) => health::McpSeen::Off,
                (true, None) => health::McpSeen::Missing,
                (true, Some(endpoint)) => health::McpSeen::Probe(health::probe_healthz(&endpoint, health::PROBE_TIMEOUT)),
            },
        },
    };
    Some(health::Observation { core_id: Some(core_id), seen })
}

/// One log line for a health state change: `api=ok mcp=down phase=recovering — MCP 응답 없음: 연결 거부`.
fn health_change_line(s: &health::Snapshot) -> String {
    let mut line = format!("api={} mcp={} phase={}", s.api, s.mcp, s.phase);
    if s.api == "down" || s.mcp == "down" || s.mcp == "missing" {
        if let Some(why) = &s.last_error {
            line.push_str(&format!(" — {why}"));
        }
    }
    line
}

/// Watch the stored Core for the life of the app (spec 2026-10-19-desktop-core-health-design):
/// every `PROBE_INTERVAL` check the process and both `/healthz`, restart through the #44
/// path when `health::Monitor` says so, and tell the user once when it gives up.
fn spawn_health_monitor(app: &tauri::AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("raven-core-health".into()).spawn(move || {
        let mcp_enabled = core::mcp_enabled_from_env(std::env::var("RAVEN_DESKTOP_MCP").ok());
        let mut monitor = health::Monitor::default();
        loop {
            std::thread::sleep(health::PROBE_INTERVAL);
            if app.state::<HealthState>().stopping.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let Some(observation) = observe_core(&app.state::<CoreState>(), mcp_enabled) else {
                continue;
            };
            let before = monitor.snapshot();
            let action = monitor.observe(std::time::Instant::now(), wall_ms(), observation);
            let after = monitor.snapshot();
            if (before.api, before.mcp, before.phase) != (after.api, after.mcp, after.phase) {
                core_log::log("health", &health_change_line(&after));
            }
            *app.state::<HealthState>().snapshot.lock().unwrap_or_else(PoisonError::into_inner) = after;
            act_on_health(&app, action);
        }
    });
    if spawned.is_err() {
        eprintln!("[core] could not start the health monitor — a stopped Core will not be restarted");
    }
}

fn act_on_health(app: &tauri::AppHandle, action: health::Action) {
    match action {
        health::Action::None => {}
        health::Action::Recovered => core_log::log("health", "recovered"),
        health::Action::Restart { attempt, reason } => {
            core_log::log("health", &format!("restart #{attempt}/{} ({reason})", health::MAX_RESTARTS));
            match do_restart_core(app) {
                // Like a network restart: reload only when the page's endpoint is gone.
                Ok(true) => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("location.reload()");
                    }
                }
                Ok(false) => {}
                Err(error) => core_log::log("health", &format!("restart #{attempt} failed: {error}")),
            }
        }
        health::Action::GiveUp { reason } => {
            core_log::log("health", &format!("gave up after {} restarts ({reason})", health::MAX_RESTARTS));
            show_health_dialog(app, &reason);
        }
    }
}

/// One give-up dialog at a time.
static HEALTH_NOTICE_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn show_health_dialog(app: &tauri::AppHandle, reason: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let log_path = core_log::path();
    let notice = health_notice(reason, core_log::last_warning().as_deref(), log_path.as_deref());
    eprintln!("{notice}");
    if HEALTH_NOTICE_OPEN.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    core_log::log("health", "dialog shown");
    app.dialog()
        .message(notice)
        .title("Raven")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("로그 열기".into(), "닫기".into()))
        .show(move |open_log| {
            HEALTH_NOTICE_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
            if let (true, Some(path)) = (open_log, log_path) {
                let _ = tauri_plugin_opener::reveal_item_in_dir(path);
            }
        });
}

/// The give-up dialog's text.
fn health_notice(reason: &str, last_warning: Option<&str>, log_path: Option<&std::path::Path>) -> String {
    let mut text = format!(
        "Raven 백엔드를 자동으로 복구하지 못했습니다.\n• 증상: {reason}\n• 자동 재시작 {}회 시도",
        health::MAX_RESTARTS
    );
    if let Some(warning) = last_warning {
        text.push_str(&format!("\n• Core 마지막 경고: {warning}"));
    }
    if let Some(path) = log_path {
        text.push_str(&format!("\n\n로그: {}", path.display()));
    }
    text.push_str("\n\n트레이나 관리 화면에서 백엔드를 재시작하면 자동 복구가 다시 켜집니다.");
    text
}
```

(e) `run()` 연결:
- `.manage(RequestedExit::default())` 아래에 `.manage(HealthState::default())`
- `generate_handler!`에서 `core_status,` 다음 줄에 `reveal_core_log,`
- setup 맨 앞 (`let handle = app.handle().clone();` 바로 아래):
```rust
            // spec 2026-10-19-desktop-core-health-design: 원인 로그는 첫 Core보다 먼저 연다.
            if let Ok(dir) = handle.path().app_log_dir() {
                core_log::init(dir.join("core.log"));
            }
            core_log::log("shell", &format!("Raven {} start", handle.package_info().version));
```
- setup에서 최초 기동 `spawn_blocking(...)` 블록 바로 뒤:
```rust
            spawn_health_monitor(app.handle());
```
- `RunEvent::ExitRequested` 팔과 `RunEvent::Exit` 팔에서 `app.state::<CoreState>().stop();` 바로 위에 각각:
```rust
                        app.state::<HealthState>().stopping.store(true, std::sync::atomic::Ordering::SeqCst);
```

(f) `permissions/default.toml`: `[default]`의 `permissions` 배열 끝에 `"allow-reveal-core-log"`를 넣고, 파일 끝에 추가:
```toml
[[permission]]
identifier = "allow-reveal-core-log"
description = "Allow invoking the reveal_core_log command (shows the shell's own Core log in Finder; takes no path)."
commands.allow = ["reveal_core_log"]
```
`capabilities/default.json`의 `"allow-reveal-saved-export",` 다음 줄에 `"allow-reveal-core-log",`.

- [ ] **Step 4: 통과와 회귀 확인**

Run: `cd desktop/src-tauri && cargo test --lib && cargo build`
Expected: 전부 통과, 경고 없이 빌드. 미사용 경고가 남으면 해당 항목이 정말 쓰이는지 확인한다.

---

### Task 6: 관리 화면 (`StatusDot`, `CoreHealthPanel`, `VaultManage`)

**Files:**
- Create: `dashboard/src/components/ui/StatusDot.tsx`, `dashboard/src/components/CoreHealthPanel.tsx`, `dashboard/tests/CoreHealthPanel.test.tsx`
- Modify: `dashboard/src/routes/VaultManage.tsx` (94행 `interface CoreStatus`, 818~836행 상태 블록)

- [ ] **Step 1: 테스트 작성** — `dashboard/tests/CoreHealthPanel.test.tsx`

```tsx
/* 관리 화면 백엔드 상태 (spec 2026-10-19-desktop-core-health-design).
 *
 *  1. API·MCP를 따로, 셸 헬스체크 결과 그대로 그린다 — 프로세스가 살아 있다는 것만으로 "정상"이라 하지 않는다.
 *  2. 복구 중이면 재시작 횟수, 포기했으면 "복구 실패", 시작되지 않은 MCP는 "미기동", 설정으로 끈 MCP는 "꺼짐 (설정)".
 *  3. 마지막 확인 시각과 최근 오류. 로그 폴더 버튼은 셸이 로그 경로를 줄 때만.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CoreHealthPanel, type CoreHealth, type CoreStatus } from "../src/components/CoreHealthPanel";

const NOW = 1_760_000_000_000;

function status(health: Partial<CoreHealth>, extra: Partial<CoreStatus> = {}): CoreStatus {
  return {
    running: true,
    endpoint: "http://127.0.0.1:8765",
    mcp_endpoint: "http://127.0.0.1:8766/mcp",
    log_path: "/Users/me/Library/Logs/com.raven.local/core.log",
    health: {
      api: "ok",
      mcp: "ok",
      phase: "healthy",
      restarts: 0,
      max_restarts: 3,
      checked_at_ms: NOW - 7_000,
      last_error: null,
      last_error_at_ms: null,
      ...health,
    },
    ...extra,
  };
}

const row = (name: string) => screen.getByText(name).parentElement!.textContent;

describe("CoreHealthPanel", () => {
  it("shows API and MCP separately from the health check", () => {
    render(
      <CoreHealthPanel
        status={status({ mcp: "down", phase: "recovering", restarts: 2, last_error: "MCP 응답 없음: 연결 거부", last_error_at_ms: NOW - 20_000 })}
        now={NOW}
      />,
    );
    expect(screen.getByText("실행 중")).toBeTruthy();
    expect(row("API")).toContain("정상");
    expect(row("MCP")).toContain("복구 중 (재시작 2/3)");
    expect(screen.getByText(/마지막 확인 7초 전/)).toBeTruthy();
    expect(screen.getByText(/MCP 응답 없음: 연결 거부/)).toBeTruthy();
  });

  it("names a given-up recovery, an MCP that never started and an MCP turned off", () => {
    const gaveUp = render(<CoreHealthPanel status={status({ mcp: "missing", phase: "gave_up", restarts: 3 })} now={NOW} />);
    expect(row("MCP")).toContain("복구 실패");
    gaveUp.unmount();
    const missing = render(<CoreHealthPanel status={status({ mcp: "missing", phase: "healthy" })} now={NOW} />);
    expect(row("MCP")).toContain("미기동");
    missing.unmount();
    render(<CoreHealthPanel status={status({ mcp: "off" }, { mcp_endpoint: null })} now={NOW} />);
    expect(row("MCP")).toContain("꺼짐 (설정)");
  });

  it("offers the log folder only with a log path and a handler", () => {
    const onRevealLog = vi.fn();
    const withLog = render(<CoreHealthPanel status={status({})} now={NOW} onRevealLog={onRevealLog} />);
    fireEvent.click(screen.getByRole("button", { name: "로그 폴더 열기" }));
    expect(onRevealLog).toHaveBeenCalledTimes(1);
    withLog.unmount();
    render(<CoreHealthPanel status={status({}, { log_path: null })} now={NOW} onRevealLog={onRevealLog} />);
    expect(screen.queryByRole("button", { name: "로그 폴더 열기" })).toBeNull();
  });

  it("waits for the first status", () => {
    render(<CoreHealthPanel status={null} />);
    expect(screen.getByText("확인 중…")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard && npx vitest run tests/CoreHealthPanel.test.tsx`
Expected: FAIL (`../src/components/CoreHealthPanel` 모듈 없음)

- [ ] **Step 3: 구현**

`dashboard/src/components/ui/StatusDot.tsx`:
```tsx
// StatusDot — 상태를 나타내는 8px 점 (spec 2026-10-19-desktop-core-health-design).
// 색은 CSS 변수만 쓴다 (AGENTS.md §13.2).
export type StatusTone = "ok" | "warn" | "error" | "off";

const TONE_COLOR: Record<StatusTone, string> = {
  ok: "var(--color-success-text)",
  warn: "var(--color-warning-text)",
  error: "var(--color-danger-text)",
  off: "var(--color-muted)",
};

export function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: TONE_COLOR[tone] }}
    />
  );
}
```

`dashboard/src/components/CoreHealthPanel.tsx`:
```tsx
// CoreHealthPanel — 관리 화면의 백엔드 상태 (spec 2026-10-19-desktop-core-health-design).
//
// 셸의 core_status를 그대로 그린다: 프로세스, API·MCP 각각의 헬스체크 결과, 마지막 확인
// 시각, 최근 오류, 로그 폴더 열기. 판정은 셸의 헬스 모니터가 하고 이 컴포넌트는 표시만 한다.
import { Button } from "./ui/Button";
import { StatusDot, type StatusTone } from "./ui/StatusDot";

export interface CoreHealth {
  api: "ok" | "down" | "unknown";
  mcp: "ok" | "down" | "missing" | "off" | "unknown";
  phase: "healthy" | "recovering" | "gave_up";
  restarts: number;
  max_restarts: number;
  checked_at_ms: number | null;
  last_error: string | null;
  last_error_at_ms: number | null;
}

export interface CoreStatus {
  running: boolean;
  endpoint?: string | null;
  mcp_endpoint?: string | null;
  health?: CoreHealth;
  log_path?: string | null;
}

export interface CoreHealthPanelProps {
  status: CoreStatus | null;
  /** 지금 시각 (테스트 주입용). */
  now?: number;
  /** 있으면 "로그 폴더 열기" 버튼을 보여 준다. */
  onRevealLog?: () => void;
}

type ServiceState = { tone: StatusTone; label: string };

export function serviceState(state: CoreHealth["mcp"], health: CoreHealth): ServiceState {
  switch (state) {
    case "ok":
      return { tone: "ok", label: "정상" };
    case "off":
      return { tone: "off", label: "꺼짐 (설정)" };
    case "unknown":
      return { tone: "off", label: "확인 중" };
    case "missing":
    case "down":
      if (health.phase === "gave_up") return { tone: "error", label: "복구 실패" };
      if (health.phase === "recovering") {
        return { tone: "warn", label: `복구 중 (재시작 ${health.restarts}/${health.max_restarts})` };
      }
      return { tone: "error", label: state === "missing" ? "미기동" : "응답 없음" };
  }
}

export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 5) return "방금";
  if (seconds < 60) return `${seconds}초 전`;
  return `${Math.floor(seconds / 60)}분 전`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function ServiceRow({ name, state, detail }: { name: string; state: ServiceState; detail?: string | null }) {
  return (
    <div style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <StatusDot tone={state.tone} />
      <span style={{ fontWeight: 600, minWidth: 30 }}>{name}</span>
      <span>{state.label}</span>
      {detail && <span style={{ color: "var(--color-muted)", wordBreak: "break-all" }}>{detail}</span>}
    </div>
  );
}

export function CoreHealthPanel({ status, now = Date.now(), onRevealLog }: CoreHealthPanelProps) {
  const health = status?.health;
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-muted)", textTransform: "uppercase", marginBottom: 6 }}>
        백엔드 프로세스 상태
      </div>
      <div style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
        <StatusDot tone={status === null ? "off" : status.running ? "ok" : "error"} />
        <strong>{status === null ? "확인 중…" : status.running ? "실행 중" : "중지됨"}</strong>
      </div>
      {health && (
        <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
          <ServiceRow name="API" state={serviceState(health.api, health)} detail={status?.endpoint} />
          <ServiceRow name="MCP" state={serviceState(health.mcp, health)} detail={status?.mcp_endpoint} />
          <div style={{ fontSize: 11, color: "var(--color-muted)" }}>
            {health.checked_at_ms !== null ? `마지막 확인 ${formatAgo(now - health.checked_at_ms)}` : "아직 확인 전"}
            {health.last_error && health.last_error_at_ms !== null && (
              <>
                {" · 최근 오류 "}
                {clock(health.last_error_at_ms)} {health.last_error}
              </>
            )}
          </div>
        </div>
      )}
      {onRevealLog && status?.log_path && (
        <div style={{ marginTop: 8 }}>
          <Button variant="secondary" size="sm" onClick={onRevealLog}>
            로그 폴더 열기
          </Button>
        </div>
      )}
    </div>
  );
}
```

`VaultManage.tsx`:
- 위쪽 import에 `import { CoreHealthPanel, type CoreStatus } from "../components/CoreHealthPanel";`를 넣고, 94행의 `interface CoreStatus { … }`는 지운다.
- `restartBackend` 함수 아래에 추가:
```tsx
  async function revealCoreLog() {
    try {
      await (window as any).__TAURI_INTERNALS__?.invoke("reveal_core_log");
    } catch (e) {
      setRestartMsg(`❌ 로그를 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
```
- 상태 블록에서 "백엔드 프로세스 상태" 제목부터 `MCP: {coreStatus.mcp_endpoint}` 블록까지를 감싼 첫 번째 `<div>…</div>`를 아래 한 줄로 바꾼다. 재시작 버튼이 있는 두 번째 `<div>`는 그대로 둔다.
```tsx
              <CoreHealthPanel status={coreStatus} onRevealLog={() => void revealCoreLog()} />
```

- [ ] **Step 4: 통과와 회귀 확인**

Run: `cd dashboard && npx vitest run tests/CoreHealthPanel.test.tsx && npx vitest run && cd .. && make typecheck`
Expected: 새 테스트 4개 통과, 전체 통과(기존 664 + 4), typecheck 0

---

### Task 7: 문서

**Files:**
- Modify: `_meta/changelog-v0.7.183.md` (§9 "다음" 앞에 새 절을 넣고 번호를 하나씩 민다)
- Modify: `README.md` (데스크톱 앱 문제 해결에 로그 위치 한 줄)

- [ ] **Step 1: changelog** — `## 9. 다음`을 `## 10. 다음`으로 바꾸고, 그 앞에 넣는다.
```markdown
## 9. 데스크톱 Core 헬스체크·자동 복구·원인 로그

"며칠 지나면 Claude가 Raven MCP가 꺼져 있다는데 관리 화면은 정상"의 바탕에는 세 가지가 있었다. 관리 화면은 Python 프로세스가 살아 있는지만 봤다. MCP는 포트 충돌이나 시작 실패 때 stderr 한 줄만 남기고 조용히 빠졌다. 셸은 Core가 죽어도 다시 띄우지 않았다. Claude Code는 원격 MCP가 약 30초 넘게 끊기면 그 세션에서 재연결을 포기한다. 설계: `docs/superpowers/specs/2026-10-19-desktop-core-health-design.md`.

- **헬스체크**: 셸 스레드 `raven-core-health`가 10초마다 프로세스와 API·MCP `/healthz`를 확인한다(타임아웃 3초). 프로세스 종료와 MCP 미기동은 즉시, 응답 없음은 2번 연속일 때 장애로 본다.
- **자동 복구**: Core 전체를 재시작한다(#44 경로). 간격은 즉시·30초·60초로 최대 3회다. 그래도 안 되면 경고 다이얼로그([로그 열기])를 장애 한 건당 한 번 띄우고 자동 재시작을 멈춘다. 10분 연속 정상이거나 수동으로 재시작하면 횟수가 초기화된다.
- **원인 로그**: `~/Library/Logs/com.raven.local/core.log` (5MB × 3). Core stderr, Core 시작·종료(시그널 포함), 헬스 상태 변화, 재시작, 다이얼로그를 남긴다. 토큰과 손님 이벤트 본문은 남기지 않는다.
- **관리 화면**: API와 MCP를 따로 보여 준다(정상 / 복구 중 n/3 / 복구 실패 / 미기동 / 꺼짐(설정)). 마지막 확인 시각, 최근 오류, [로그 폴더 열기]도 있다. 셸 명령 `reveal_core_log`(인자 없음)와 권한 `allow-reveal-core-log`가 추가됐다.
- 검증: (Task 8 결과로 채운다 — cargo test 수, vitest 수, 실제 앱 E2E 결과)
```

- [ ] **Step 2: README** — 데스크톱 앱 절(`grep -n "데스크톱" README.md`로 위치 확인)의 문제 해결 부분에 추가:
```markdown
- 백엔드가 이상하면: 관리 → 백엔드 프로세스 상태에서 API·MCP를 따로 확인하고 [로그 폴더 열기]. 로그는 `~/Library/Logs/com.raven.local/core.log`. Claude Code가 "MCP 꺼짐"이라고 하는데 여기가 정상이면 그 세션에서 `/mcp` → Reconnect.
```

---

### Task 8: 실제 앱 E2E (`tauri dev`)

설치된 Raven.app이 8765·8766을 쓰고 있으므로, 개발용 앱의 MCP는 `PORT_MCP`로 다른 포트에 띄운다. 개발용 앱도 같은 로그 경로를 쓴다(식별자가 같음).

- [ ] **Step 1: 프로세스 종료 → 자동 재시작**

```bash
cd dashboard && PORT_MCP=18766 npm run desktop:dev   # 백그라운드로 실행
```
준비되면(창이 뜨고 `ps`에 `raven.desktop.runtime` 자식이 보임):
```bash
CORE=$(pgrep -f "raven.desktop.runtime" | while read p; do ps -o ppid= -p $p | grep -q "$(pgrep -f 'target/debug/raven-desktop')" && echo $p; done)
kill -9 $CORE
```
Expected: 20초 안에 새 `raven.desktop.runtime` pid가 생기고 `~/Library/Logs/com.raven.local/core.log`에 다음이 남는다.
```
[health] api=down mcp=down phase=recovering — Core 프로세스 없음 (signal: 9 (SIGKILL))
[health] restart #1/3 (Core 프로세스 없음 (signal: 9 (SIGKILL)))
[shell] core spawn pid=…
[shell] core ready pid=… api=… mcp=http://127.0.0.1:18766/mcp
[health] recovered
```

- [ ] **Step 2: MCP 미기동 → 3회 재시작 → 다이얼로그**

개발용 앱을 끄고(`Raven 종료` 또는 프로세스 종료) `PORT_MCP` 없이 다시 띄운다. 설치된 앱이 8766을 잡고 있으므로 MCP는 미기동이 된다.
```bash
cd dashboard && npm run desktop:dev
```
Expected: 약 2분 안에 로그에 `restart #1/3`, `#2/3`, `#3/3`, `gave up after 3 restarts (MCP가 시작되지 않음 (API만 실행 중))`, `dialog shown`이 남는다. 다이얼로그 본문에는 "Core 마지막 경고: ⚠️ … MCP port 8766 already in use …"가 보인다(`screencapture -x /tmp/…png`로 확인). 관리 화면 MCP 줄은 "복구 실패"다.

- [ ] **Step 3: 정리** — 개발용 앱과 vite dev 서버를 종료한다. 설치된 Raven.app은 그대로 둔다.

---

### Task 9: 최종 검증과 보고

- [ ] `cd desktop/src-tauri && cargo test --lib` — 전부 통과
- [ ] `cd dashboard && npx vitest run` — 전부 통과
- [ ] `make typecheck` — 통과
- [ ] changelog의 검증 줄을 실제 수치로 채운다
- [ ] `git status`로 변경 파일을 확인한다(`.hellburn/`은 건드리지 않음)
- [ ] 사용자에게 결과를 보고하고 commit·push 승인을 받는다 (push 때는 `gh auth switch -u jaekanglee`, 끝나면 `barogo-jk`로 되돌림)

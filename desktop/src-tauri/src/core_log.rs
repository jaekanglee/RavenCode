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

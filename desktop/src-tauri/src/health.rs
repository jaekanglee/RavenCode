//! Core 헬스체크 (spec 2026-10-19-desktop-core-health-design).
//!
//! `probe_healthz`는 루프백 `GET /healthz` 탐침이다. `Monitor`는 I/O 없는 판정 상태
//! 기계다. 감시 스레드(lib.rs `spawn_health_monitor`)가 10초마다 관측을 넣고, 돌려받은
//! 행동(재시작, 포기, 복구됨)을 실행한다.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

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

// 셸 blank 화면 복구 — lib.rs가 include_str!로 읽어 창 포커스·트레이 열기·Dock 재오픈 때 웹뷰에 eval한다.
// 테스트: dashboard/tests/desktop.blank-recovery.test.ts (이 파일을 그대로 jsdom에서 실행).
//
// 원래 목적: 창이 오래 숨겨진 사이 WKWebView 렌더러가 회수되어 내용이 비면 reload로 살린다.
// 문제(Issue #1 A-1): 첫 JS 번들이 깨지면 #root가 계속 비어 포커스마다 reload가 끝없이 반복됐다
// (실측: 포커스 5회 → reload 8회). 그래서 자동 reload에 예산을 둔다.
//
// 정책:
//  - 자동 reload는 정상 화면이 확인되기 전까지 최대 3회. 4번째 blank 감지 때 reload 대신 안내를 그린다.
//  - 차단(blocked)은 자동으로 풀지 않는다. 새 세션(앱 재실행)에서만 풀린다.
//  - 카운터는 "마지막 자동 reload 뒤 60초 이상 지나 #root가 비어 있지 않은 것"을 셸 점검에서
//    확인했을 때만 비운다. React가 잠깐 마운트됐다는 것이나 시간이 흘렀다는 것만으로는 비우지 않는다.
//  - 페이지 가동 10초 미만의 blank는 부팅 중(HTML 파싱 중이거나 main.tsx가 Core endpoint를 기다리는 구간)으로 보고
//    세지도 reload하지도 않는다.
//  - 저장소를 못 쓰거나 값이 손상됐으면 reload하지 않고 안내를 그린다 (예산을 기록할 수 없으면 반복을 막을 수 없다).
//  - 상태는 sessionStorage — reload와 렌더러 재생성(Tauri의 자동 reload) 뒤에도 남고, 앱 재실행 때 비워진다.
//
// 사용자의 Cmd+R(View > Reload)은 이 예산과 무관한 명시적 조작이다.
function __ravenBlankRecovery(env) {
  var KEY = "raven:blank-recovery";
  var NOTICE_ID = "raven-blank-recovery-notice";
  var MAX_RELOADS = 3;
  var HEALTHY_AFTER_MS = 60000;
  var BOOT_GRACE_MS = 10000;

  env = env || {};
  var doc = env.document || document;
  var now = (env.now || Date.now)();
  var uptime = typeof env.uptime === "number" ? env.uptime : performance.now();
  var reload = env.reload || function () { location.reload(); };
  var getStorage = env.storage || function () { return window.sessionStorage; };

  function warn(msg) {
    try { console.warn("[Raven Desktop] blank 복구: " + msg); } catch (e) {}
  }

  function isCount(n) {
    return typeof n === "number" && n >= 0 && n <= MAX_RELOADS && Math.floor(n) === n;
  }
  function isTime(t) {
    return typeof t === "number" && isFinite(t) && t > 0;
  }
  // null = 기록 없음, false = 손상, 그 외 = 상태
  function parse(raw) {
    if (raw === null || raw === undefined) return null;
    var s;
    try { s = JSON.parse(raw); } catch (e) { return false; }
    if (!s || typeof s !== "object" || Array.isArray(s)) return false;
    if (!isCount(s.count) || !isTime(s.firstAt) || !isTime(s.lastAt) || typeof s.blocked !== "boolean") return false;
    return s;
  }

  function showNotice(reason) {
    if (doc.getElementById(NOTICE_ID)) return;
    warn("자동 복구 중단 (" + reason + ")");
    var loader = doc.getElementById("boot-loader");
    if (loader && loader.parentNode) loader.parentNode.removeChild(loader);
    var host = doc.getElementById("root") || doc.body || doc.documentElement;
    var box = doc.createElement("div");
    box.id = NOTICE_ID;
    box.setAttribute("role", "alert");
    box.innerHTML =
      "<style>" +
      "#" + NOTICE_ID + "{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;" +
      "padding:24px;background:#f8fafc;color:#0f172a;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}" +
      "#" + NOTICE_ID + " div{max-width:520px}" +
      "#" + NOTICE_ID + " h1{margin:0 0 12px;font-size:22px;line-height:1.35}" +
      "#" + NOTICE_ID + " p{margin:0 0 8px}" +
      "#" + NOTICE_ID + " .sub{color:#475569;font-size:14px}" +
      "@media (prefers-color-scheme:dark){#" + NOTICE_ID + "{background:#0f172a;color:#f1f5f9}#" + NOTICE_ID + " .sub{color:#cbd5e1}}" +
      "</style>" +
      "<div>" +
      "<h1>앱 화면을 불러오지 못했습니다.</h1>" +
      "<p>화면을 복구하려고 여러 번 시도했지만 정상적으로 시작되지 않았습니다.</p>" +
      "<p><strong>앱을 완전히 종료한 뒤 다시 실행해 주세요.</strong></p>" +
      "<p class=\"sub\">문제가 계속되면 앱 업데이트 또는 재설치가 필요할 수 있습니다.</p>" +
      "</div>";
    host.appendChild(box);
  }

  // 이미 안내를 그렸으면 아무것도 하지 않는다 (안내 화면에서는 reload 없음).
  if (doc.getElementById(NOTICE_ID)) return;

  var root = doc.getElementById("root");
  var blank = !(root && root.hasChildNodes());

  var storage = null;
  try { storage = getStorage(); } catch (e) { storage = null; }
  var raw = null;
  var readOk = false;
  if (storage) {
    try { raw = storage.getItem(KEY); readOk = true; } catch (e) { readOk = false; }
  }
  var state = readOk ? parse(raw) : false;

  if (!blank) {
    // 정상 화면(또는 ErrorBoundary 화면)은 건드리지 않는다. 회복이 확인되면 카운터만 비운다.
    if (state && !state.blocked && now - state.lastAt >= HEALTHY_AFTER_MS) {
      try { storage.removeItem(KEY); } catch (e) {}
    }
    return;
  }

  // 문서가 막 떴으면 고장이 아니다 — HTML 파싱 중이라 #root가 아직 없거나(창 생성 직후 첫 포커스,
  // Tauri 실측), main.tsx가 Core endpoint를 기다리며 #root를 비워 둔 구간.
  if (uptime < BOOT_GRACE_MS) return;

  if (!readOk) return showNotice("저장소 접근 실패");
  if (state === false) {
    try { storage.setItem(KEY, JSON.stringify({ v: 1, count: MAX_RELOADS, firstAt: now, lastAt: now, blocked: true })); } catch (e) {}
    return showNotice("복구 기록 손상");
  }
  if (state && state.blocked) return showNotice("이미 차단됨");
  if (state && state.count >= MAX_RELOADS) {
    try { storage.setItem(KEY, JSON.stringify({ v: 1, count: state.count, firstAt: state.firstAt, lastAt: state.lastAt, blocked: true })); } catch (e) {}
    return showNotice("자동 복구 " + MAX_RELOADS + "회 초과");
  }

  // reload 전에 기록하고, 기록이 실제로 남았을 때만 reload한다.
  var next = JSON.stringify({ v: 1, count: (state ? state.count : 0) + 1, firstAt: state ? state.firstAt : now, lastAt: now, blocked: false });
  var saved = false;
  try { storage.setItem(KEY, next); saved = storage.getItem(KEY) === next; } catch (e) { saved = false; }
  if (!saved) return showNotice("복구 기록 저장 실패");
  warn("빈 화면 감지 → 자동 reload " + JSON.parse(next).count + "/" + MAX_RELOADS);
  reload();
}

/* Issue #1 A-1 (셸) — 데스크톱 셸의 blank 화면 자동 복구가 무한 reload를 만들지 않는다.
 *
 * 셸(desktop/src-tauri/src/lib.rs)은 창 포커스·트레이 열기·Dock 재오픈 때마다
 * blank_recovery.js를 웹뷰에 eval한다. 수정 전에는 #root가 비어 있으면 무조건
 * location.reload()라, 첫 JS 번들이 깨지면 포커스마다 reload가 끝없이 반복됐다
 * (실측: 포커스 5회 → reload 8회).
 *
 * 셸이 eval하는 바로 그 파일을 읽어 jsdom에서 실행한다. 웹뷰가 주는 것
 * (document·sessionStorage·시계·페이지 가동 시간·reload)은 env로 주입한다.
 */
import { describe, it, expect, beforeEach } from "vitest";
import SRC from "../../desktop/src-tauri/src/blank_recovery.js?raw";

interface Env {
  document?: Document;
  storage?: () => Storage;
  now?: () => number;
  uptime?: number;
  reload?: () => void;
}
const recover = new Function(`${SRC}\nreturn __ravenBlankRecovery;`)() as (env?: Env) => void;

const KEY = "raven:blank-recovery";
const NOTICE = "raven-blank-recovery-notice";
const T0 = 1_800_000_000_000;

/** 앱 문서: 첫 번들이 깨진 상태 = #root 비어 있음 + 정적 boot-loader. */
function blankPage() {
  document.body.innerHTML = `<div id="root"></div><div id="boot-loader">Raven 시작 중…</div>`;
}
function appPage(html = `<div id="primary-sidebar"></div><main>HOME</main>`) {
  document.body.innerHTML = `<div id="root">${html}</div>`;
}

/** 실제 웹뷰처럼: reload되면 문서가 새로 뜨고(blank 번들이면 다시 blank), 가동 시간이 0부터. */
function harness(opts: { storage?: () => Storage } = {}) {
  let now = T0;
  let uptime = 60_000;
  const reloads: { at: number; stored: string | null }[] = [];
  const env = (): Env => ({
    document,
    storage: opts.storage ?? (() => window.sessionStorage),
    now: () => now,
    uptime,
    reload: () => {
      let stored: string | null = null;
      try {
        stored = window.sessionStorage.getItem(KEY);
      } catch {
        stored = null;
      }
      reloads.push({ at: now, stored });
    },
  });
  return {
    reloads,
    /** 셸의 focus/show/reopen 1회. */
    check() {
      recover(env());
    },
    /** 시간 경과 (가동 시간도 함께 흐름). */
    wait(ms: number) {
      now += ms;
      uptime += ms;
    },
    /** reload 직후 새 문서 — blank 번들이면 다시 비어 있다. */
    reloaded(page: () => void = blankPage) {
      page();
      uptime = 0;
    },
  };
}

const notice = () => document.getElementById(NOTICE);
const stored = () => JSON.parse(window.sessionStorage.getItem(KEY) ?? "null");

beforeEach(() => {
  window.sessionStorage.clear();
  document.body.innerHTML = "";
});

describe("셸 blank 복구 — 정상 동작", () => {
  it("정상 앱 화면에서는 reload 0회, 상태도 기록하지 않는다", () => {
    appPage();
    const h = harness();
    for (let i = 0; i < 5; i++) h.check();
    expect(h.reloads).toHaveLength(0);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("ErrorBoundary 오류 화면(#root 비어 있지 않음)에서는 reload 0회", () => {
    appPage(`<div role="alert">이 화면을 표시하지 못했습니다</div>`);
    const h = harness();
    for (let i = 0; i < 5; i++) h.check();
    expect(h.reloads).toHaveLength(0);
  });

  it("일시적 blank: 허용 범위 안에서 1회 복구 reload", () => {
    blankPage();
    const h = harness();
    h.check();
    expect(h.reloads).toHaveLength(1);
    expect(notice()).toBeNull();
  });

  it("부팅 중(페이지 가동 10초 미만)의 빈 #root는 고장으로 세지 않는다", () => {
    // main.tsx는 Core endpoint를 기다리는 동안(최대 ~6초) #root를 비워 둔다
    blankPage();
    const h = harness();
    h.reloaded();
    h.wait(3_000);
    for (let i = 0; i < 5; i++) h.check();
    expect(h.reloads).toHaveLength(0);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(notice()).toBeNull();
  });

  it("창 생성 직후 HTML 파싱 중(#root 아직 없음)의 첫 포커스는 reload하지 않는다", () => {
    // Tauri 실측: 창이 처음 포커스를 받을 때 문서가 아직 head를 읽는 중이라 #root가 없었고,
    // 기존 로직(#root 없음 = blank)은 정상 시작인데도 reload했다
    document.body.innerHTML = "";
    const h = harness();
    h.reloaded(() => {});
    h.wait(300);
    h.check();
    expect(h.reloads).toHaveLength(0);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("정상 복구 후: 60초 뒤 정상 화면이 확인되면 카운터를 비우고, 이후 blank는 다시 복구한다", () => {
    blankPage();
    const h = harness();
    h.check(); // reload 1
    h.reloaded(appPage);
    h.wait(5_000);
    h.check(); // 정상이지만 60초 전 — 아직 유지
    expect(stored()?.count).toBe(1);
    h.wait(60_000);
    h.check(); // 정상 + 60초 경과 → 회복 확인
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    // 나중에 렌더러가 다시 날아가도 복구 예산이 새로 생긴다
    blankPage();
    h.check();
    expect(h.reloads).toHaveLength(2);
    expect(stored()?.count).toBe(1);
  });

  it("React가 잠깐 마운트됐다는 것(60초 미만)만으로는 카운터를 비우지 않는다", () => {
    blankPage();
    const h = harness();
    for (let i = 0; i < 2; i++) {
      h.check();
      h.reloaded(appPage); // 잠깐 그렸다가
      h.wait(20_000);
      h.check(); // 정상 화면 관측(60초 미만)
      blankPage(); // 다시 깨짐
      h.wait(20_000);
    }
    expect(stored()?.count).toBe(2);
  });
});

describe("셸 blank 복구 — 무한 루프 방지", () => {
  function brokenBundleLoop(h: ReturnType<typeof harness>, checks: number) {
    blankPage();
    for (let i = 0; i < checks; i++) {
      const before = h.reloads.length;
      h.check();
      if (h.reloads.length > before) h.reloaded();
      h.wait(15_000);
    }
  }

  it("첫 JS 번들 404: 자동 reload는 최대 3회", () => {
    const h = harness();
    brokenBundleLoop(h, 10);
    expect(h.reloads).toHaveLength(3);
  });

  it("4번째 blank 감지 때 reload 대신 오류 안내를 직접 그린다 (React 없이)", () => {
    const h = harness();
    brokenBundleLoop(h, 4);
    expect(h.reloads).toHaveLength(3);
    const n = notice();
    expect(n).not.toBeNull();
    expect(n!.textContent).toContain("앱 화면을 불러오지 못했습니다");
    expect(n!.textContent).toContain("앱을 완전히 종료한 뒤 다시 실행해 주세요");
    expect(n!.textContent).toContain("업데이트 또는 재설치");
    expect(n!.getAttribute("role")).toBe("alert");
    // 재시도를 부르는 버튼 없음, "시작 중" 로더는 치움, #root는 더 이상 비어 있지 않음
    expect(n!.querySelector("button")).toBeNull();
    expect(document.getElementById("boot-loader")).toBeNull();
    expect(document.getElementById("root")!.hasChildNodes()).toBe(true);
    expect(stored()?.blocked).toBe(true);
  });

  it("focus/reopen을 아무리 반복해도 제한을 우회하지 못한다 (가동 시간 리셋 포함)", () => {
    const h = harness();
    blankPage();
    for (let i = 0; i < 50; i++) {
      const before = h.reloads.length;
      h.check();
      if (h.reloads.length > before) h.reloaded();
      h.wait(i % 2 ? 500 : 11_000); // 부팅 유예 안팎을 섞어서
    }
    expect(h.reloads).toHaveLength(3);
    expect(notice()).not.toBeNull();
  });

  it("오류 안내가 뜬 뒤에는 자동 reload 0회", () => {
    const h = harness();
    brokenBundleLoop(h, 4);
    const before = h.reloads.length;
    for (let i = 0; i < 20; i++) {
      h.check();
      h.wait(30_000);
    }
    expect(h.reloads.length).toBe(before);
  });

  it("60초가 지나도(10분, 1시간) 차단 상태는 자동 해제되지 않는다", () => {
    const h = harness();
    brokenBundleLoop(h, 4);
    expect(stored()?.blocked).toBe(true);
    // 사용자가 Cmd+R 등으로 새 문서를 띄워도(여전히 깨진 번들) 다시 reload하지 않는다
    for (const gap of [61_000, 600_000, 3_600_000]) {
      h.reloaded();
      h.wait(gap);
      h.check();
    }
    expect(h.reloads).toHaveLength(3);
    expect(stored()?.blocked).toBe(true);
    expect(notice()).not.toBeNull();
  });

  it("60초 구간이 지난 뒤의 blank도 정상 화면 확인 전에는 새 예산을 주지 않는다 (60초마다 무한 재시도 없음)", () => {
    const h = harness();
    blankPage();
    for (let i = 0; i < 10; i++) {
      const before = h.reloads.length;
      h.check();
      if (h.reloads.length > before) h.reloaded();
      h.wait(70_000);
    }
    expect(h.reloads).toHaveLength(3);
  });

  it.each([
    ["JSON 아님", "{not json"],
    ["배열", "[1,2,3]"],
    ["음수 횟수", JSON.stringify({ v: 1, count: -1, firstAt: T0, lastAt: T0, blocked: false })],
    ["거대한 횟수", JSON.stringify({ v: 1, count: 1e9, firstAt: T0, lastAt: T0, blocked: false })],
    ["소수 횟수", JSON.stringify({ v: 1, count: 1.5, firstAt: T0, lastAt: T0, blocked: false })],
    ["시각 누락", JSON.stringify({ v: 1, count: 1, blocked: false })],
    ["blocked 문자열", JSON.stringify({ v: 1, count: 1, firstAt: T0, lastAt: T0, blocked: "no" })],
  ])("저장 값 손상(%s): reload하지 않고 안내를 띄운다", (_label, raw) => {
    window.sessionStorage.setItem(KEY, raw);
    blankPage();
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.check();
      h.wait(15_000);
    }
    expect(h.reloads).toHaveLength(0);
    expect(notice()).not.toBeNull();
  });

  it.each([
    [
      "sessionStorage 접근 자체가 throw",
      () => {
        throw new DOMException("denied", "SecurityError");
      },
    ],
    [
      "getItem throw",
      () => ({ ...window.sessionStorage, getItem: () => { throw new Error("x"); }, setItem: () => {} }) as unknown as Storage,
    ],
    [
      "setItem throw (quota)",
      () => ({ getItem: () => null, setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem: () => {} }) as unknown as Storage,
    ],
    [
      "setItem이 조용히 무시됨",
      () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }) as unknown as Storage,
    ],
  ])("저장소 접근 실패(%s): 무제한 reload 대신 안내 (예외로 중단되지 않음)", (_label, storage) => {
    blankPage();
    const h = harness({ storage: storage as () => Storage });
    for (let i = 0; i < 5; i++) {
      expect(() => h.check()).not.toThrow();
      h.wait(15_000);
    }
    expect(h.reloads).toHaveLength(0);
    expect(notice()).not.toBeNull();
  });
});

describe("셸 blank 복구 — 경계 조건", () => {
  it("복구 횟수는 reload를 부르기 전에 기록된다", () => {
    blankPage();
    const h = harness();
    h.check();
    expect(h.reloads[0].stored).not.toBeNull();
    expect(JSON.parse(h.reloads[0].stored!)).toMatchObject({ count: 1, firstAt: T0, lastAt: T0, blocked: false });
  });

  it("reload(새 문서) 뒤에도 카운터가 유지되어 이어서 센다", () => {
    const h = harness();
    blankPage();
    h.check();
    h.reloaded();
    h.wait(15_000);
    h.check();
    expect(stored()).toMatchObject({ count: 2, firstAt: T0, lastAt: T0 + 15_000 });
  });

  it("차단 상태여도 정상 화면은 덮어쓰지 않는다", () => {
    window.sessionStorage.setItem(KEY, JSON.stringify({ v: 1, count: 3, firstAt: T0, lastAt: T0, blocked: true }));
    appPage();
    const h = harness();
    h.check();
    expect(notice()).toBeNull();
    expect(document.querySelector("main")!.textContent).toBe("HOME");
    expect(stored()?.blocked).toBe(true); // 자동 해제 없음
  });

  it("부팅 유예가 지난 뒤 #root가 없는 문서도 blank로 보고 같은 예산 안에서만 복구한다", () => {
    const h = harness();
    for (let i = 0; i < 6; i++) {
      document.body.innerHTML = "";
      h.check();
      h.wait(15_000);
    }
    expect(h.reloads).toHaveLength(3);
    expect(notice()).not.toBeNull();
  });
});

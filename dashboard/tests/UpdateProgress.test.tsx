/* v0.7.183+ — 데스크톱 업데이트 진행 상황 시각화.
 *
 * 보고된 증상: 관리 → 업데이트 확인 → "업데이트 실행"을 눌러도 UI가 무반응.
 * 원인은 downloadAndInstall의 진행 이벤트를 아무도 안 듣고 있었던 것.
 *
 * Contract:
 *  1. check() → 새 버전 있으면 phase=available + version/notes
 *  2. check() → 없으면 phase=uptodate
 *  3. install()은 확인 단계의 handle을 재사용 (check 중복 호출 ❌)
 *  4. Started/Progress/Finished → downloading(진행률) → installing → relaunching
 *  5. 실패 시 phase=error + 메시지 보존
 *  6. UpdatePanel이 %/바이트/단계 레일을 실제로 렌더
 */
import { describe, it, expect, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import {
  formatUpdateBytes,
  formatUpdateEta,
  useAppUpdater,
  type UpdateDownloadEvent,
  type UpdateHandle,
  type UpdaterBackend,
} from "../src/lib/useAppUpdater";
import { UpdatePanel } from "../src/components/UpdatePanel";

/** 테스트가 이벤트 발사 시점과 완료 시점을 직접 쥐는 가짜 Update handle. */
function makeHandle(version = "0.3.0", body = "새 기능 3개") {
  let emit: ((e: UpdateDownloadEvent) => void) | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handle: UpdateHandle = {
    version,
    body,
    downloadAndInstall: vi.fn(async (onEvent) => {
      emit = onEvent;
      await done;
    }),
  };
  return {
    handle,
    send: (e: UpdateDownloadEvent) => emit?.(e),
    finish,
  };
}

function makeBackend(check: UpdaterBackend["check"], relaunch = vi.fn(async () => {})) {
  const backend: UpdaterBackend = { check, relaunch };
  return { backend: () => Promise.resolve(backend), relaunch };
}

const OPTS = (backend: () => Promise<UpdaterBackend>) => ({
  backend,
  desktop: true,
  progressThrottleMs: 0, // 테스트에서는 모든 Progress 이벤트를 즉시 반영
});

describe("useAppUpdater (v0.7.183)", () => {
  it("새 버전이 있으면 available + version/notes를 노출한다", async () => {
    const { handle } = makeHandle("0.3.0", "릴리스 노트");
    const check = vi.fn(async () => handle);
    const { backend } = makeBackend(check);
    const { result } = renderHook(() => useAppUpdater(OPTS(backend)));

    await act(async () => {
      await result.current.check();
    });

    expect(result.current.phase).toBe("available");
    expect(result.current.version).toBe("0.3.0");
    expect(result.current.notes).toBe("릴리스 노트");
  });

  it("새 버전이 없으면 uptodate", async () => {
    const { backend } = makeBackend(vi.fn(async () => null));
    const { result } = renderHook(() => useAppUpdater(OPTS(backend)));

    await act(async () => {
      await result.current.check();
    });

    expect(result.current.phase).toBe("uptodate");
    expect(result.current.version).toBeNull();
  });

  it("install()은 확인 단계 handle을 재사용해 check를 다시 부르지 않는다", async () => {
    const { handle, send, finish } = makeHandle();
    const check = vi.fn(async () => handle);
    const { backend, relaunch } = makeBackend(check);
    const { result } = renderHook(() => useAppUpdater(OPTS(backend)));

    await act(async () => {
      await result.current.check();
    });
    expect(check).toHaveBeenCalledTimes(1);

    const installed = act(async () => {
      void result.current.install();
    });
    await installed;

    expect(check).toHaveBeenCalledTimes(1); // 재확인 ❌
    expect(handle.downloadAndInstall).toHaveBeenCalledTimes(1);

    await act(async () => {
      send({ event: "Finished" });
      finish();
    });
    await waitFor(() => expect(relaunch).toHaveBeenCalled());
  });

  it("Started/Progress/Finished를 진행률 → 설치 → 재시작으로 옮긴다", async () => {
    const { handle, send, finish } = makeHandle();
    const { backend, relaunch } = makeBackend(vi.fn(async () => handle));
    const { result } = renderHook(() => useAppUpdater(OPTS(backend)));

    await act(async () => {
      await result.current.check();
    });
    await act(async () => {
      void result.current.install();
    });
    expect(result.current.phase).toBe("downloading");

    await act(async () => {
      send({ event: "Started", data: { contentLength: 1000 } });
    });
    expect(result.current.progress.total).toBe(1000);

    await act(async () => {
      send({ event: "Progress", data: { chunkLength: 250 } });
    });
    expect(result.current.progress.downloaded).toBe(250);
    expect(result.current.progress.percent).toBeCloseTo(25);

    await act(async () => {
      send({ event: "Progress", data: { chunkLength: 250 } });
      send({ event: "Finished" });
    });
    expect(result.current.progress.percent).toBe(100);
    expect(result.current.phase).toBe("installing");

    await act(async () => {
      finish();
    });
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
    expect(result.current.phase).toBe("relaunching");
  });

  it("총량을 모르면 percent는 null로 남는다 (불확정 진행률)", async () => {
    const { handle, send } = makeHandle();
    const { backend } = makeBackend(vi.fn(async () => handle));
    const { result } = renderHook(() => useAppUpdater(OPTS(backend)));

    await act(async () => {
      await result.current.check();
    });
    await act(async () => {
      void result.current.install();
    });
    await act(async () => {
      send({ event: "Started", data: {} });
      send({ event: "Progress", data: { chunkLength: 4096 } });
    });

    expect(result.current.progress.total).toBeNull();
    expect(result.current.progress.percent).toBeNull();
    expect(result.current.progress.downloaded).toBe(4096);
  });

  it("실패하면 phase=error + 메시지 보존", async () => {
    const { backend } = makeBackend(
      vi.fn(async () => {
        throw new Error("네트워크 연결 없음");
      })
    );
    const { result } = renderHook(() => useAppUpdater(OPTS(backend)));

    await act(async () => {
      await result.current.check();
    });

    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("네트워크 연결 없음");
  });

  it("데스크톱이 아니면 아무 것도 하지 않는다", async () => {
    const check = vi.fn(async () => null);
    const { backend } = makeBackend(check);
    const { result } = renderHook(() =>
      useAppUpdater({ backend, desktop: false, autoCheck: true })
    );

    await act(async () => {
      await result.current.check();
    });

    expect(check).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });
});

describe("UpdatePanel (v0.7.183)", () => {
  it("다운로드 중에는 %·바이트·단계 레일을 그린다", async () => {
    const { handle, send } = makeHandle();
    const { backend } = makeBackend(vi.fn(async () => handle));
    const { result } = renderHook(() => useAppUpdater(OPTS(backend)));

    await act(async () => {
      await result.current.check();
    });
    await act(async () => {
      void result.current.install();
    });
    await act(async () => {
      send({ event: "Started", data: { contentLength: 8 * 1024 * 1024 } });
      send({ event: "Progress", data: { chunkLength: 2 * 1024 * 1024 } });
    });

    render(<UpdatePanel state={result.current} currentVersion="0.2.0" />);

    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getByText(/2\.0 MB \/ 8\.0 MB/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    // 3단계 레일 — 다운로드가 현재 단계
    expect(screen.getByText("다운로드")).toBeTruthy();
    expect(screen.getByText("설치")).toBeTruthy();
    expect(screen.getByText("재시작")).toBeTruthy();
  });

  it("available이면 버전 칩 + 설치 버튼을 보여주고 클릭 시 install", async () => {
    const { handle } = makeHandle("0.3.0", "릴리스 노트");
    const { backend } = makeBackend(vi.fn(async () => handle));
    const { result } = renderHook(() => useAppUpdater(OPTS(backend)));

    await act(async () => {
      await result.current.check();
    });

    render(<UpdatePanel state={result.current} currentVersion="0.2.0" />);
    expect(screen.getByText("새 버전을 설치할 수 있습니다")).toBeTruthy();
    expect(screen.getByText("v0.3.0")).toBeTruthy();
    expect(screen.getByText("릴리스 노트")).toBeTruthy();

    await act(async () => {
      screen.getByText("지금 업데이트 및 재실행").click();
    });
    expect(handle.downloadAndInstall).toHaveBeenCalled();
  });

  it("idle이면 아무 것도 렌더하지 않는다", () => {
    const { backend } = makeBackend(vi.fn(async () => null));
    const { result } = renderHook(() => useAppUpdater(OPTS(backend)));
    const { container } = render(<UpdatePanel state={result.current} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("포맷터", () => {
  it("바이트를 사람이 읽는 단위로", () => {
    expect(formatUpdateBytes(512)).toBe("512 B");
    expect(formatUpdateBytes(2048)).toBe("2.0 KB");
    expect(formatUpdateBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("ETA를 한국어로", () => {
    expect(formatUpdateEta(null)).toBeNull();
    expect(formatUpdateEta(0.4)).toBe("곧 완료");
    expect(formatUpdateEta(12)).toBe("약 12초 남음");
    expect(formatUpdateEta(125)).toBe("약 2분 5초 남음");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackupPanel } from "../src/components/BackupPanel";
import { backupFilename, type DialogApi } from "../src/lib/backup";

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function fakeDialog(over: Partial<DialogApi> = {}): DialogApi {
  return { save: vi.fn().mockResolvedValue(null), open: vi.fn().mockResolvedValue(null), ...over };
}

afterEach(() => vi.unstubAllGlobals());

describe("backupFilename", () => {
  it("raven-backup-YYYYMMDD-HHMM.zip", () => {
    expect(backupFilename(new Date(2026, 9, 2, 14, 5))).toBe("raven-backup-20261002-1405.zip");
  });
});

describe("BackupPanel", () => {
  it("내보내기: 고른 경로로 API를 부르고 결과 경로를 보여준다", async () => {
    const fetchSpy = stubFetch(200, { ok: true, path: "/Users/me/b.zip", vaults: [{ name: "a", file_count: 3 }], skipped: [], skipped_files: [] });
    const dialog = fakeDialog({ save: vi.fn().mockResolvedValue("/Users/me/b.zip") });
    render(<BackupPanel dialog={dialog} onImported={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "전체 백업 내보내기" }));
    await screen.findByText(/vault 1개를 백업했습니다/);
    expect(screen.getByText(/\/Users\/me\/b\.zip/)).toBeTruthy();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("/api/backup/export");
    expect(JSON.parse(init.body)).toEqual({ dest_path: "/Users/me/b.zip" });
    expect(dialog.save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^raven-backup-\d{8}-\d{4}\.zip$/),
        filters: [{ name: "Raven 백업", extensions: ["zip"] }],
      }),
    );
  });

  it("내보내기: 확장자가 없으면 .zip을 붙인다", async () => {
    const fetchSpy = stubFetch(200, { ok: true, path: "/x/b.zip", vaults: [], skipped: [], skipped_files: [] });
    render(<BackupPanel dialog={fakeDialog({ save: vi.fn().mockResolvedValue("/x/b") })} onImported={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "전체 백업 내보내기" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).dest_path).toBe("/x/b.zip");
  });

  it("대화상자 취소면 아무 요청도 하지 않는다", async () => {
    const fetchSpy = stubFetch(200, {});
    const dialog = fakeDialog();
    render(<BackupPanel dialog={dialog} onImported={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "백업 가져오기" }));
    await waitFor(() => expect(dialog.open).toHaveBeenCalled());
    expect(dialog.open).toHaveBeenCalledWith(expect.objectContaining({ multiple: false, directory: false }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("가져오기: 결과 표와 비고를 보여주고 onImported를 부른다", async () => {
    stubFetch(200, {
      ok: true,
      default_set: null,
      items: [
        { original: "rider-app", imported_as: "rider-app-2", renamed: true, workspace_reset: true, build_failed: false, error: null },
        { original: "hub", imported_as: null, renamed: false, workspace_reset: false, build_failed: false, error: "disk full" },
      ],
    });
    const onImported = vi.fn();
    render(<BackupPanel dialog={fakeDialog({ open: vi.fn().mockResolvedValue("/x/b.zip") })} onImported={onImported} />);
    fireEvent.click(screen.getByRole("button", { name: "백업 가져오기" }));
    await screen.findByText("rider-app-2");
    expect(screen.getByText(/같은 이름이 있어 이름을 바꿈/)).toBeTruthy();
    expect(screen.getByText(/workspace 다시 연결 필요/)).toBeTruthy();
    expect(screen.getByText(/disk full/)).toBeTruthy();
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("API 오류 detail을 보여준다", async () => {
    stubFetch(403, { detail: "백업 내보내기·가져오기는 이 PC에서만 할 수 있습니다" });
    render(<BackupPanel dialog={fakeDialog({ save: vi.fn().mockResolvedValue("/x/b.zip") })} onImported={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "전체 백업 내보내기" }));
    await screen.findByText(/이 PC에서만/);
  });
});

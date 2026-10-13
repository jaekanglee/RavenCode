/* Issue #2 B-4 — raw/ 새 파일 다이얼로그 단일 구현 + 비동기 가드.
 *
 * 수정 전: 같은 UI가 3곳에 복붙돼 있었고(RawPanel 비어 있는 분기, RawPanel 일반
 * 분기, Sidebar NewRawFileButton) 단순 중복이 아니라 *비동기 보호 정책이 갈라져*
 * 있었다. Sidebar만 busy 가드 · backdrop 닫기 차단 · "만드는 중…" 표시가 있었고
 * RawPanel 두 복사본에는 없었다 → 저장 중 backdrop 클릭으로 닫히고, 그 사이
 * writeRaw가 실패하면 오류가 사라졌다.
 *
 * 이 테스트는 그 갈라짐이 실제로 사라졌는지를 *동작*으로 검증한다:
 * RawPanel 경로에서도 (1) 저장 중 버튼이 잠기고, (2) backdrop 클릭이 닫지 않는다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RawPanel } from "../src/routes/RawPanel";
import * as api from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  fetchRawList: vi.fn(),
  fetchRawContent: vi.fn(),
  writeRaw: vi.fn(),
  deleteRaw: vi.fn(),
}));

function renderEmptyRawPanel() {
  return render(
    <MemoryRouter initialEntries={["/raw/raven-dev"]}>
      <Routes>
        <Route path="/raw/:vault/*" element={<RawPanel />} />
      </Routes>
    </MemoryRouter>
  );
}

async function openDialogAndSubmit(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: /새 파일/ }));
  const input = (await screen.findByLabelText(/^파일명/)) as HTMLInputElement;
  fireEvent.change(input, { target: { value: name } });
  // submit은 async — 실패/성공으로 이어지는 state 갱신을 act 안에서 소진한다.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "만들기" }));
  });
}

describe("RawPanel raw/ 새 파일 다이얼로그 (Issue #2 B-4)", () => {
  beforeEach(() => {
    vi.mocked(api.fetchRawList).mockResolvedValue({
      ok: true,
      vault: "raven-dev",
      root: "raw",
      items: [],
    });
  });

  it("빈 raw/ 에서도 공통 다이얼로그를 띄운다", async () => {
    renderEmptyRawPanel();
    fireEvent.click(await screen.findByRole("button", { name: /새 파일/ }));
    expect(await screen.findByLabelText(/^파일명/)).toBeTruthy();
    expect(screen.getByLabelText(/^부모 디렉토리/)).toBeTruthy();
  });

  it("저장 중에는 버튼이 잠기고 '만드는 중…'으로 바뀐다", async () => {
    let resolveWrite!: (v: Awaited<ReturnType<typeof api.writeRaw>>) => void;
    vi.mocked(api.writeRaw).mockImplementation(
      () => new Promise((res) => { resolveWrite = res; })
    );

    renderEmptyRawPanel();
    await openDialogAndSubmit("slow.md");

    const busyBtn = await screen.findByRole("button", { name: "만드는 중…" });
    expect((busyBtn as HTMLButtonElement).disabled).toBe(true);

    resolveWrite({ ok: true, path: "raw/slow.md", size: 0, existed: false });
    await waitFor(() => expect(api.writeRaw).toHaveBeenCalledTimes(1));
  });

  it("저장 중 backdrop 클릭은 다이얼로그를 닫지 않는다", async () => {
    vi.mocked(api.writeRaw).mockImplementation(() => new Promise(() => {}));

    renderEmptyRawPanel();
    await openDialogAndSubmit("slow.md");
    await screen.findByRole("button", { name: "만드는 중…" });

    // Modal의 backdrop은 .card 래퍼의 부모(fixed overlay)다. 클릭해도 닫히면 안 된다.
    const card = screen.getByLabelText(/^파일명/).closest(".card");
    expect(card).toBeTruthy();
    fireEvent.click(card!.parentElement!);

    expect(screen.getByLabelText(/^파일명/)).toBeTruthy();
  });

  it("실패하면 다이얼로그를 열어 둔 채 오류를 보여준다", async () => {
    vi.mocked(api.writeRaw).mockRejectedValue(new Error("permission denied"));

    renderEmptyRawPanel();
    await openDialogAndSubmit("boom.md");

    expect(await screen.findByText(/permission denied/)).toBeTruthy();
    // busy 해제까지 기다린 뒤에도 다이얼로그가 남아 있어야 한다 (오류가 사라지지 않음).
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "만들기" }) as HTMLButtonElement).disabled).toBe(false)
    );
    expect(screen.getByText(/permission denied/)).toBeTruthy();
    expect(screen.getByLabelText(/^파일명/)).toBeTruthy();
  });
});

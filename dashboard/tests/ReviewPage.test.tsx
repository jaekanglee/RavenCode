/* 초안 검토 대기 화면 (spec 2026-10-20-draft-review-queue-design).
 *
 *  1) 목록을 보이고, 고른 것만 precondition 없이 승인한다
 *  2) 승인 뒤 결과를 알리고 목록을 다시 불러온다
 *  3) 비면 빈 상태, 손님 탭이면 안내만 (API를 부르지 않는다)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const guest = vi.hoisted(() => ({ on: false }));
vi.mock("../src/lib/guest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/guest")>()),
  isGuestTab: () => guest.on,
}));

import { ReviewPage } from "../src/routes/ReviewPage";

type Reply = { status: number; body: unknown };

function stubFetch(replies: Reply[]) {
  const queue = [...replies];
  const spy = vi.fn().mockImplementation(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/review/v1"]}>
      <Routes>
        <Route path="/review/:vault" element={<ReviewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const A = { slug: "content/a", title: "결제 정산", type: "concept", created: "", updated: "2026-10-16", last_agent: "claude" };
const B = { slug: "content/b", title: "실시간 통신", type: "concept", created: "", updated: "2026-10-15", last_agent: null };

afterEach(() => {
  guest.on = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReviewPage", () => {
  it("고른 초안만 승인하고 결과를 알린 뒤 목록을 다시 불러온다", async () => {
    const spy = stubFetch([
      { status: 200, body: { ok: true, vault: "v1", drafts: [A, B] } },
      { status: 200, body: { ok: true, results: [{ slug: "content/a", result: "approved" }] } },
      { status: 200, body: { ok: true, vault: "v1", drafts: [B] } },
    ]);
    renderPage();

    expect(await screen.findByRole("heading", { name: "검토 대기 2" })).toBeTruthy();
    expect(screen.getByText("claude")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "결제 정산 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "선택 승인 (1)" }));

    expect(await screen.findByText("✅ 1건 승인")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("heading", { name: "검토 대기 1" })).toBeTruthy());
    const [url, init] = spy.mock.calls[1];
    expect(String(url)).toContain("/api/vaults/v1/review/approve");
    expect(JSON.parse(String(init?.body))).toEqual({ items: [{ slug: "content/a" }] });
  });

  it("전체 선택은 모든 초안을 고른다", async () => {
    stubFetch([{ status: 200, body: { ok: true, vault: "v1", drafts: [A, B] } }]);
    renderPage();

    fireEvent.click(await screen.findByRole("checkbox", { name: "전체 선택" }));

    expect(screen.getByRole("button", { name: "선택 승인 (2)" })).toBeTruthy();
  });

  it("아무것도 고르지 않으면 승인 버튼이 꺼져 있다", async () => {
    stubFetch([{ status: 200, body: { ok: true, vault: "v1", drafts: [A] } }]);
    renderPage();

    const button = (await screen.findByRole("button", { name: "선택 승인 (0)" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("초안이 없으면 빈 상태를 보인다", async () => {
    stubFetch([{ status: 200, body: { ok: true, vault: "v1", drafts: [] } }]);
    renderPage();

    expect(await screen.findByText("검토할 초안이 없습니다")).toBeTruthy();
  });

  it("손님 탭이면 안내만 보이고 API를 부르지 않는다", () => {
    guest.on = true;
    const spy = stubFetch([]);
    renderPage();

    expect(screen.getByText("검토와 승인은 운영자만 할 수 있습니다")).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});

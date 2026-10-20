/* 문서 상단 초안 배너 (spec 2026-10-20-draft-review-queue-design).
 *
 *  1) 승인은 읽을 때 받은 precondition을 싣는다
 *  2) 승인되면 onApproved — 부모가 문서를 다시 불러온다
 *  3) 읽은 뒤 바뀌었으면 승인하지 않고 다시 확인하라고 말한다
 *  4) 운영자가 아니면 승인 버튼이 없다
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DraftReviewBanner } from "../src/components/DraftReviewBanner";

function stubFetch(body: unknown, status = 200) {
  const spy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DraftReviewBanner", () => {
  it("precondition을 실어 승인하고 onApproved를 부른다", async () => {
    const spy = stubFetch({ ok: true, results: [{ slug: "결제-정산", result: "approved" }] });
    const onApproved = vi.fn();
    render(<DraftReviewBanner vault="v1" slug="결제-정산" precondition="sha256-x" canApprove onApproved={onApproved} />);

    fireEvent.click(screen.getByRole("button", { name: "승인" }));

    await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/api/vaults/v1/review/approve");
    expect(JSON.parse(String(init?.body))).toEqual({ items: [{ slug: "결제-정산", precondition: "sha256-x" }] });
  });

  it("읽은 뒤 바뀌었으면 승인하지 않고 다시 확인하라고 말한다", async () => {
    stubFetch({ ok: true, results: [{ slug: "결제-정산", result: "stale_precondition" }] });
    const onApproved = vi.fn();
    render(<DraftReviewBanner vault="v1" slug="결제-정산" precondition="sha256-old" canApprove onApproved={onApproved} />);

    fireEvent.click(screen.getByRole("button", { name: "승인" }));

    expect(await screen.findByText(/읽은 뒤 내용이 바뀌었습니다/)).toBeTruthy();
    expect(onApproved).not.toHaveBeenCalled();
  });

  it("운영자가 아니면 안내만 있고 승인 버튼이 없다", () => {
    render(<DraftReviewBanner vault="v1" slug="결제-정산" canApprove={false} onApproved={() => {}} />);

    expect(screen.getByText("에이전트가 쓴 초안입니다 · 검토 대기")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "승인" })).toBeNull();
  });
});

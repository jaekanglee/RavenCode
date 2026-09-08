/* ShareButton — 공유 링크 복사 계약.
 *
 * 배경 (2026-09-08): "Tailscale 링크를 복사했는데 내부망 IP가 붙는다"는 보고.
 * 코드상 Tailscale 행은 tailscale_api 로 URL을 만들지만, 클립보드 쓰기가
 * 실패해도 "✅ 복사됨!" 을 띄웠기 때문에 직전에 복사한 내부망 링크가 그대로
 * 남아 있어도 성공처럼 보였다.
 *
 * Contract:
 *  1. Tailscale 행 복사 → clipboard 에 tailscale_api 기반 URL 이 쓰인다.
 *  2. 내부망 행 복사 → lan_api 기반 URL.
 *  3. clipboard 쓰기가 실패하면 "복사됨" 대신 실패 상태를 보여준다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../src/lib/api", () => ({
  fetchSystemInfo: vi.fn(async () => ({
    ok: true,
    tailscale_ip: "100.116.203.33",
    lan_ip: "10.10.80.75",
    local_api: "http://127.0.0.1:8765",
    local_mcp: "http://127.0.0.1:8765/mcp",
    lan_api: "http://10.10.80.75:8765",
    tailscale_api: "http://100.116.203.33:8765",
    tailscale_mcp: "http://100.116.203.33:8765/mcp",
    bind_host: "0.0.0.0",
    allow_all_cors: false,
    port: 8765,
  })),
}));

import { ShareButton } from "../src/components/ShareButton";

function stubClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

async function openPopover() {
  render(<ShareButton vault="hub-control-room" slug="content/journal/demo" />);
  fireEvent.click(screen.getByRole("button", { name: "공유" }));
  await screen.findByRole("button", { name: "Tailscale 링크 복사" });
}

describe("ShareButton copy contract", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("Tailscale 행은 tailscale_api 기반 URL을 클립보드에 쓴다", async () => {
    const writeText = vi.fn(async (_t: string) => {});
    stubClipboard(writeText);
    await openPopover();

    fireEvent.click(screen.getByRole("button", { name: "Tailscale 링크 복사" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      "http://100.116.203.33:8765/page/hub-control-room/content/journal/demo",
    );
    await screen.findByText("✅ 복사됨!");
  });

  it("내부망 행은 lan_api 기반 URL을 클립보드에 쓴다", async () => {
    const writeText = vi.fn(async (_t: string) => {});
    stubClipboard(writeText);
    await openPopover();

    fireEvent.click(screen.getByRole("button", { name: "내부망 링크 복사" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      "http://10.10.80.75:8765/page/hub-control-room/content/journal/demo",
    );
  });

  it("클립보드 쓰기가 실패하면 '복사됨'을 띄우지 않고 실패를 알린다", async () => {
    stubClipboard(vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    }));
    // 폴백(execCommand) 도 실패하는 환경을 가정
    (document as any).execCommand = vi.fn(() => false);
    await openPopover();

    fireEvent.click(screen.getByRole("button", { name: "Tailscale 링크 복사" }));

    const tsButton = screen.getByRole("button", { name: "Tailscale 링크 복사" });
    await waitFor(() => expect(tsButton.textContent).toContain("복사 실패"));
    expect(screen.getByText(/직접 선택해 복사/)).toBeTruthy();
    expect(screen.queryByText("✅ 복사됨!")).toBeNull();
  });
});

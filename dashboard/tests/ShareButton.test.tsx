import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareButton } from "../src/components/ShareButton";
import * as api from "../src/lib/api";

describe("ShareButton", () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  });

  it("클릭하면 팝오버가 열리고 내부망/Tailscale 링크가 렌더된다", async () => {
    vi.spyOn(api, "fetchSystemInfo").mockResolvedValue({
      ok: true,
      tailscale_ip: "100.64.1.2",
      lan_ip: "192.168.1.42",
      local_api: "http://127.0.0.1:8765",
      local_mcp: "http://127.0.0.1:8765/mcp",
      lan_api: "http://192.168.1.42:8765",
      tailscale_api: "http://100.64.1.2:8765",
      tailscale_mcp: "http://100.64.1.2:8765/mcp",
      bind_host: "0.0.0.0",
      allow_all_cors: false,
      port: 8765,
    });

    render(<ShareButton vault="hub-control-room" slug="concepts/foo" />);
    fireEvent.click(screen.getByRole("button", { name: /공유/ }));

    await waitFor(() => {
      expect(
        screen.getByText("http://192.168.1.42:8765/page/hub-control-room/concepts/foo")
      ).toBeTruthy();
      expect(
        screen.getByText("http://100.64.1.2:8765/page/hub-control-room/concepts/foo")
      ).toBeTruthy();
    });
  });

  it("IP가 감지되지 않으면 해당 행이 비활성 상태로 렌더된다", async () => {
    vi.spyOn(api, "fetchSystemInfo").mockResolvedValue({
      ok: true,
      tailscale_ip: null,
      lan_ip: null,
      local_api: "http://127.0.0.1:8765",
      local_mcp: "http://127.0.0.1:8765/mcp",
      lan_api: null,
      tailscale_api: null,
      tailscale_mcp: null,
      bind_host: "127.0.0.1",
      allow_all_cors: false,
      port: 8765,
    });

    render(<ShareButton vault="hub-control-room" slug="concepts/foo" />);
    fireEvent.click(screen.getByRole("button", { name: /공유/ }));

    await waitFor(() => {
      expect(screen.getByText(/내부망 IP 감지 안 됨/)).toBeTruthy();
      expect(screen.getByText(/Tailscale IP 감지 안 됨/)).toBeTruthy();
    });
  });

  it("복사 버튼 클릭 시 clipboard.writeText가 올바른 URL로 호출된다", async () => {
    vi.spyOn(api, "fetchSystemInfo").mockResolvedValue({
      ok: true,
      tailscale_ip: null,
      lan_ip: "192.168.1.42",
      local_api: "http://127.0.0.1:8765",
      local_mcp: "http://127.0.0.1:8765/mcp",
      lan_api: "http://192.168.1.42:8765",
      tailscale_api: null,
      tailscale_mcp: null,
      bind_host: "0.0.0.0",
      allow_all_cors: false,
      port: 8765,
    });

    render(<ShareButton vault="hub-control-room" slug="concepts/foo" />);
    fireEvent.click(screen.getByRole("button", { name: /공유/ }));

    await waitFor(() => screen.getByLabelText("내부망 링크 복사"));
    fireEvent.click(screen.getByLabelText("내부망 링크 복사"));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "http://192.168.1.42:8765/page/hub-control-room/concepts/foo"
    );
  });

  it("바깥을 클릭하면 팝오버가 닫힌다", async () => {
    vi.spyOn(api, "fetchSystemInfo").mockResolvedValue({
      ok: true,
      tailscale_ip: "100.64.1.2",
      lan_ip: "192.168.1.42",
      local_api: "http://127.0.0.1:8765",
      local_mcp: "http://127.0.0.1:8765/mcp",
      lan_api: "http://192.168.1.42:8765",
      tailscale_api: "http://100.64.1.2:8765",
      tailscale_mcp: "http://100.64.1.2:8765/mcp",
      bind_host: "0.0.0.0",
      allow_all_cors: false,
      port: 8765,
    });

    render(<ShareButton vault="hub-control-room" slug="concepts/foo" />);
    fireEvent.click(screen.getByRole("button", { name: /공유/ }));
    await waitFor(() => screen.getByLabelText("내부망 링크 복사"));

    fireEvent.mouseDown(document.body);

    await waitFor(() => {
      expect(screen.queryByLabelText("내부망 링크 복사")).toBeNull();
    });
  });

  // 회귀 가드: Layout의 <main overflow-hidden> / .page-content overflow-y-auto 안에서
  // position:absolute 팝오버가 사이드바 경계에 잘리던 버그.
  // 프로젝트 규약(Modal-portal.test.tsx, v0.6.18+): 오버레이는 document.body 포털 + position:fixed.
  it("팝오버는 document.body 직속 portal + position:fixed로 렌더된다 (overflow 클리핑 회귀 가드)", async () => {
    vi.spyOn(api, "fetchSystemInfo").mockResolvedValue({
      ok: true,
      tailscale_ip: "100.64.1.2",
      lan_ip: "192.168.1.42",
      local_api: "http://127.0.0.1:8765",
      local_mcp: "http://127.0.0.1:8765/mcp",
      lan_api: "http://192.168.1.42:8765",
      tailscale_api: "http://100.64.1.2:8765",
      tailscale_mcp: "http://100.64.1.2:8765/mcp",
      bind_host: "0.0.0.0",
      allow_all_cors: false,
      port: 8765,
    });

    const { container } = render(<ShareButton vault="hub-control-room" slug="concepts/foo" />);
    fireEvent.click(screen.getByRole("button", { name: /공유/ }));
    const copyBtn = await waitFor(() => screen.getByLabelText("내부망 링크 복사"));

    const popover = copyBtn.closest('[data-testid="share-popover"]') as HTMLElement | null;
    expect(popover).toBeTruthy();
    // 툴바 래퍼(overflow 조상 안) 밖으로 나가 있어야 한다
    expect(container.contains(popover!)).toBe(false);
    // 포털 대상은 document.body 직속
    expect(popover!.parentElement).toBe(document.body);
    // containing block 영향을 받지 않도록 fixed
    expect(popover!.getAttribute("style") || "").toMatch(/position:\s*fixed/);
  });

  it("팝오버 내부를 mousedown해도 닫히지 않는다 (portal 이후 outside-click 오인 방지)", async () => {
    vi.spyOn(api, "fetchSystemInfo").mockResolvedValue({
      ok: true,
      tailscale_ip: null,
      lan_ip: "192.168.1.42",
      local_api: "http://127.0.0.1:8765",
      local_mcp: "http://127.0.0.1:8765/mcp",
      lan_api: "http://192.168.1.42:8765",
      tailscale_api: null,
      tailscale_mcp: null,
      bind_host: "0.0.0.0",
      allow_all_cors: false,
      port: 8765,
    });

    render(<ShareButton vault="hub-control-room" slug="concepts/foo" />);
    fireEvent.click(screen.getByRole("button", { name: /공유/ }));
    const copyBtn = await waitFor(() => screen.getByLabelText("내부망 링크 복사"));

    fireEvent.mouseDown(copyBtn);
    fireEvent.click(copyBtn);

    expect(screen.queryByLabelText("내부망 링크 복사")).not.toBeNull();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "http://192.168.1.42:8765/page/hub-control-room/concepts/foo"
    );
  });
});

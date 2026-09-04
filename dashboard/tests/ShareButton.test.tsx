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
});

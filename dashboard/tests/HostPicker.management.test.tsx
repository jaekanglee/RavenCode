import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

beforeEach(() => { vi.resetModules(); localStorage.clear(); sessionStorage.clear(); });
afterEach(cleanup);

async function mount(management = false) {
  const { HostPicker } = await import("../src/components/HostPicker");
  const reload = vi.fn();
  const onNavigate = vi.fn();
  render(<MemoryRouter><HostPicker management={management} reload={reload} onNavigate={onNavigate} /></MemoryRouter>);
  return { reload, onNavigate };
}

describe("HostPicker management boundary", () => {
  it("sidebar retains switching and status without registration controls", async () => {
    localStorage.setItem("raven:hosts", JSON.stringify([
      { id: "local", name: "Local", endpoint: "", isLocal: true },
      { id: "b", name: "Remote", endpoint: "http://100.64.0.2:8765", isLocal: false },
    ]));
    const { reload, onNavigate } = await mount();
    const select = screen.getByRole("combobox", { name: "호스트 PC 선택" });
    expect(select.closest("details")?.open).toBe(false);
    expect(screen.queryByTitle("새 호스트 연결 추가")).toBeNull();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/vault/manage#hosts");
    fireEvent.click(screen.getByRole("link"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    fireEvent.change(select, { target: { value: "b" } });
    expect(localStorage.getItem("raven:active_host")).toBe("b");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("management offers registration in a keyboard-dismissable portal", async () => {
    await mount(true);
    const trigger = screen.getByTitle("새 호스트 연결 추가");
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    expect(dialog.closest(".card")?.parentElement?.parentElement).toBe(document.body);
    expect(screen.getByLabelText(/^접근 토큰/).getAttribute("type")).toBe("password");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

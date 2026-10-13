/* Issue #18 — 관리 화면이 코어(Core)와 셸(Shell) 버전을 구분해 보여준다.
 *
 * 배경: 버전이 4곳에 흩어져 있었고(tauri.conf.json/Cargo.toml 0.3.x,
 * dashboard/package.json 0.1.0, raven/__init__.py 0.7.x) 사용자에게는 셸 버전만
 * "현재 버전"이라는 이름으로 보였다 — Python Core 버전은 어디에도 없었다.
 *
 * 결정: 통일하지 않고 라벨로 구분한다(코어/셸). 이 파일은 그 계약을 고정한다.
 *   - 코어 버전은 /api/system/info 응답값을 그대로 그린다 (하드코딩 아님).
 *   - 코어와 셸은 서로 다른 라벨을 쓴다. 애매한 "현재 버전" 표기는 남기지 않는다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import VaultManageSrc from "../src/routes/VaultManage.tsx?raw";
import { VaultManage } from "../src/routes/VaultManage";

/** 실제 릴리스 값(0.7.x)과 절대 겹치지 않는 값 — 하드코딩이면 이 테스트가 잡는다. */
const CORE_VERSION_FROM_API = "9.9.9";

function stubApi(coreVersion: string) {
  const urls: string[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    let body: unknown;
    if (url.includes("/api/system/info")) {
      body = {
        ok: true,
        core_version: coreVersion,
        tailscale_ip: null,
        lan_ip: null,
        local_api: "http://127.0.0.1:8765",
        local_mcp: "http://127.0.0.1:8766/mcp",
        lan_api: null,
        tailscale_api: null,
        tailscale_mcp: null,
        bind_host: "127.0.0.1",
        allow_all_cors: false,
        port: 8765,
      };
    } else if (url.includes("/stats")) {
      body = { ok: true, pages: 3, size_bytes: 1024, broken_links: 0 };
    } else {
      body = { ok: true, vaults: [{ name: "v1", path: "/tmp/v1", mode: "personal", default: true }] };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VaultManage 버전 표면 (Issue #18)", () => {
  it("코어 버전을 API 응답값 그대로 '코어(Core)' 라벨로 표시한다", async () => {
    const urls = stubApi(CORE_VERSION_FROM_API);
    render(
      <MemoryRouter initialEntries={["/vault/manage"]}>
        <VaultManage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(`v${CORE_VERSION_FROM_API}`)).toBeTruthy();
    expect(screen.getByText(/코어\(Core\) 버전/)).toBeTruthy();
    await waitFor(() => expect(urls.some((u) => u.includes("/api/system/info"))).toBe(true));
  });

  it("셸 버전은 코어와 다른 라벨을 쓰고, 애매한 '현재 버전' 표기를 남기지 않는다", () => {
    expect(VaultManageSrc).toContain("셸(Shell) 버전");
    expect(VaultManageSrc).not.toContain("현재 버전");
    // 셸 버전은 셸 IPC(app_version)에서만 온다 — 대시보드에 리터럴로 박지 않는다.
    expect(VaultManageSrc).toContain('invoke("app_version")');
  });

  it("대시보드 번들 버전(0.1.0)을 사용자 버전으로 그리지 않는다", () => {
    expect(VaultManageSrc).not.toMatch(/0\.1\.0/);
  });
});

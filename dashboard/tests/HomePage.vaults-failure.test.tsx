/* Issue #30 — HomePage도 fetchVaults 실패를 "vault 0개"로 오인하지 않는다.
 *
 * fetchVaults는 이제 실패 시 reject한다. HomePage가 이를 잡지 않으면 loading이
 * 영영 "불러오는 중…"에 머물고, []로 삼키면 "첫 vault 만들기" CTA가 뜬다 — 둘 다 오답.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const fetchVaultsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchVaults: fetchVaultsMock,
    fetchPages: vi.fn(async () => []),
    getActiveVault: vi.fn(() => ""),
    setActiveVault: vi.fn(),
  };
});

import { HomePage } from "../src/routes/HomePage";
import { ApiHttpError } from "../src/lib/api";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchVaultsMock.mockReset();
});

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

describe("HomePage — vault 목록 실패 (Issue #30)", () => {
  it("fetchVaults reject 시 실패를 표시하고 '첫 vault 만들기'를 띄우지 않는다", async () => {
    fetchVaultsMock.mockRejectedValue(new ApiHttpError(503, "/api/vaults"));
    renderHome();
    expect(await screen.findAllByText("보관소 목록을 불러오지 못했습니다.")).not.toHaveLength(0);
    expect(screen.queryByText(/첫 vault 만들기/)).toBeNull();
    expect(screen.queryByText("불러오는 중…")).toBeNull();
  });

  it("성공한 빈 목록이면 기존대로 '첫 vault 만들기'", async () => {
    fetchVaultsMock.mockResolvedValue([]);
    renderHome();
    expect(await screen.findByText(/첫 vault 만들기/)).toBeTruthy();
    expect(screen.queryByText("보관소 목록을 불러오지 못했습니다.")).toBeNull();
  });
});

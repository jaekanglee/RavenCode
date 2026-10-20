/* P1 회귀 가드 — 홈은 vault 운영 콘솔이 아니라 오늘의 작업대다.
 *  1. 최근 문서는 updated 내림차순, 손볼 문서는 stale·contested만
 *  2. test/tmp 스크래치 vault는 사람용 목록에서 기본 숨김 (토글로만 노출)
 *  3. 활성 vault가 있으면 최근/손볼 문서 큐가 보관소 목록보다 먼저 온다
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/lib/api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchVaults: vi.fn(async () => [
      { name: "raven-dev", path: "/Users/me/Raven/raven-dev", mode: "agent", owner: "u", default: true },
      { name: "test-vault", path: "/Users/me/Raven/test-vault", mode: "agent", owner: "u", default: false },
      { name: "scratch", path: "/tmp/scratch", mode: "agent", owner: "u", default: false },
    ]),
    fetchPages: vi.fn(async () => [
      { slug: "content/old", title: "오래된 노트", type: "note", status: "current", updated: "2026-05-01" },
      { slug: "content/fresh", title: "어제 쓴 노트", type: "note", status: "current", updated: "2026-07-29" },
      { slug: "content/stale-one", title: "검증 필요", type: "concept", status: "stale", updated: "2026-04-02" },
      { slug: "content/clash", title: "모순 발견", type: "concept", status: "contested", updated: "2026-07-10" },
      { slug: "content/gone", title: "격리됨", type: "note", status: "archived", updated: "2026-07-28" },
    ]),
    getActiveVault: vi.fn(() => "raven-dev"),
    setActiveVault: vi.fn(),
  };
});

import {
  HomePage,
  isScratchVault,
  pickRecentPages,
  pickUnfinishedPages,
  type HomePageSummary,
} from "../src/routes/HomePage";

const PAGES: HomePageSummary[] = [
  { slug: "a", title: "A", status: "current", updated: "2026-01-01" },
  { slug: "b", title: "B", status: "stale", updated: "2026-07-20" },
  { slug: "c", title: "C", status: "contested", updated: "2026-03-05" },
  { slug: "d", title: "D", status: "archived", updated: "2026-07-30" },
  { slug: "f", title: "F", status: "draft", updated: "2026-02-01" },
  { slug: "e", title: "E", status: "current" },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, pages: 12, size_bytes: 2048, log_entries: 4, broken_links: 2 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("작업대 선별 규칙", () => {
  it("최근 문서는 updated 내림차순이고 updated 없는 문서는 뒤로 간다", () => {
    expect(pickRecentPages(PAGES, 3).map((p) => p.slug)).toEqual(["d", "b", "c"]);
    expect(pickRecentPages(PAGES).at(-1)?.slug).toBe("e");
  });

  it("손볼 문서는 stale·contested·draft를 담고 archived는 제외한다", () => {
    expect(pickUnfinishedPages(PAGES).map((p) => p.slug)).toEqual(["b", "c", "f"]);
  });

  it("test/tmp 계열은 스크래치로 식별한다", () => {
    expect(isScratchVault({ name: "test-vault", path: "/Users/me/Raven/test-vault" })).toBe(true);
    expect(isScratchVault({ name: "anything", path: "/tmp/anything" })).toBe(true);
    expect(isScratchVault({ name: "raven-dev", path: "/Users/me/Raven/raven-dev" })).toBe(false);
    expect(isScratchVault({ name: "protest-notes", path: "/Users/me/Raven/protest-notes" })).toBe(false);
  });
});

describe("HomePage 오늘의 작업대", () => {
  it("최근·손볼 문서 큐가 보관소 목록보다 먼저 온다", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    const recent = await screen.findByRole("region", { name: "최근 문서" });
    const unfinished = await screen.findByRole("region", { name: "손볼 문서" });
    const vaultsHeading = await screen.findByRole("heading", { name: /보관소/ });

    expect(recent.textContent).toContain("어제 쓴 노트");
    expect(unfinished.textContent).toContain("검증 필요");
    expect(unfinished.textContent).toContain("모순 발견");
    expect(unfinished.textContent).not.toContain("격리됨");
    expect(
      Boolean(recent.compareDocumentPosition(vaultsHeading) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("스크래치 vault는 기본 숨김이고 토글로만 보인다", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("raven-dev")).toBeTruthy());
    expect(screen.queryByText("test-vault")).toBeNull();
    expect(screen.queryByText("scratch")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /스크래치 2개 보기/ }));

    await waitFor(() => expect(screen.getByText("test-vault")).toBeTruthy());
    expect(screen.getByText("scratch")).toBeTruthy();
  });
});

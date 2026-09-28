/* vault 운영 지침 편집 화면 (ADR 2026-09-25 3단계).
 *
 * 회귀 가드:
 *  1. 지침이 없으면 빈 상태 + "템플릿에서 시작" — 누르기 전엔 아무것도 저장하지 않는다
 *  2. 새 지침 저장은 precondition "" (아직 없다는 단언)로 PUT
 *  3. 기존 지침 편집 저장은 읽은 시점의 토큰을 싣는다
 *  4. 409면 서버 문장을 띄우고 내 초안을 지우지 않는다
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { VaultPolicyPage } from "../src/routes/VaultPolicyPage";

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
    <MemoryRouter initialEntries={["/vault/policy/v1"]}>
      <Routes>
        <Route path="/vault/policy/:vault" element={<VaultPolicyPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function putBody(spy: ReturnType<typeof vi.fn>, callIndex: number) {
  const [url, init] = spy.mock.calls[callIndex];
  expect(String(url)).toContain("/api/vaults/v1/policy");
  expect(init?.method).toBe("PUT");
  return JSON.parse(String(init?.body));
}

const EMPTY = {
  vault: "v1", path: "_meta/policy/VAULT-POLICY.md", content: null, modified: null,
  precondition: "", template: "# 운영 지침\n\n## 범위\n",
};
const EXISTING = {
  vault: "v1", path: "_meta/policy/VAULT-POLICY.md", content: "# 기존 지침\n",
  modified: "2026-09-28T10:00:00", precondition: "sha256-old",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VaultPolicyPage", () => {
  it("지침이 없으면 빈 상태를 보이고, 템플릿은 누를 때만 편집기에 채운다", async () => {
    const spy = stubFetch([{ status: 200, body: EMPTY }]);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "템플릿에서 시작" }));

    const editor = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(editor.value).toBe(EMPTY.template);
    expect(spy).toHaveBeenCalledTimes(1); // GET만 — 저장 전엔 쓰지 않는다
  });

  it("새 지침은 precondition \"\"로 저장한다", async () => {
    const spy = stubFetch([
      { status: 200, body: EMPTY },
      { status: 200, body: { ok: true, vault: "v1", precondition: "sha256-new" } },
    ]);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "빈 문서로 시작" }));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "# 새 지침\n" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(putBody(spy, 1)).toEqual({ content: "# 새 지침\n", precondition: "" });
  });

  it("기존 지침 편집은 읽은 시점의 토큰을 싣는다", async () => {
    const spy = stubFetch([
      { status: 200, body: EXISTING },
      { status: 200, body: { ok: true, vault: "v1", precondition: "sha256-next" } },
    ]);
    renderPage();

    expect(await screen.findByText("기존 지침")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "편집" }));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "# 고친 지침\n" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(putBody(spy, 1)).toEqual({ content: "# 고친 지침\n", precondition: "sha256-old" });
  });

  it("409면 충돌을 알리고 초안을 유지한다", async () => {
    stubFetch([
      { status: 200, body: EXISTING },
      { status: 409, body: { detail: "stale_precondition" } },
    ]);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "편집" }));
    const editor = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# 내 초안\n" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText(/다른 곳에서 먼저 저장/)).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("# 내 초안\n");
  });
});

/* P0-1 — 편집 초안 보호와 저장 신뢰.
 *
 * 회귀 가드:
 *  1. edit 모드 draft는 storage에 지속돼 remount(라우트 이탈/새로고침)를 살아남는다
 *  2. remount 시 남은 초안을 조용히 버리지 않고 사람에게 복구 수단을 준다
 *  3. 저장이 실패하면 초안은 여전히 복구 가능한 상태로 남는다
 *  4. dirty 상태에서 창을 닫으려 하면 브라우저 경고를 유발한다
 *  5. 저장이 성공하면 남은 초안을 정리한다 (유령 복구 배너 ❌)
 *
 * 이 저장소의 vitest jsdom 환경은 localStorage를 제공하지 않으므로(기존 한계,
 * PageEdit.precondition.test.tsx와 동일) storage를 stub한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { InlineMarkdownEditor } from "../src/components/InlineMarkdownEditor";

const VAULT = "v1";
const SLUG = "content/hello";
const BASE = "base body";
// Issue #32 / PR #35 review: 로컬 초안도 호스트를 넣은 키에 쓴다 (레거시 키는 읽기 전용, cross-host-review.test.tsx).
const DRAFT_KEY = `raven:draft@local:${VAULT}:${SLUG}`;

let mem: Map<string, string>;

function stubStorage() {
  mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  });
}

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function renderEditor() {
  return render(
    <MemoryRouter>
      <InlineMarkdownEditor
        vault={VAULT}
        slug={SLUG}
        title="Hello"
        content={BASE}
        precondition="12345-67"
      />
    </MemoryRouter>,
  );
}

function remountAsAfterReload(view: ReturnType<typeof renderEditor>) {
  view.unmount();
  return renderEditor();
}

async function typeInEditMode(text: string) {
  fireEvent.click(await screen.findByLabelText("편집"));
  const editor = document.querySelector("textarea");
  if (!editor) throw new Error("edit mode textarea not rendered");
  fireEvent.change(editor, { target: { value: text } });
  return editor as HTMLTextAreaElement;
}

beforeEach(() => {
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("InlineMarkdownEditor draft 보호", () => {
  it("edit 모드에서 입력한 초안을 storage에 지속한다", async () => {
    renderEditor();
    await typeInEditMode("base body + 아직 저장 안 한 문장");

    await waitFor(() => {
      const stored = localStorage.getItem(DRAFT_KEY);
      expect(stored).toBeTruthy();
      expect(String(stored)).toContain("아직 저장 안 한 문장");
    });
  });

  it("remount 후 남은 초안을 버리지 않고 복구 수단을 제공한다", async () => {
    const view = renderEditor();
    await typeInEditMode("base body + 복구되어야 하는 문장");
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).toBeTruthy());

    remountAsAfterReload(view);

    const restore = await screen.findByRole("button", { name: /초안 복구/ });
    fireEvent.click(restore);

    const editor = document.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(editor).toBeTruthy();
    expect(editor!.value).toContain("복구되어야 하는 문장");
  });

  it("저장이 실패하면 초안을 복구 가능한 상태로 남긴다", async () => {
    stubFetch(500, { detail: "server exploded" });

    renderEditor();
    await typeInEditMode("base body + 실패해도 남아야 하는 문장");

    const saveButton = (await screen.findByLabelText("저장")) as HTMLButtonElement;
    await waitFor(() => expect(saveButton.disabled).toBe(false));
    fireEvent.click(saveButton);

    expect(await screen.findByText(/server exploded/)).toBeTruthy();

    const editor = document.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(editor!.value).toContain("실패해도 남아야 하는 문장");
    expect(String(localStorage.getItem(DRAFT_KEY))).toContain("실패해도 남아야 하는 문장");
  });

  it("dirty 상태에서 창을 닫으려 하면 브라우저 경고를 유발한다", async () => {
    renderEditor();
    await typeInEditMode("base body + 경고를 유발해야 하는 문장");

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("저장이 성공하면 남은 초안을 정리한다", async () => {
    stubFetch(200, { ok: true, slug: SLUG });

    renderEditor();
    await typeInEditMode("base body + 저장될 문장");

    const saveButton = (await screen.findByLabelText("저장")) as HTMLButtonElement;
    await waitFor(() => expect(saveButton.disabled).toBe(false));
    fireEvent.click(saveButton);

    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).toBeNull());
  });
});

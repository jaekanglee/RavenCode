/* v0.7.181 — 사이드바 raw 섹션 "＋"가 resolveNewRawFile 검증을 실제로 태우는지.
 *
 * 순수 규칙은 rawPath.new-file.test.ts가 지킨다. 이건 배선 가드 —
 * 검증 함수를 만들어놓고 호출부에 안 붙이면 아무 의미가 없다.
 * 특히 기존 파일명 입력 시 writeRaw(rel, "")로 내용이 날아가는 경로.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "../src/components/Sidebar";
import type { RawItem } from "../src/lib/api";

const RAW_ITEMS: RawItem[] = [
  { path: "raw/notes.md", name: "notes.md", type: "file", kind: "raw" },
];

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar
        vaults={[{ name: "test", path: "/tmp/test", mode: "personal", owner: "user", default: true }]}
        trees={{ test: null }}
        activeVault="test"
        activeSlug={null}
        onSelectVault={() => {}}
        onRefresh={() => {}}
        open={true}
        onClose={() => {}}
        rawItems={{ test: RAW_ITEMS }}
      />
    </MemoryRouter>
  );
}

describe("Sidebar raw ＋ 검증 배선", () => {
  it("기존 파일명을 입력하면 덮어쓰지 않고 한국어 에러를 보여준다", async () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: /raw\/에 새 파일 만들기/ }));
    const nameInput = (await waitFor(() => screen.getByLabelText(/^파일명/))) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "notes.md" } });
    fireEvent.click(screen.getByRole("button", { name: "만들기" }));

    expect(await screen.findByText(/이미 있는 파일입니다/)).toBeTruthy();
    // 모달이 닫혔다면 writeRaw가 나갔다는 뜻.
    expect(screen.getByLabelText(/^파일명/)).toBeTruthy();
  });

  it("파일명에 '/' 를 쓰면 부모 디렉토리 필드로 안내한다", async () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: /raw\/에 새 파일 만들기/ }));
    const nameInput = (await waitFor(() => screen.getByLabelText(/^파일명/))) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "sub/new.md" } });
    fireEvent.click(screen.getByRole("button", { name: "만들기" }));

    expect(await screen.findByText(/부모 디렉토리에 지정해 주세요/)).toBeTruthy();
  });
});

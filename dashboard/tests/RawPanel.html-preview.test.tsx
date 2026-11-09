import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RawPanel } from "../src/routes/RawPanel";
import * as api from "../src/lib/api";
import type { RawItem } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  fetchRawList: vi.fn(),
  fetchRawContent: vi.fn(),
  writeRaw: vi.fn(),
  deleteRaw: vi.fn(),
}));

const HTML = "<!doctype html><html><body><h1>보고서</h1></body></html>";

const rawItems: RawItem[] = [
  { path: "raw/report.html", name: "report.html", type: "file" as const, kind: "raw", size: HTML.length },
  { path: "raw/note.md", name: "note.md", type: "file" as const, kind: "raw", size: 5 },
];

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/raw/:vault/*" element={<RawPanel />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("RawPanel HTML preview", () => {
  beforeEach(() => {
    vi.mocked(api.fetchRawList).mockResolvedValue({ ok: true, vault: "v", root: "raw", items: rawItems });
    vi.mocked(api.fetchRawContent).mockImplementation(async (_vault, rel) => ({
      ok: true,
      vault: "v",
      path: `raw/${rel}`,
      content: rel.endsWith(".html") ? HTML : "# note",
      size: 10,
    }));
  });

  it("renders an .html file in a sandboxed iframe by default", async () => {
    renderAt("/raw/v/report.html");

    const frame = (await screen.findByTitle("HTML 미리보기")) as HTMLIFrameElement;
    expect(frame.getAttribute("srcdoc")).toBe(HTML);
    // 스크립트는 돌되 opaque origin — 부모 대시보드의 토큰·API에 접근 불가.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("switches between rendered view and source", async () => {
    renderAt("/raw/v/report.html");
    await screen.findByTitle("HTML 미리보기");

    fireEvent.click(screen.getByRole("button", { name: /소스/ }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(HTML);
    expect(screen.queryByTitle("HTML 미리보기")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /미리보기/ }));
    expect(await screen.findByTitle("HTML 미리보기")).toBeTruthy();
  });

  it("edits HTML as source", async () => {
    renderAt("/raw/v/report.html");
    await screen.findByTitle("HTML 미리보기");

    fireEvent.click(screen.getByRole("button", { name: /편집/ }));
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(screen.queryByTitle("HTML 미리보기")).toBeNull();
  });

  it("keeps non-HTML files in the text viewer", async () => {
    renderAt("/raw/v/note.md");

    expect(await screen.findByRole("textbox")).toBeTruthy();
    expect(screen.queryByTitle("HTML 미리보기")).toBeNull();
    expect(screen.queryByRole("button", { name: /미리보기/ })).toBeNull();
  });
});

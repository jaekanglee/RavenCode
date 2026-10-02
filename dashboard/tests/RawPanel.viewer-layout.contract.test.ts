/* v0.7.112 — RawPanel selected-file viewer layout contract.
 *
 * Opening a raw file from the global Sidebar must not render another file
 * explorer inside the viewer. The selected file page should be full-width
 * and tall enough to read/edit the content.
 */
import { describe, expect, it } from "vitest";
import RawPanelSrc from "../src/routes/RawPanel.tsx?raw";

describe("RawPanel selected-file viewer layout", () => {
  it("hides the inner RawTree when relPath exists", () => {
    expect(RawPanelSrc).toContain('gridTemplateColumns: relPath ? "minmax(0, 1fr)"');
    expect(RawPanelSrc).toContain('{!relPath && (');
  });

  it("gives the viewer a real viewport height and flex child body", () => {
    expect(RawPanelSrc).toContain('height: "calc(100vh - 220px)"');
    expect(RawPanelSrc).toContain('display: "flex", flexDirection: "column", flex: 1, minHeight: 0');
    expect(RawPanelSrc).toContain('height: "100%"');
  });
});


describe("RawPanel before a file is selected", () => {
  it("marks the inner RawTree so globals.css hides it where the sidebar is always visible (>744px)", () => {
    expect(RawPanelSrc).toContain('className="raw-panel-tree"');
    expect(RawPanelSrc).toContain('className={relPath ? undefined : "raw-panel-grid"}');
  });
});

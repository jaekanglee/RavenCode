import { describe, expect, it } from "vitest";
import { coreEndpointMoved } from "./core-endpoint";

describe("coreEndpointMoved", () => {
  it("is false when the restarted Core kept its endpoint", () => {
    expect(coreEndpointMoved("http://127.0.0.1:8765", "http://127.0.0.1:8765")).toBe(false);
    expect(coreEndpointMoved("http://127.0.0.1:8765", " http://127.0.0.1:8765/ ")).toBe(false);
  });

  it("is true when the restart moved the API to another port", () => {
    expect(coreEndpointMoved("http://127.0.0.1:8765", "http://127.0.0.1:52011")).toBe(true);
  });

  it("does not reload on a missing or unusable answer", () => {
    for (const next of [null, undefined, "", "   ", 42]) {
      expect(coreEndpointMoved("http://127.0.0.1:8765", next)).toBe(false);
    }
  });
});

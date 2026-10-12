import { describe, expect, it } from "vitest";
import { describeBindExposure } from "./bind-exposure";

describe("describeBindExposure (Issue #16)", () => {
  it("treats loopback and a missing value as loopback-only", () => {
    for (const host of ["127.0.0.1", "::1", undefined, null, ""]) {
      expect(describeBindExposure(host).kind).toBe("loopback");
    }
  });

  it("reports a wildcard bind as every interface", () => {
    for (const host of ["0.0.0.0", "::"]) {
      const e = describeBindExposure(host);
      expect(e.kind).toBe("all");
      expect(e.detail).toContain("토큰");
    }
  });

  it("does not call a specific address bind loopback-only", () => {
    const e = describeBindExposure("100.64.1.2");
    expect(e.kind).toBe("address");
    expect(e.label).toContain("100.64.1.2");
    expect(e.detail).toContain("loopback은 수신하지 않음");
  });
});

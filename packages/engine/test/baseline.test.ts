import { describe, it, expect } from "vitest";
import { closeBaselineFresh } from "../src/baseline.js";

describe("closeBaselineFresh", () => {
  const close = Date.parse("2026-07-13T20:00:00Z"); // 16:00 et
  const gap = 20 * 60_000; // 20 minutes

  it("is fresh when a tick landed just before the close", () => {
    expect(closeBaselineFresh(close, close - 40_000, gap)).toBe(true); // 40s before
  });

  it("is fresh when a tick sits at the close moment", () => {
    expect(closeBaselineFresh(close, close, gap)).toBe(true);
  });

  it("is stale when the nearest tick is well before the close", () => {
    expect(closeBaselineFresh(close, close - 2 * 3600_000, gap)).toBe(false); // 2h before
  });

  it("is not fresh when no tick exists at all", () => {
    expect(closeBaselineFresh(close, null, gap)).toBe(false);
  });

  it("respects the gap boundary exactly", () => {
    expect(closeBaselineFresh(close, close - gap, gap)).toBe(true);
    expect(closeBaselineFresh(close, close - gap - 1, gap)).toBe(false);
  });
});

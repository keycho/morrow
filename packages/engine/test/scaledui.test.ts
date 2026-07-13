import { describe, expect, it } from "vitest";
import {
  UI_MULTIPLIER_ONE,
  decodeUiMultiplier,
  effectivePerSharePrice,
  multipliersDiffer,
} from "../src/index.js";

describe("decodeUiMultiplier", () => {
  it("decodes a multiplier of 1", () => {
    const d = decodeUiMultiplier(UI_MULTIPLIER_ONE);
    expect(d.multiplier).toBe(1);
    expect(d.missing).toBe(false);
  });

  it("decodes a 10:1 split multiplier", () => {
    const d = decodeUiMultiplier(10n * UI_MULTIPLIER_ONE);
    expect(d.multiplier).toBeCloseTo(10, 9);
    expect(d.missing).toBe(false);
  });

  it("decodes a fractional multiplier", () => {
    // reverse split, 1:4 -> m = 0.25
    const d = decodeUiMultiplier(UI_MULTIPLIER_ONE / 4n);
    expect(d.multiplier).toBeCloseTo(0.25, 9);
    expect(d.missing).toBe(false);
  });

  it("treats a missing function (null) as multiplier 1 and flags it", () => {
    const d = decodeUiMultiplier(null);
    expect(d.multiplier).toBe(1);
    expect(d.missing).toBe(true);
  });

  it("treats undefined the same as missing", () => {
    const d = decodeUiMultiplier(undefined);
    expect(d.multiplier).toBe(1);
    expect(d.missing).toBe(true);
  });

  it("treats a zero or negative reading as missing", () => {
    expect(decodeUiMultiplier(0n)).toEqual({ multiplier: 1, missing: true });
    expect(decodeUiMultiplier(-1n)).toEqual({ multiplier: 1, missing: true });
  });
});

describe("effectivePerSharePrice", () => {
  it("leaves the price unchanged at multiplier 1", () => {
    expect(effectivePerSharePrice(250, 1)).toBe(250);
  });

  it("divides by the multiplier after a 10:1 split", () => {
    // raw token still worth 1000, but now represents 10 shares -> 100/share
    expect(effectivePerSharePrice(1000, 10)).toBe(100);
  });

  it("guards a non-positive multiplier by treating it as 1", () => {
    expect(effectivePerSharePrice(250, 0)).toBe(250);
    expect(effectivePerSharePrice(250, -5)).toBe(250);
  });
});

describe("multipliersDiffer", () => {
  it("reports no change for identical multipliers", () => {
    expect(multipliersDiffer(1, 1, 1e-6)).toBe(false);
    expect(multipliersDiffer(10, 10, 1e-6)).toBe(false);
  });

  it("reports no change for float round-trip noise within tolerance", () => {
    expect(multipliersDiffer(1, 1 + 1e-9, 1e-6)).toBe(false);
  });

  it("reports a change for a real split", () => {
    expect(multipliersDiffer(1, 10, 1e-6)).toBe(true);
    expect(multipliersDiffer(1, 0.25, 1e-6)).toBe(true);
  });
});

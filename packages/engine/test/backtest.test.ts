import { describe, it, expect } from "vitest";
import { median, percentile, scoreMetrics } from "../src/backtest.js";

describe("median", () => {
  it("handles odd and even lengths", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("is zero on empty", () => {
    expect(median([])).toBe(0);
  });
});

describe("percentile", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it("p50 and p90 land on the expected elements", () => {
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 90)).toBe(9);
    expect(percentile(xs, 100)).toBe(10);
  });
  it("never indexes out of range", () => {
    expect(percentile([42], 90)).toBe(42);
    expect(percentile([], 90)).toBe(0);
  });
});

describe("scoreMetrics", () => {
  it("computes mae, median, rmse and bias from signed errors", () => {
    // errors: +2%, -2%, +2%, -2% -> mae 2%, median 2%, rmse 2%, bias 0
    const errs = [0.02, -0.02, 0.02, -0.02];
    const actualGap = [0.01, -0.01, 0.01, -0.01];
    const m = scoreMetrics(errs, null, actualGap, null);
    expect(m.n).toBe(4);
    expect(m.maePct).toBeCloseTo(2, 9);
    expect(m.medianAePct).toBeCloseTo(2, 9);
    expect(m.rmsePct).toBeCloseTo(2, 9);
    expect(m.meanErrorPct).toBeCloseTo(0, 9);
    expect(m.worstPct).toBeCloseTo(2, 9);
    expect(m.hitRate).toBeNull(); // no predGap given
    expect(m.winRateVsNaive).toBeNull(); // no naiveAbs given
  });

  it("scores directional hit rate, ignoring zero calls and zero gaps", () => {
    // predGap:  +, -, +, 0(no call), +
    // actualGap:+, -, -, +,          0(no gap)
    // calls (both nonzero): idx0 hit, idx1 hit, idx2 miss  -> 2/3
    const predGap = [0.01, -0.01, 0.01, 0, 0.01];
    const actualGap = [0.02, -0.02, -0.02, 0.02, 0];
    const errs = [0, 0, 0, 0, 0];
    const m = scoreMetrics(errs, predGap, actualGap, null);
    expect(m.hitRate).toBeCloseTo(2 / 3, 9);
  });

  it("scores win rate as strictly beating naive per session", () => {
    // predictor abs err: 1, 3, 2 ; naive abs err: 2, 2, 2 -> wins on idx0 only
    const errs = [0.01, 0.03, -0.02];
    const naiveAbs = [0.02, 0.02, 0.02];
    const actualGap = [0.01, 0.01, 0.01];
    const m = scoreMetrics(errs, null, actualGap, naiveAbs);
    expect(m.winRateVsNaive).toBeCloseTo(1 / 3, 9);
  });

  it("returns null hit rate when no session has a directional call", () => {
    const m = scoreMetrics([0, 0], [0, 0], [0.01, -0.01], null);
    expect(m.hitRate).toBeNull();
  });
});

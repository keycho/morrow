import { describe, expect, it } from "vitest";
import {
  depthFromReserves,
  depthFromSqrtPriceX96,
  dollarize,
  spotFromReserves,
  spotFromSqrtPriceX96,
  v4PoolId,
} from "../src/index.js";

const Q96 = 79228162514264337593543950336n; // 2^96
const TWO_PCT = Math.sqrt(1.02) - 1 + (1 - Math.sqrt(0.98)); // ~0.020001

describe("concentrated-liquidity spot (v3 / v4)", () => {
  it("prices sqrtPriceX96 = 2^96 as 1 when decimals match", () => {
    expect(spotFromSqrtPriceX96(Q96, 18, 18, false)).toBeCloseTo(1, 9);
  });

  it("applies the base/quote decimal difference", () => {
    // sp = 1, so quote-per-stock = 1 * 10^(18-6) = 1e12
    expect(spotFromSqrtPriceX96(Q96, 18, 6, false)).toBeCloseTo(1e12, 0);
  });

  it("inverts when the stock is the higher-address side", () => {
    expect(spotFromSqrtPriceX96(Q96, 18, 18, true)).toBeCloseTo(1, 9);
  });
});

describe("concentrated-liquidity depth (v3 / v4)", () => {
  it("is zero with no liquidity", () => {
    expect(depthFromSqrtPriceX96(Q96, 0n, 6, false)).toBe(0);
  });

  it("is the ±2% quote span at sp = 1", () => {
    // sp = 1, quoteDecimals = 0, so depth ~= L * (sqrt(1.02)-1 + 1-sqrt(0.98))
    expect(depthFromSqrtPriceX96(Q96, 1_000_000n, 0, false)).toBeCloseTo(1_000_000 * TWO_PCT, 3);
  });
});

describe("constant-product spot (v2)", () => {
  it("prices from reserves with decimals", () => {
    // 1 stock (18 dec) against 250 usdg (6 dec) -> 250 usd per share
    expect(spotFromReserves(10n ** 18n, 250n * 10n ** 6n, 18, 6, false)).toBeCloseTo(250, 6);
  });

  it("inverts orientation", () => {
    // stock is token1: reserve0 is quote, reserve1 is stock
    expect(spotFromReserves(250n * 10n ** 6n, 10n ** 18n, 18, 6, true)).toBeCloseTo(250, 6);
  });

  it("is zero on an empty reserve", () => {
    expect(spotFromReserves(0n, 10n, 18, 6, false)).toBe(0);
  });
});

describe("constant-product depth (v2), normalized to ±2% quote", () => {
  it("uses the quote-side reserve", () => {
    // quote reserve 250 usdg -> depth ~= 250 * two-pct span
    expect(depthFromReserves(10n ** 18n, 250n * 10n ** 6n, 6, false)).toBeCloseTo(250 * TWO_PCT, 6);
  });

  it("picks the token0 reserve when inverted", () => {
    expect(depthFromReserves(250n * 10n ** 6n, 10n ** 18n, 6, true)).toBeCloseTo(250 * TWO_PCT, 6);
  });
});

describe("weth-quoted v2 pool dollarizes correctly", () => {
  it("converts weth-per-share to usd-per-share via eth/usd", () => {
    // stock is token0, weth is token1, both 18 decimals.
    // 100 shares against 6 weth -> 0.06 weth per share
    const wethPerShare = spotFromReserves(100n * 10n ** 18n, 6n * 10n ** 18n, 18, 18, false);
    expect(wethPerShare).toBeCloseTo(0.06, 9);
    // at 3500 usd/eth that is 210 usd per share
    expect(dollarize(wethPerShare, 3500)).toBeCloseTo(210, 6);

    // depth: 6 weth of quote reserve -> ~6 * two-pct weth, dollarized
    const wethDepth = depthFromReserves(100n * 10n ** 18n, 6n * 10n ** 18n, 18, false);
    expect(dollarize(wethDepth, 3500)).toBeCloseTo(6 * TWO_PCT * 3500, 3);
  });
});

describe("v4 pool id", () => {
  const A = "0x1111111111111111111111111111111111111111" as const;
  const B = "0x2222222222222222222222222222222222222222" as const;
  const HOOKS = "0x0000000000000000000000000000000000000000" as const;

  it("is a deterministic 32-byte hash", () => {
    const id1 = v4PoolId(A, B, 3000, 60, HOOKS);
    const id2 = v4PoolId(A, B, 3000, 60, HOOKS);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes with the fee, tick spacing, and hooks", () => {
    const base = v4PoolId(A, B, 3000, 60, HOOKS);
    expect(v4PoolId(A, B, 500, 60, HOOKS)).not.toBe(base);
    expect(v4PoolId(A, B, 3000, 10, HOOKS)).not.toBe(base);
    expect(v4PoolId(A, B, 3000, 60, "0x0000000000000000000000000000000000000001")).not.toBe(base);
  });
});

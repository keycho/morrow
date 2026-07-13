// pool pricing and depth math, shared across venues. pure functions.
//
// uniswap v3 and v4 are both concentrated-liquidity: the price is a
// sqrtPriceX96 and the in-range liquidity is an L, so they share the same spot
// and depth math (v4 reads these from the state-view lens by pool id instead
// of from a pool contract, but the numbers mean the same thing). uniswap v2 is
// constant-product: price and depth come from the reserves.
//
// depth is always expressed as the quote-token amount needed to move the mid
// price by ±2%. constant-product depth is a different curve shape from
// concentrated depth, but normalizing both to this same "±2% quote" measure is
// what lets the engine's depth floor mean the same thing across every venue.
// the approximation holds in-range liquidity constant across the span; it is a
// weighting gauge, not a settlement number.

import { encodeAbiParameters, keccak256, type Hex } from "viem";

const Q96 = 2 ** 96;
const UP = Math.sqrt(1.02);
const DN = Math.sqrt(0.98);

// v3 / v4 spot: quote per stock token, human units. invert is true when the
// stock token is the higher-address side (token1 / currency1).
export function spotFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  invert: boolean
): number {
  const sp = Number(sqrtPriceX96) / Q96;
  const rawPrice = sp * sp; // token1 per token0, raw units
  if (!invert) {
    return rawPrice * 10 ** (baseDecimals - quoteDecimals);
  }
  return (1 / rawPrice) * 10 ** (baseDecimals - quoteDecimals);
}

// v3 / v4 depth: quote units to move the price ±2%, constant-L approximation.
export function depthFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  quoteDecimals: number,
  invert: boolean
): number {
  const sp = Number(sqrtPriceX96) / Q96;
  const L = Number(liquidity);
  if (L === 0 || sp === 0) return 0;
  const quoteRaw = !invert
    ? L * sp * (UP - 1) + L * sp * (1 - DN)
    : (L / sp) * (1 / DN - 1) + (L / sp) * (1 - 1 / UP);
  return quoteRaw / 10 ** quoteDecimals;
}

// v2 spot: quote per stock token, human units, from the pair reserves.
export function spotFromReserves(
  reserve0: bigint,
  reserve1: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  invert: boolean
): number {
  const r0 = Number(reserve0);
  const r1 = Number(reserve1);
  if (r0 === 0 || r1 === 0) return 0;
  const ratio = !invert ? r1 / r0 : r0 / r1;
  return ratio * 10 ** (baseDecimals - quoteDecimals);
}

// v2 depth: quote units to move the mid price ±2%, from the reserves. for a
// constant-product pool the quote needed to move the price by a fraction d is
// q * (sqrt(1 + d) - 1); the two-sided ±2% depth is the sum of both legs.
// normalized to the same measure as depthFromSqrtPriceX96.
export function depthFromReserves(
  reserve0: bigint,
  reserve1: bigint,
  quoteDecimals: number,
  invert: boolean
): number {
  const quoteRaw = Number(invert ? reserve0 : reserve1);
  if (quoteRaw === 0) return 0;
  const q = quoteRaw / 10 ** quoteDecimals;
  return q * (UP - 1) + q * (1 - DN);
}

// uniswap v4 pool id: keccak256 of the abi-encoded pool key. currencies must
// already be sorted (currency0 < currency1 by address). the native currency is
// the zero address. hooks is the hook contract, or the zero address for none.
export function v4PoolId(
  currency0: Hex,
  currency1: Hex,
  fee: number,
  tickSpacing: number,
  hooks: Hex
): Hex {
  const encoded = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
    ],
    [currency0, currency1, fee, tickSpacing, hooks]
  );
  return keccak256(encoded);
}

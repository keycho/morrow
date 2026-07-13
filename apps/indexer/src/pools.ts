// uniswap v3 pool reading on robinhood chain via viem.
//
// per token per tick we record:
//   - effective per-share price (raw pool price adjusted by the erc-8056 ui
//     multiplier, so a split does not distort the series)
//   - approximate quote-token liquidity depth within ±2% of spot
//   - cumulative swap volume delta since the previous tick (quote units)
//   - the ui multiplier in force, and a flag if the token lacks the function
//   - block number and timestamp
//
// slot0, liquidity, and uiMultiplier are read in one multicall against the
// robinhood chain multicall contract (address from config). a token that
// does not expose uiMultiplier() is handled: the multiplier is treated as 1
// and the tick is flagged missing.
//
// depth approximation: we assume the in-range liquidity L is constant across
// the ±2% span (no tick-crossing simulation). that is a deliberate v1
// simplification; it is a gauge for weighting, not a settlement number.
//
// note: this assumes the quote is a dollar stablecoin (usdg). a weth-quoted
// token would need an eth/usd rate to dollarize the price; discovery flags
// such tokens and they are excluded from the usdg launch set.

import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { chain, dollarization, tokens, type TokenConfig } from "@fletch/config";
import {
  decodeUiMultiplier,
  dollarize,
  effectivePerSharePrice,
  ethUsdUsable,
  type EthUsdTick,
} from "@fletch/engine";
import { log } from "./log.js";
import { backoffDelayMs, sleep } from "./breaker.js";

const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

const erc8056Abi = parseAbi(["function uiMultiplier() view returns (uint256)"]);

const Q96 = 2 ** 96;

let client: PublicClient | null = null;

export function rpcClient(): PublicClient {
  if (client) return client;
  client = createPublicClient({
    transport: http(chain.rpcUrl, {
      timeout: 10_000,
      retryCount: 3,
      retryDelay: 500,
    }),
  });
  return client;
}

export interface PoolReading {
  token: TokenConfig;
  blockNumber: bigint;
  ts: Date;
  // effective per-share price in usd (raw pool price / ui multiplier, and for
  // weth-quoted pools multiplied by the eth/usd rate).
  spot: number;
  // raw per-token pool price before the ui multiplier, in quote units
  // (usd for usdg pools, eth for weth pools). kept for logging.
  rawSpot: number;
  // ±2% depth in usd.
  depthQuote2pct: number;
  volumeDeltaQuote: number;
  // ui multiplier in force, m = uiMultiplier / 1e18.
  uiMultiplier: number;
  // true when the token does not expose uiMultiplier().
  uiMultiplierMissing: boolean;
  // eth/usd rate used to dollarize a weth pool, or null for usdg pools.
  ethUsdRate: number | null;
}

// thrown when a weth-quoted pool cannot be dollarized because the eth/usd
// rate is stale or missing. the caller skips the token (no observation), so
// confidence degrades instead of a wrong price being published.
export class EthUsdUnavailableError extends Error {
  constructor(symbol: string) {
    super(`eth/usd rate stale or missing; skipping weth-quoted ${symbol}`);
    this.name = "EthUsdUnavailableError";
  }
}

// raw v3 price is token1-per-token0 in raw units: (sqrtPriceX96 / 2^96)^2.
// human spot (quote per stock token) depends on which side the stock is.
function spotFromSqrtPrice(sqrtPriceX96: bigint, t: TokenConfig): number {
  const sp = Number(sqrtPriceX96) / Q96;
  const rawPrice = sp * sp; // token1 per token0, raw units
  if (!t.invert) {
    // stock = token0, quote = token1
    return rawPrice * 10 ** (t.baseDecimals - t.quoteDecimals);
  }
  // stock = token1, quote = token0
  return (1 / rawPrice) * 10 ** (t.baseDecimals - t.quoteDecimals);
}

// two-sided quote depth to move the stock price ±2%, assuming constant L.
function depthQuote2pct(sqrtPriceX96: bigint, liquidity: bigint, t: TokenConfig): number {
  const sp = Number(sqrtPriceX96) / Q96;
  const L = Number(liquidity);
  if (L === 0 || sp === 0) return 0;
  const up = Math.sqrt(1.02);
  const dn = Math.sqrt(0.98);
  let quoteRaw: number;
  if (!t.invert) {
    // quote = token1. token1 in to push raw price +2%, token1 out on -2%.
    quoteRaw = L * sp * (up - 1) + L * sp * (1 - dn);
  } else {
    // quote = token0. stock +2% means raw price -2% and vice versa.
    quoteRaw = (L / sp) * (1 / dn - 1) + (L / sp) * (1 - 1 / up);
  }
  return quoteRaw / 10 ** t.quoteDecimals;
}

// track the last block we summed swap volume through, per pool.
const lastVolumeBlock = new Map<string, bigint>();

async function volumeDeltaQuote(
  t: TokenConfig,
  pool: `0x${string}`,
  currentBlock: bigint
): Promise<number> {
  const from = lastVolumeBlock.get(pool);
  lastVolumeBlock.set(pool, currentBlock);
  if (from === undefined || from >= currentBlock) return 0;
  try {
    const logs = await rpcClient().getLogs({
      address: pool,
      event: poolAbi[2],
      fromBlock: from + 1n,
      toBlock: currentBlock,
    });
    let quoteRaw = 0;
    for (const entry of logs) {
      const a0 = entry.args.amount0 ?? 0n;
      const a1 = entry.args.amount1 ?? 0n;
      const quoteAmount = t.invert ? a0 : a1;
      quoteRaw += Math.abs(Number(quoteAmount));
    }
    return quoteRaw / 10 ** t.quoteDecimals;
  } catch (err) {
    // volume is best effort. a failed log query must not sink the tick.
    log.warn("swap log query failed", {
      pool,
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export async function readPool(t: TokenConfig, ethUsd: EthUsdTick | null): Promise<PoolReading> {
  const pool = t.pool;
  if (pool === null) {
    throw new Error(`pool for ${t.symbol} is not discovered yet (run pnpm discover-pools)`);
  }
  const isWeth = t.quote === "weth";
  if (isWeth && !ethUsdUsable(ethUsd, Date.now(), dollarization.stalenessMs)) {
    // never dollarize with a stale rate; the caller treats this as a skip.
    throw new EthUsdUnavailableError(t.symbol);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const c = rpcClient();
      const block = await c.getBlock();

      // slot0, liquidity, and the erc-8056 ui multiplier in one multicall.
      // allowFailure lets a token without uiMultiplier() degrade to m = 1.
      const [slot0Res, liquidityRes, multiplierRes] = await c.multicall({
        multicallAddress: chain.multicall3,
        allowFailure: true,
        contracts: [
          { address: pool, abi: poolAbi, functionName: "slot0" },
          { address: pool, abi: poolAbi, functionName: "liquidity" },
          { address: t.address, abi: erc8056Abi, functionName: "uiMultiplier" },
        ],
      });

      if (slot0Res.status !== "success" || liquidityRes.status !== "success") {
        throw new Error("slot0 or liquidity read failed");
      }
      const sqrtPriceX96 = slot0Res.result[0];
      const liquidity = liquidityRes.result;

      const rawMultiplier =
        multiplierRes.status === "success" ? (multiplierRes.result as bigint) : null;
      const { multiplier, missing } = decodeUiMultiplier(rawMultiplier);

      const rawSpot = spotFromSqrtPrice(sqrtPriceX96, t);
      // per-share price in quote units (usd for usdg, eth for weth)
      const perShareQuote = effectivePerSharePrice(rawSpot, multiplier);
      const depthQuote = depthQuote2pct(sqrtPriceX96, liquidity, t);
      const volume = await volumeDeltaQuote(t, pool, block.number);

      // dollarize weth-quoted pools. usability was checked before the loop.
      let spot = perShareQuote;
      let depth = depthQuote;
      let ethUsdRate: number | null = null;
      if (isWeth) {
        const rate = ethUsd!.rate;
        ethUsdRate = rate;
        spot = dollarize(perShareQuote, rate);
        depth = dollarize(depthQuote, rate);
      }

      return {
        token: t,
        blockNumber: block.number,
        ts: new Date(Number(block.timestamp) * 1000),
        spot,
        rawSpot,
        depthQuote2pct: depth,
        volumeDeltaQuote: volume,
        uiMultiplier: multiplier,
        uiMultiplierMissing: missing,
        ethUsdRate,
      };
    } catch (err) {
      lastError = err;
      await sleep(backoffDelayMs(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function trackedTokens(): TokenConfig[] {
  return tokens;
}

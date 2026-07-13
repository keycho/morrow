// uniswap v3 pool reading on robinhood chain via viem.
//
// per token per tick we record:
//   - pool spot price (quote per stock token, human units)
//   - approximate quote-token liquidity depth within ±2% of spot
//   - cumulative swap volume delta since the previous tick (quote units)
//   - block number and timestamp
//
// depth approximation: we assume the in-range liquidity L is constant across
// the ±2% span (no tick-crossing simulation). that is a deliberate v1
// simplification; it is a gauge for weighting, not a settlement number.

import {
  createPublicClient,
  http,
  parseAbi,
  type PublicClient,
} from "viem";
import { chain, tokens, type TokenConfig } from "@fletch/config";
import { log } from "./log.js";
import { backoffDelayMs, sleep } from "./breaker.js";

const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

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
  spot: number;
  depthQuote2pct: number;
  volumeDeltaQuote: number;
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
      pool: t.pool,
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export async function readPool(t: TokenConfig): Promise<PoolReading> {
  const pool = t.pool;
  if (pool === null) {
    throw new Error(`pool for ${t.symbol} is not discovered yet (run pnpm discover-pools)`);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const c = rpcClient();
      const block = await c.getBlock();
      const [slot0, liquidity] = await Promise.all([
        c.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
        c.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }),
      ]);
      const sqrtPriceX96 = slot0[0];
      const spot = spotFromSqrtPrice(sqrtPriceX96, t);
      const depth = depthQuote2pct(sqrtPriceX96, liquidity, t);
      const volume = await volumeDeltaQuote(t, pool, block.number);
      return {
        token: t,
        blockNumber: block.number,
        ts: new Date(Number(block.timestamp) * 1000),
        spot,
        depthQuote2pct: depth,
        volumeDeltaQuote: volume,
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

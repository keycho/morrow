// pool reading on robinhood chain via viem, across uniswap v2, v3, and v4.
//
// the venue is a property of the token config (`protocol`), not baked into the
// code. one reader per protocol produces a normalized reading:
//   - raw per-share price (quote per stock token, before the ui multiplier)
//   - ±2% depth in quote units
//   - the erc-8056 ui multiplier
// then the common path applies the multiplier and, for weth-quoted pools, the
// eth/usd dollarization, identically regardless of venue.
//
// v3 and v4 are concentrated-liquidity: sqrtPriceX96 + in-range liquidity.
// v4 pools live in a singleton pool manager and are read through the
// state-view lens by pool id (stored in `pool`), not a per-pool address.
// v2 is constant-product: price and depth come from the pair reserves,
// normalized to the same ±2% quote-depth measure so the engine's depth floor
// means the same thing across venues (see @morrow/engine poolmath).
//
// depth uses the constant-in-range-liquidity approximation for v3/v4 and the
// closed-form constant-product move for v2; both are weighting gauges, not
// settlement numbers.

import { createPublicClient, http, parseAbi, type Hex, type PublicClient } from "viem";
import { chain, dollarization, tokens, uniswapV4, type TokenConfig } from "@morrow/config";
import {
  decodeUiMultiplier,
  depthFromReserves,
  depthFromSqrtPriceX96,
  dollarize,
  effectivePerSharePrice,
  ethUsdUsable,
  spotFromReserves,
  spotFromSqrtPriceX96,
  type EthUsdTick,
} from "@morrow/engine";
import { log } from "./log.js";
import { backoffDelayMs, sleep } from "./breaker.js";

const v3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

const v2PairAbi = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);

const v4StateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

const erc8056Abi = parseAbi(["function uiMultiplier() view returns (uint256)"]);

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

// normalized reading from any venue, before the multiplier and dollarization.
interface RawRead {
  rawSpot: number;
  depthQuote: number;
  rawMultiplier: bigint | null;
}

async function readV3(c: PublicClient, t: TokenConfig, pool: Hex): Promise<RawRead> {
  const [slot0Res, liqRes, multRes] = await c.multicall({
    multicallAddress: chain.multicall3,
    allowFailure: true,
    contracts: [
      { address: pool, abi: v3PoolAbi, functionName: "slot0" },
      { address: pool, abi: v3PoolAbi, functionName: "liquidity" },
      { address: t.address, abi: erc8056Abi, functionName: "uiMultiplier" },
    ],
  });
  if (slot0Res.status !== "success" || liqRes.status !== "success") {
    throw new Error("v3 slot0 or liquidity read failed");
  }
  const sqrtPriceX96 = slot0Res.result[0];
  return {
    rawSpot: spotFromSqrtPriceX96(sqrtPriceX96, t.baseDecimals, t.quoteDecimals, t.invert),
    depthQuote: depthFromSqrtPriceX96(sqrtPriceX96, liqRes.result, t.quoteDecimals, t.invert),
    rawMultiplier: multRes.status === "success" ? (multRes.result as bigint) : null,
  };
}

async function readV4(c: PublicClient, t: TokenConfig, poolId: Hex): Promise<RawRead> {
  const [slot0Res, liqRes, multRes] = await c.multicall({
    multicallAddress: chain.multicall3,
    allowFailure: true,
    contracts: [
      { address: uniswapV4.stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [poolId] },
      { address: uniswapV4.stateView, abi: v4StateViewAbi, functionName: "getLiquidity", args: [poolId] },
      { address: t.address, abi: erc8056Abi, functionName: "uiMultiplier" },
    ],
  });
  if (slot0Res.status !== "success" || liqRes.status !== "success") {
    throw new Error("v4 state-view read failed");
  }
  const sqrtPriceX96 = slot0Res.result[0];
  return {
    rawSpot: spotFromSqrtPriceX96(sqrtPriceX96, t.baseDecimals, t.quoteDecimals, t.invert),
    depthQuote: depthFromSqrtPriceX96(sqrtPriceX96, liqRes.result, t.quoteDecimals, t.invert),
    rawMultiplier: multRes.status === "success" ? (multRes.result as bigint) : null,
  };
}

async function readV2(c: PublicClient, t: TokenConfig, pair: Hex): Promise<RawRead> {
  const [reservesRes, multRes] = await c.multicall({
    multicallAddress: chain.multicall3,
    allowFailure: true,
    contracts: [
      { address: pair, abi: v2PairAbi, functionName: "getReserves" },
      { address: t.address, abi: erc8056Abi, functionName: "uiMultiplier" },
    ],
  });
  if (reservesRes.status !== "success") {
    throw new Error("v2 getReserves read failed");
  }
  const reserve0 = reservesRes.result[0];
  const reserve1 = reservesRes.result[1];
  return {
    rawSpot: spotFromReserves(reserve0, reserve1, t.baseDecimals, t.quoteDecimals, t.invert),
    depthQuote: depthFromReserves(reserve0, reserve1, t.quoteDecimals, t.invert),
    rawMultiplier: multRes.status === "success" ? (multRes.result as bigint) : null,
  };
}

function readByProtocol(c: PublicClient, t: TokenConfig, pool: Hex): Promise<RawRead> {
  switch (t.protocol) {
    case "v3":
      return readV3(c, t, pool);
    case "v4":
      return readV4(c, t, pool);
    case "v2":
      return readV2(c, t, pool);
    default:
      throw new Error(`unknown protocol "${String(t.protocol)}" for ${t.symbol}`);
  }
}

// swap volume since the previous read. v3 only: swaps for v2 and v4 are not
// emitted per pool address (v4 emits from the singleton pool manager), so
// volume is best-effort and reported as zero for those venues.
const lastVolumeBlock = new Map<string, bigint>();

async function volumeDeltaQuoteV3(
  t: TokenConfig,
  pool: Hex,
  currentBlock: bigint
): Promise<number> {
  const from = lastVolumeBlock.get(pool);
  lastVolumeBlock.set(pool, currentBlock);
  if (from === undefined || from >= currentBlock) return 0;
  try {
    const logs = await rpcClient().getLogs({
      address: pool,
      event: v3PoolAbi[2],
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
      const raw = await readByProtocol(c, t, pool);

      const { multiplier, missing } = decodeUiMultiplier(raw.rawMultiplier);
      const perShareQuote = effectivePerSharePrice(raw.rawSpot, multiplier);
      const volume =
        t.protocol === "v3" ? await volumeDeltaQuoteV3(t, pool, block.number) : 0;

      // dollarize weth-quoted pools. usability was checked before the loop.
      let spot = perShareQuote;
      let depth = raw.depthQuote;
      let ethUsdRate: number | null = null;
      if (isWeth) {
        const rate = ethUsd!.rate;
        ethUsdRate = rate;
        spot = dollarize(perShareQuote, rate);
        depth = dollarize(raw.depthQuote, rate);
      }

      return {
        token: t,
        blockNumber: block.number,
        ts: new Date(Number(block.timestamp) * 1000),
        spot,
        rawSpot: raw.rawSpot,
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

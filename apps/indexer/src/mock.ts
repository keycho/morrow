// mock mode. synthetic pool readings and proxy ticks so the entire pipeline
// (indexer -> engine -> commits -> api -> web) can run before a single
// placeholder in config.ts is filled. deterministic per process via a seeded
// lcg so replays look stable.

import {
  activeFetchSources,
  tokens,
  wethTokensPresent,
  type TokenConfig,
} from "@fletch/config";
import type { PoolReading } from "./pools.js";
import type { ProxyFetchResult } from "./proxies.js";

// synthetic eth/usd rate for mock mode, used only when a weth token is
// tracked so the dollarization source shows fresh.
const MOCK_ETH_USD = 3_500;

// small lcg. not crypto, just repeatable wiggle.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// synthetic anchor prices per symbol, also seeded as mock close anchors.
export const mockBasePrices: Record<string, number> = {
  tsla: 250,
  aapl: 210,
  nvda: 130,
  msft: 420,
  amzn: 190,
  googl: 355,
  meta: 660,
  spy: 740,
};

interface MockState {
  price: number;
  rng: () => number;
}

const state = new Map<number, MockState>();
let mockBlock = 1_000_000n;

function stateFor(t: TokenConfig): MockState {
  let s = state.get(t.id);
  if (!s) {
    s = { price: mockBasePrices[t.symbol] ?? 100, rng: makeRng(t.id * 2654435761) };
    state.set(t.id, s);
  }
  return s;
}

export function mockPoolReading(t: TokenConfig): PoolReading {
  const s = stateFor(t);
  // gentle random walk, ±0.15% per tick
  const step = (s.rng() - 0.5) * 0.003;
  s.price = s.price * (1 + step);
  mockBlock += 300n; // ~30s of 100ms blocks
  // depth wanders between thin and healthy so the depth scaling is visible
  const depth = 20_000 + s.rng() * 180_000;
  // mock tokens report an unscaled multiplier; no synthetic splits.
  return {
    token: t,
    blockNumber: mockBlock,
    ts: new Date(),
    spot: s.price,
    rawSpot: s.price,
    depthQuote2pct: depth,
    volumeDeltaQuote: s.rng() * 50_000,
    uiMultiplier: 1,
    uiMultiplierMissing: false,
    // mock spots are already in usd; no dollarization is applied.
    ethUsdRate: wethTokensPresent() ? MOCK_ETH_USD : null,
  };
}

export function mockProxyResults(): ProxyFetchResult[] {
  return activeFetchSources().map((source) => {
    if (source.symbol === "ethusd") {
      return { source, ok: true, value: MOCK_ETH_USD, latencyMs: 20, skippedByBreaker: false };
    }
    const token = tokens.find((t) => t.symbol === source.symbol);
    const s = token ? stateFor(token) : undefined;
    const base = s ? s.price : 100;
    const noise = s ? (s.rng() - 0.5) * 0.002 : 0;
    return {
      source,
      ok: true,
      value: base * (1 + noise),
      latencyMs: 20,
      skippedByBreaker: false,
    };
  });
}

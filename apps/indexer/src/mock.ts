// mock mode. synthetic pool readings and proxy ticks so the entire pipeline
// (indexer -> engine -> commits -> api -> web) can run before a single
// placeholder in config.ts is filled. deterministic per process via a seeded
// lcg so replays look stable.

import { tokens, proxySources, type TokenConfig } from "@fletch/config";
import type { PoolReading } from "./pools.js";
import type { ProxyFetchResult } from "./proxies.js";

// small lcg. not crypto, just repeatable wiggle.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const basePrices: Record<string, number> = {
  tsla: 250,
  aapl: 210,
  nvda: 130,
  msft: 420,
  amzn: 190,
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
    s = { price: basePrices[t.symbol] ?? 100, rng: makeRng(t.id * 2654435761) };
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
  return {
    token: t,
    blockNumber: mockBlock,
    ts: new Date(),
    spot: s.price,
    depthQuote2pct: depth,
    volumeDeltaQuote: s.rng() * 50_000,
  };
}

export function mockProxyResults(): ProxyFetchResult[] {
  return proxySources.map((source) => {
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

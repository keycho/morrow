// shared types for pool discovery. a discovered pool carries the token id and
// symbol (not the full token config) so a run serializes cleanly to json for
// the pool_discovery_runs dataset and for `discover-pools --json`.

import type { Hex } from "viem";
import type { PoolProtocol } from "@morrow/config";

// a quote asset a pool can be priced in. usdg is dollar denominated; weth and
// native eth need the eth/usd rate to dollarize price and depth.
export interface QuoteDef {
  label: "usdg" | "weth" | "eth";
  address: Hex;
  // true when the price/depth are in eth and must be multiplied by eth/usd.
  dollarize: boolean;
}

// one pool found on one venue for one token, already priced and depth-measured.
export interface DiscoveredPool {
  tokenId: number;
  symbol: string;
  protocol: PoolProtocol;
  quote: QuoteDef["label"];
  // fee tier in hundredths of a bip, or null for v2 (no fee tiers).
  fee: number | null;
  // pool/pair address for v2 and v3, or the v4 pool id (bytes32).
  identifier: Hex;
  invert: boolean;
  baseDecimals: number;
  quoteDecimals: number;
  // per-share price in quote units, and in usd (dollarized where needed, or
  // null when a weth/eth pool cannot be dollarized without eth/usd).
  priceQuote: number;
  priceUsd: number | null;
  depthQuote: number;
  depthUsd: number | null;
  liquidity: string;
  // true when the pool has effectively no liquidity; never selected.
  empty: boolean;
}

// a discovered pool with the plausibility judgement applied.
export interface Judged extends DiscoveredPool {
  // true when the per-share price deviates more than the config threshold from
  // the anchor reference (only set when a reference was available).
  implausible: boolean;
  // relative deviation from the reference, or null when no reference.
  deviation: number | null;
}

// the pool chosen for a token, or null with the reason it was excluded.
export interface Selection {
  tokenId: number;
  symbol: string;
  chosen: Judged | null;
  reason: string;
}

// the full result of a discovery run. this is what is stored in
// pool_discovery_runs.results and printed by `discover-pools --json`.
export interface DiscoveryResult {
  // eth/usd rate used to dollarize weth/eth pools, or null when unset.
  ethUsd: number | null;
  judged: Judged[];
  selections: Selection[];
}

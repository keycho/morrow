// demo perps derivation. turns a morrow fair value row into a plausible 24/7
// perp market: the mark is morrow's off-hours fair value, funding tracks the
// pool basis, and the off-hours risk dial (max leverage) is gated on morrow's
// confidence. pure and deterministic; this is demo scaffolding, wired only when
// DEMO is on (see the perps page and SiteHeader).

import type { FairValue } from "./api";

export interface PerpMarket {
  symbol: string;
  name: string;
  mark: number; // = morrow off-hours fair value
  poolSpot: number | null;
  basisPct: number | null; // pool vs mark
  fundingHourlyPct: number; // signed, longs pay shorts when positive
  openInterestUsd: number;
  longPct: number; // 0-100
  confidence: number;
  maxLeverage: number; // off-hours, gated on confidence
  cycleId: number;
  suspect: boolean;
}

// off-hours leverage dial: the lower morrow's confidence, the tighter the cap.
export function maxLeverageFor(confidence: number): number {
  if (confidence >= 45) return 10;
  if (confidence >= 40) return 8;
  if (confidence >= 35) return 5;
  if (confidence >= 25) return 3;
  return 2;
}

export function derivePerp(r: FairValue): PerpMarket {
  const basisPct =
    r.onchainSpot !== null && r.fairValue !== 0 ? (r.onchainSpot / r.fairValue - 1) * 100 : null;
  // funding pulls the perp toward the mark: a fraction of the basis per hour.
  const fundingHourlyPct = basisPct === null ? 0 : Math.max(-0.1, Math.min(0.1, basisPct / 8));
  const openInterestUsd = 800_000 + r.confidence * 90_000 + r.tokenId * 120_000;
  const longPct = 50 + Math.round(Math.sin(r.tokenId * 1.3) * 8);
  return {
    symbol: r.symbol,
    name: r.name,
    mark: r.fairValue,
    poolSpot: r.onchainSpot,
    basisPct,
    fundingHourlyPct,
    openInterestUsd,
    longPct,
    confidence: r.confidence,
    maxLeverage: maxLeverageFor(r.confidence),
    cycleId: r.cycleId,
    suspect: r.suspect,
  };
}

// approximate liquidation price: entry adjusted by the initial margin fraction
// plus a small maintenance buffer. illustrative, not an exchange formula.
export function liquidationPrice(entry: number, leverage: number, side: "long" | "short"): number {
  const m = 1 / leverage - 0.005;
  return side === "long" ? entry * (1 - m) : entry * (1 + m);
}

export function fmtUsdCompact(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}m`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

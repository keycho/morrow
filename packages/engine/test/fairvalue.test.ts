import { describe, expect, it } from "vitest";
import {
  applyCorporateActionFilter,
  blendedDrift,
  computeFairValue,
  liquidityWeightedTwap,
  type EngineObservation,
  type FairValueInput,
  type FairValueResult,
  type ModelConfig,
  type ProxyInput,
} from "../src/index.js";

// mirrors the defaults in packages/config/config.ts. tests pin their own
// copy so retuning production never silently rewrites these expectations.
const cfg: ModelConfig = {
  onchainWeight: 0.6,
  depthFloorQuote: 50_000,
  maxOnchainDeviation: 0.05,
  spikeThreshold: 0.1,
  proxyFlatThreshold: 0.002,
  maxDriftAbs: 0.2,
  band: { basePct: 0.005, confidenceScalePct: 0.045 },
  confidence: {
    weights: { freshness: 0.35, depth: 0.35, proxyAgreement: 0.3 },
    freshnessHalfLifeMs: 120_000,
    proxyDisagreementFullPct: 0.03,
  },
  marketOpen: { onchainWeight: 0.9, bandBasePct: 0.002 },
  corporateAction: { bandWidenPct: 0.03, maxConfidence: 50, changeRelTolerance: 1e-6 },
};

const NOW = Date.UTC(2026, 6, 11, 12, 0, 0); // saturday noon utc

// n observations spread over the trailing hour, newest at `now`. every
// observation carries a ui multiplier (default 1 = unscaled).
function flatObservations(
  spot: number,
  depth: number,
  n = 12,
  multiplier = 1
): EngineObservation[] {
  const out: EngineObservation[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      tsMs: NOW - (n - 1 - i) * 5 * 60_000,
      spot,
      depthQuote: depth,
      uiMultiplier: multiplier,
    });
  }
  return out;
}

function proxy(name: string, closeValue: number, currentValue: number, ageMs = 0): ProxyInput {
  return {
    name,
    weight: 1,
    closeValue,
    currentValue,
    currentTsMs: NOW - ageMs,
    stalenessMs: 180_000,
  };
}

function compute(input: Partial<FairValueInput>): FairValueResult {
  const merged: FairValueInput = {
    nowMs: NOW,
    regime: "weekend",
    anchorPrice: 100,
    observations: flatObservations(100, 100_000),
    proxies: [proxy("a", 100, 100), proxy("b", 100, 100)],
    ...input,
  };
  const result = computeFairValue(merged, cfg);
  if (!result.ok) throw new Error(`expected ok result, got: ${result.reason}`);
  return result;
}

describe("liquidity weighted twap", () => {
  it("weights by time and depth", () => {
    const obs: EngineObservation[] = [
      { tsMs: NOW - 20 * 60_000, spot: 100, depthQuote: 100_000, uiMultiplier: 1 },
      { tsMs: NOW - 10 * 60_000, spot: 110, depthQuote: 10_000, uiMultiplier: 1 }, // thin
    ];
    const { twap } = liquidityWeightedTwap(obs, NOW, cfg.depthFloorQuote);
    // thin second leg gets a 0.2 depth factor, so twap sits near 100
    expect(twap).not.toBeNull();
    expect(twap!).toBeGreaterThan(100);
    expect(twap!).toBeLessThan(102);
  });

  it("returns null on empty input", () => {
    const { twap, avgDepthFactor } = liquidityWeightedTwap([], NOW, cfg.depthFloorQuote);
    expect(twap).toBeNull();
    expect(avgDepthFactor).toBe(0);
  });
});

describe("thin pool attack", () => {
  it("a thin pool cannot drag fair value from anchor plus drift", () => {
    // attacker holds the pool 30% above anchor, but depth is 1k against a
    // 50k floor. proxies are flat. no spike inside the window (price was
    // already parked there), so this exercises pure depth scaling plus the
    // deviation clamp.
    const result = compute({
      observations: flatObservations(130, 1_000),
    });
    expect(result.suspect).toBe(false);
    // deviation clamp caps the onchain pull at +5%, depth scaling shrinks
    // its weight to 0.6 * (1000/50000) = 0.012
    expect(result.fairValue).toBeLessThan(101);
    expect(result.fairValue).toBeGreaterThanOrEqual(100);
    // confidence reflects the hollow book
    expect(result.confidence).toBeLessThan(75);
  });

  it("the same displacement with a deep book moves fair value further but stays clamped", () => {
    const thin = compute({ observations: flatObservations(130, 1_000) });
    const deep = compute({ observations: flatObservations(130, 100_000) });
    expect(deep.fairValue).toBeGreaterThan(thin.fairValue);
    // even at full depth the clamp holds the onchain leg at 105
    expect(deep.fairValue).toBeLessThanOrEqual(0.6 * 105 + 0.4 * 100 + 1e-9);
  });
});

describe("stale proxy", () => {
  it("excludes stale proxies from drift", () => {
    const stale = [proxy("a", 100, 105, 10 * 60_000), proxy("b", 100, 105, 10 * 60_000)];
    const { drift, proxiesUsed } = blendedDrift(stale, NOW, cfg.maxDriftAbs);
    expect(proxiesUsed).toBe(0);
    expect(drift).toBe(0);
  });

  it("stale proxies drop confidence and leave fair value anchored", () => {
    const fresh = compute({
      proxies: [proxy("a", 100, 105), proxy("b", 100, 105)],
      observations: flatObservations(105, 100_000),
    });
    const stale = compute({
      proxies: [proxy("a", 100, 105, 10 * 60_000), proxy("b", 100, 105, 10 * 60_000)],
      observations: flatObservations(105, 100_000),
    });
    // fresh proxies lift anchor+drift to 105; stale ones leave it at 100 and
    // only the clamped onchain leg pulls upward
    expect(fresh.fairValue).toBeGreaterThan(stale.fairValue);
    expect(stale.components.drift).toBe(0);
    expect(stale.confidence).toBeLessThan(fresh.confidence);
  });
});

describe("weekend regime", () => {
  it("carries the weekend regime through and blends drift with the pool", () => {
    const result = compute({
      regime: "weekend",
      proxies: [proxy("a", 100, 101), proxy("b", 100, 101)],
      observations: flatObservations(100.8, 100_000),
    });
    expect(result.regime).toBe("weekend");
    expect(result.suspect).toBe(false);
    // anchor+drift = 101, twap = 100.8, weight 0.6
    expect(result.fairValue).toBeCloseTo(0.6 * 100.8 + 0.4 * 101, 6);
    expect(result.bandLow).toBeLessThan(result.fairValue);
    expect(result.bandHigh).toBeGreaterThan(result.fairValue);
  });
});

describe("spike clamp", () => {
  it("clamps an onchain spike with flat proxies to the band edge and flags suspect", () => {
    // pool jumps 15% mid-window while both proxies sit exactly at close.
    // newest observation is current so confidence is pinned at 100 raw,
    // halved to 50 by the suspect flag: band half-width becomes
    // 100 * (0.005 + 0.045 * 0.5) = 2.75, below the provisional blend of
    // 103, so the clamp binds.
    const obs: EngineObservation[] = [];
    for (let i = 0; i < 6; i++) {
      obs.push({ tsMs: NOW - (11 - i) * 5 * 60_000, spot: 100, depthQuote: 100_000, uiMultiplier: 1 });
    }
    for (let i = 6; i < 12; i++) {
      obs.push({ tsMs: NOW - (11 - i) * 5 * 60_000, spot: 115, depthQuote: 100_000, uiMultiplier: 1 });
    }
    const result = compute({ observations: obs });
    expect(result.suspect).toBe(true);
    // clamped exactly to the upper band edge around anchor+drift
    expect(result.fairValue).toBeCloseTo(result.bandHigh, 9);
    // and well below the naive blend toward 115
    expect(result.fairValue).toBeLessThan(103);
    // confidence is halved by the suspect flag: raw 100 -> 50
    expect(result.confidence).toBeLessThanOrEqual(50);
  });

  it("does not flag the same move when proxies confirm it", () => {
    const obs: EngineObservation[] = [];
    for (let i = 0; i < 6; i++) {
      obs.push({ tsMs: NOW - (11 - i) * 5 * 60_000, spot: 100, depthQuote: 100_000, uiMultiplier: 1 });
    }
    for (let i = 6; i < 12; i++) {
      obs.push({ tsMs: NOW - (11 - i) * 5 * 60_000, spot: 115, depthQuote: 100_000, uiMultiplier: 1 });
    }
    const result = compute({
      observations: obs,
      proxies: [proxy("a", 100, 114), proxy("b", 100, 115)],
    });
    expect(result.suspect).toBe(false);
  });
});

describe("corporate action (erc-8056)", () => {
  it("multiplier of 1 throughout is a normal cycle, not a corporate action", () => {
    const result = compute({
      observations: flatObservations(100, 100_000, 12, 1),
    });
    expect(result.corporateAction).toBe(false);
    expect(result.components.excludedPreChangeTicks).toBe(0);
    expect(result.fairValue).toBeCloseTo(100, 6);
  });

  it("a missing-function token reads as multiplier 1 and prices normally", () => {
    // the pool reader treats a token without uiMultiplier() as m = 1 (and
    // flags the tick missing). at the engine that is a constant multiplier,
    // so no corporate action fires and fair value is unaffected. the decode
    // itself is pinned in scaledui.test.ts.
    const result = compute({
      observations: flatObservations(100, 100_000, 12, 1),
      proxies: [proxy("a", 100, 101), proxy("b", 100, 101)],
    });
    expect(result.corporateAction).toBe(false);
    expect(result.fairValue).toBeCloseTo(0.6 * 100 + 0.4 * 101, 6);
  });

  it("a 10:1 split mid-window is flagged, pre-change ticks excluded, band widened", () => {
    // first half at m=1 with effective per-share price 1000 (pre-split),
    // second half at m=10 with effective per-share price 100 (post-split).
    // the operator has re-based the anchor to the post-split 100.
    const obs: EngineObservation[] = [];
    for (let i = 0; i < 6; i++) {
      obs.push({ tsMs: NOW - (11 - i) * 5 * 60_000, spot: 1000, depthQuote: 100_000, uiMultiplier: 1 });
    }
    for (let i = 6; i < 12; i++) {
      obs.push({ tsMs: NOW - (11 - i) * 5 * 60_000, spot: 100, depthQuote: 100_000, uiMultiplier: 10 });
    }
    const result = compute({ anchorPrice: 100, observations: obs });

    expect(result.corporateAction).toBe(true);
    // the six pre-split ticks are dropped from the twap window
    expect(result.components.excludedPreChangeTicks).toBe(6);
    // the split jump never reaches the spike guard
    expect(result.suspect).toBe(false);
    // twap over the surviving post-split ticks is 100, anchor+drift is 100
    expect(result.fairValue).toBeCloseTo(100, 6);
    // confidence is capped at the corporate-action ceiling
    expect(result.confidence).toBeLessThanOrEqual(50);
    // the band carries at least the widen contribution (2 x 0.03 of fair)
    const width = (result.bandHigh - result.bandLow) / result.fairValue;
    expect(width).toBeGreaterThanOrEqual(0.06);
  });

  it("a split cycle has a wider band than the same cycle without the flag", () => {
    const splitObs: EngineObservation[] = [];
    for (let i = 0; i < 6; i++) {
      splitObs.push({ tsMs: NOW - (11 - i) * 5 * 60_000, spot: 1000, depthQuote: 100_000, uiMultiplier: 1 });
    }
    for (let i = 6; i < 12; i++) {
      splitObs.push({ tsMs: NOW - (11 - i) * 5 * 60_000, spot: 100, depthQuote: 100_000, uiMultiplier: 10 });
    }
    const split = compute({ anchorPrice: 100, observations: splitObs });
    // same surviving prices, but no multiplier change: constant m=10, no flag
    const steady = compute({
      anchorPrice: 100,
      observations: flatObservations(100, 100_000, 6, 10),
    });
    expect(steady.corporateAction).toBe(false);
    const splitWidth = (split.bandHigh - split.bandLow) / split.fairValue;
    const steadyWidth = (steady.bandHigh - steady.bandLow) / steady.fairValue;
    expect(splitWidth).toBeGreaterThan(steadyWidth);
  });

  it("filter keeps only the latest-multiplier ticks", () => {
    const obs = [
      { tsMs: NOW - 30 * 60_000, spot: 1000, depthQuote: 100_000, uiMultiplier: 1 },
      { tsMs: NOW - 20 * 60_000, spot: 1000, depthQuote: 100_000, uiMultiplier: 1 },
      { tsMs: NOW - 10 * 60_000, spot: 100, depthQuote: 100_000, uiMultiplier: 10 },
      { tsMs: NOW, spot: 100, depthQuote: 100_000, uiMultiplier: 10 },
    ];
    const filtered = applyCorporateActionFilter(obs, cfg.corporateAction.changeRelTolerance);
    expect(filtered.corporateAction).toBe(true);
    expect(filtered.excluded).toBe(2);
    expect(filtered.observations).toHaveLength(2);
    expect(filtered.observations.every((o) => o.uiMultiplier === 10)).toBe(true);
  });
});

describe("friday close to monday open convergence", () => {
  it("tracks proxies over the weekend and hands off to the pool at the open", () => {
    const anchor = 100;
    const openPrint = 103.2;

    // saturday: proxies +2%, pool follows loosely
    const saturday = compute({
      regime: "weekend",
      anchorPrice: anchor,
      proxies: [proxy("a", 100, 102), proxy("b", 100, 102)],
      observations: flatObservations(101.5, 100_000),
    });
    expect(saturday.fairValue).toBeCloseTo(0.6 * 101.5 + 0.4 * 102, 6);

    // monday premarket: proxies +3%, pool tightens toward the expected open
    const premarket = compute({
      regime: "after_hours",
      anchorPrice: anchor,
      proxies: [proxy("a", 100, 103), proxy("b", 100, 103)],
      observations: flatObservations(102.8, 100_000),
    });
    expect(premarket.fairValue).toBeGreaterThan(saturday.fairValue);

    // monday open: passthrough mode leans 0.9 on the live pool
    const open = compute({
      regime: "market_open",
      anchorPrice: anchor,
      proxies: [proxy("a", 100, 103), proxy("b", 100, 103)],
      observations: flatObservations(openPrint, 100_000),
    });
    expect(open.regime).toBe("market_open");
    expect(open.fairValue).toBeCloseTo(0.9 * openPrint + 0.1 * 103, 6);

    // each step converges on the realized open print
    const err = (v: number): number => Math.abs(v - openPrint);
    expect(err(premarket.fairValue)).toBeLessThan(err(saturday.fairValue));
    expect(err(open.fairValue)).toBeLessThan(err(premarket.fairValue));

    // the open regime band is tighter than the weekend band
    const widthOpen = (open.bandHigh - open.bandLow) / open.fairValue;
    const widthWeekend = (saturday.bandHigh - saturday.bandLow) / saturday.fairValue;
    expect(widthOpen).toBeLessThan(widthWeekend);
  });
});

describe("degraded inputs", () => {
  it("fails cleanly with no anchor and no observations", () => {
    const result = computeFairValue(
      { nowMs: NOW, regime: "weekend", anchorPrice: null, observations: [], proxies: [] },
      cfg
    );
    expect(result.ok).toBe(false);
  });

  it("runs pure onchain when no anchor exists yet", () => {
    const result = computeFairValue(
      {
        nowMs: NOW,
        regime: "after_hours",
        anchorPrice: null,
        observations: flatObservations(50, 100_000),
        proxies: [],
      },
      cfg
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fairValue).toBeCloseTo(50, 6);
    }
  });

  it("runs anchor plus drift when the pool is empty", () => {
    const result = computeFairValue(
      {
        nowMs: NOW,
        regime: "weekend",
        anchorPrice: 100,
        observations: [],
        proxies: [proxy("a", 100, 101), proxy("b", 100, 101)],
      },
      cfg
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fairValue).toBeCloseTo(101, 6);
      expect(result.components.effectiveOnchainWeight).toBe(0);
    }
  });

  it("caps runaway drift at maxDriftAbs", () => {
    const { drift } = blendedDrift([proxy("a", 100, 150)], NOW, cfg.maxDriftAbs);
    expect(drift).toBe(cfg.maxDriftAbs);
  });
});

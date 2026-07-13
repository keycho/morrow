import { describe, expect, it } from "vitest";
import {
  computeFairValue,
  dollarize,
  ethUsdUsable,
  type EngineObservation,
  type ModelConfig,
} from "../src/index.js";

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);
const STALENESS_MS = 180_000;

describe("dollarize", () => {
  it("multiplies a weth price by the eth/usd rate", () => {
    // 0.06 eth per share at 3500 usd/eth = 210 usd per share
    expect(dollarize(0.06, 3500)).toBeCloseTo(210, 9);
  });

  it("dollarizes depth the same way", () => {
    // 2 eth of depth at 3500 = 7000 usd
    expect(dollarize(2, 3500)).toBe(7000);
  });
});

describe("ethUsdUsable", () => {
  it("accepts a fresh positive rate", () => {
    expect(ethUsdUsable({ rate: 3500, tsMs: NOW - 10_000 }, NOW, STALENESS_MS)).toBe(true);
  });

  it("rejects a stale rate", () => {
    expect(ethUsdUsable({ rate: 3500, tsMs: NOW - 200_000 }, NOW, STALENESS_MS)).toBe(false);
  });

  it("rejects a missing rate", () => {
    expect(ethUsdUsable(null, NOW, STALENESS_MS)).toBe(false);
    expect(ethUsdUsable(undefined, NOW, STALENESS_MS)).toBe(false);
  });

  it("rejects a non-positive or non-finite rate", () => {
    expect(ethUsdUsable({ rate: 0, tsMs: NOW }, NOW, STALENESS_MS)).toBe(false);
    expect(ethUsdUsable({ rate: -1, tsMs: NOW }, NOW, STALENESS_MS)).toBe(false);
    expect(ethUsdUsable({ rate: Number.NaN, tsMs: NOW }, NOW, STALENESS_MS)).toBe(false);
  });

  it("treats exactly at the staleness boundary as usable", () => {
    expect(ethUsdUsable({ rate: 3500, tsMs: NOW - STALENESS_MS }, NOW, STALENESS_MS)).toBe(true);
  });
});

// mirrors the config defaults; corporateAction block is required by the type.
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
  anchorStale: { bandWidenPct: 0.02, maxConfidence: 60 },
};

function obs(spot: number, depth: number, n = 12): EngineObservation[] {
  return Array.from({ length: n }, (_, i) => ({
    tsMs: NOW - (n - 1 - i) * 5 * 60_000,
    spot,
    depthQuote: depth,
    uiMultiplier: 1,
  }));
}

describe("stale eth/usd degrades confidence, never publishes a wrong price", () => {
  it("skipping the onchain observation lowers confidence and leaves fair value at anchor plus drift", () => {
    // when eth/usd is stale, the reader stores no observation for a weth
    // token. that is modeled here as an empty observation set. the engine
    // must not invent a price: it falls back to anchor plus drift, and
    // confidence is lower than when fresh dollarized onchain data is present.
    const proxies = [
      {
        name: "a",
        weight: 1,
        closeValue: 100,
        currentValue: 101,
        currentTsMs: NOW,
        stalenessMs: STALENESS_MS,
      },
      {
        name: "b",
        weight: 1,
        closeValue: 100,
        currentValue: 101,
        currentTsMs: NOW,
        stalenessMs: STALENESS_MS,
      },
    ];

    const withFresh = computeFairValue(
      { nowMs: NOW, regime: "after_hours", anchorPrice: 100, observations: obs(101, 100_000), proxies },
      cfg
    );
    const skipped = computeFairValue(
      { nowMs: NOW, regime: "after_hours", anchorPrice: 100, observations: [], proxies },
      cfg
    );

    expect(withFresh.ok).toBe(true);
    expect(skipped.ok).toBe(true);
    if (withFresh.ok && skipped.ok) {
      // no wrong price: fair value is exactly anchor plus drift (101)
      expect(skipped.fairValue).toBeCloseTo(101, 6);
      expect(skipped.components.effectiveOnchainWeight).toBe(0);
      // and confidence is strictly lower than with fresh onchain data
      expect(skipped.confidence).toBeLessThan(withFresh.confidence);
    }
  });
});

// fair value model. pure functions, no i/o, no clock reads, no config
// imports. every weight and threshold arrives as a parameter object that is
// structurally identical to `model` in packages/config/config.ts, so the
// indexer passes config straight through and tests pin their own numbers.
//
// composition per token per cycle:
//   anchor          last official close price
//   drift           weighted blend of proxy returns since close, capped
//   anchor+drift    the off-chain estimate
//   onchain twap    liquidity-weighted time average of pool price over the
//                   trailing window, clamped to ±maxOnchainDeviation around
//                   anchor+drift, weight scaled down as depth falls below
//                   the floor. a thin pool cannot drag fair value.
//   fair value      depth-scaled blend of the two
//   spike guard     onchain move beyond spikeThreshold while proxies were
//                   flat clamps output to the band edge and flags suspect.
//                   suspect rows are published, never hidden.
//   corporate action if the erc-8056 ui multiplier changed within the
//                   window, pre-change ticks are excluded from the twap, the
//                   cycle is flagged corporate_action, the band is widened,
//                   and confidence is capped. observations carry the
//                   effective per-share price already, so the split shows up
//                   as a discontinuity that this guard removes.

import type { Regime } from "./calendar.js";
import { multipliersDiffer } from "./scaledui.js";

export interface ModelConfig {
  onchainWeight: number;
  depthFloorQuote: number;
  maxOnchainDeviation: number;
  spikeThreshold: number;
  proxyFlatThreshold: number;
  maxDriftAbs: number;
  band: {
    basePct: number;
    confidenceScalePct: number;
  };
  confidence: {
    weights: {
      freshness: number;
      depth: number;
      proxyAgreement: number;
    };
    freshnessHalfLifeMs: number;
    proxyDisagreementFullPct: number;
  };
  marketOpen: {
    onchainWeight: number;
    bandBasePct: number;
  };
  corporateAction: {
    bandWidenPct: number;
    maxConfidence: number;
    changeRelTolerance: number;
  };
  anchorStale: {
    bandWidenPct: number;
    maxConfidence: number;
  };
}

export interface EngineObservation {
  tsMs: number;
  // effective per-share price (raw pool price already divided by the ui
  // multiplier in force at read time).
  spot: number;
  depthQuote: number;
  // erc-8056 ui multiplier in force at this observation (m = uiMultiplier /
  // 1e18). 1 for unscaled or non-erc-8056 tokens.
  uiMultiplier: number;
}

export interface ProxyInput {
  name: string;
  weight: number;
  // proxy value snapshotted at (or just before) the last official close.
  closeValue: number | null;
  currentValue: number | null;
  currentTsMs: number | null;
  stalenessMs: number;
}

export interface FairValueInput {
  nowMs: number;
  regime: Regime;
  anchorPrice: number | null;
  // true when the anchor is older than the most recent official close, i.e.
  // an expected close print was missed. the engine keeps producing a number
  // but caps confidence and widens the band so the feed does not go dark or
  // overstate certainty. the indexer computes this from the anchor timestamp.
  anchorStale?: boolean;
  // ascending by tsMs, all within the trailing twap window.
  observations: EngineObservation[];
  proxies: ProxyInput[];
}

export interface FairValueComponents {
  anchorPlusDrift: number | null;
  drift: number;
  driftProxiesUsed: number;
  twapRaw: number | null;
  twapClamped: number | null;
  onchainSpot: number | null;
  avgDepthFactor: number;
  avgDepthQuote: number;
  effectiveOnchainWeight: number;
  windowMovePct: number;
  proxiesFlat: boolean;
  // count of ticks dropped from the window because the ui multiplier changed.
  excludedPreChangeTicks: number;
}

export interface FairValueResult {
  ok: true;
  fairValue: number;
  confidence: number;
  bandLow: number;
  bandHigh: number;
  regime: Regime;
  suspect: boolean;
  corporateAction: boolean;
  anchorStale: boolean;
  components: FairValueComponents;
}

export interface FairValueFailure {
  ok: false;
  reason: string;
  regime: Regime;
  corporateAction: boolean;
  anchorStale: boolean;
}

export type FairValueOutcome = FairValueResult | FairValueFailure;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// detect an erc-8056 multiplier change within the window and keep only the
// ticks at the most recent multiplier. the effective per-share price jumps
// at a split, so mixing pre- and post-change ticks would corrupt the twap
// and trip the spike guard; excluding the pre-change ticks removes both.
export function applyCorporateActionFilter(
  observations: EngineObservation[],
  relTolerance: number
): { observations: EngineObservation[]; corporateAction: boolean; excluded: number } {
  if (observations.length === 0) {
    return { observations, corporateAction: false, excluded: 0 };
  }
  const latest = observations[observations.length - 1]!.uiMultiplier;
  let changed = false;
  const kept: EngineObservation[] = [];
  for (const obs of observations) {
    if (multipliersDiffer(obs.uiMultiplier, latest, relTolerance)) {
      changed = true;
      continue; // pre-change tick, drop it
    }
    kept.push(obs);
  }
  return { observations: kept, corporateAction: changed, excluded: observations.length - kept.length };
}

// liquidity-weighted twap. each observation is weighted by the time it was
// in force multiplied by its depth factor (depth relative to the floor,
// capped at 1). returns null when there is nothing usable.
export function liquidityWeightedTwap(
  observations: EngineObservation[],
  nowMs: number,
  depthFloorQuote: number
): { twap: number | null; avgDepthFactor: number; avgDepthQuote: number } {
  if (observations.length === 0) {
    return { twap: null, avgDepthFactor: 0, avgDepthQuote: 0 };
  }
  let weightSum = 0;
  let priceSum = 0;
  let timeSum = 0;
  let depthFactorTimeSum = 0;
  let depthTimeSum = 0;
  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i]!;
    const nextTs = i + 1 < observations.length ? observations[i + 1]!.tsMs : nowMs;
    const dtMs = Math.max(0, nextTs - obs.tsMs);
    if (dtMs === 0) continue;
    const depthFactor =
      depthFloorQuote <= 0 ? 1 : clamp(obs.depthQuote / depthFloorQuote, 0, 1);
    const w = dtMs * depthFactor;
    weightSum += w;
    priceSum += w * obs.spot;
    timeSum += dtMs;
    depthFactorTimeSum += dtMs * depthFactor;
    depthTimeSum += dtMs * obs.depthQuote;
  }
  const avgDepthFactor = timeSum > 0 ? depthFactorTimeSum / timeSum : 0;
  const avgDepthQuote = timeSum > 0 ? depthTimeSum / timeSum : 0;
  if (weightSum <= 0) {
    return { twap: null, avgDepthFactor, avgDepthQuote };
  }
  return { twap: priceSum / weightSum, avgDepthFactor, avgDepthQuote };
}

export interface DriftResult {
  drift: number;
  proxiesUsed: number;
  returns: number[];
}

// weighted blend of proxy returns since close. stale or incomplete proxies
// contribute nothing. the blend is capped at ±maxDriftAbs.
export function blendedDrift(
  proxies: ProxyInput[],
  nowMs: number,
  maxDriftAbs: number
): DriftResult {
  let weightSum = 0;
  let sum = 0;
  const returns: number[] = [];
  for (const p of proxies) {
    if (
      p.closeValue === null ||
      p.currentValue === null ||
      p.currentTsMs === null ||
      p.closeValue <= 0 ||
      nowMs - p.currentTsMs > p.stalenessMs
    ) {
      continue;
    }
    const r = p.currentValue / p.closeValue - 1;
    returns.push(r);
    weightSum += p.weight;
    sum += p.weight * r;
  }
  if (weightSum === 0) return { drift: 0, proxiesUsed: 0, returns };
  const raw = sum / weightSum;
  return { drift: clamp(raw, -maxDriftAbs, maxDriftAbs), proxiesUsed: returns.length, returns };
}

export interface ConfidenceInput {
  nowMs: number;
  newestObservationTsMs: number | null;
  newestProxyTsMs: number | null;
  avgDepthFactor: number;
  proxyReturns: number[];
}

// confidence 0-100: freshness of inputs, pool depth, proxy agreement.
export function scoreConfidence(input: ConfidenceInput, cfg: ModelConfig): number {
  const { weights, freshnessHalfLifeMs, proxyDisagreementFullPct } = cfg.confidence;

  const freshnessOf = (ts: number | null): number => {
    if (ts === null) return 0;
    const age = Math.max(0, input.nowMs - ts);
    return 2 ** (-age / freshnessHalfLifeMs);
  };
  const freshness =
    (freshnessOf(input.newestObservationTsMs) + freshnessOf(input.newestProxyTsMs)) / 2;

  const depth = clamp(input.avgDepthFactor, 0, 1);

  let agreement: number;
  if (input.proxyReturns.length >= 2) {
    let maxGap = 0;
    for (let i = 0; i < input.proxyReturns.length; i++) {
      for (let j = i + 1; j < input.proxyReturns.length; j++) {
        maxGap = Math.max(maxGap, Math.abs(input.proxyReturns[i]! - input.proxyReturns[j]!));
      }
    }
    agreement = clamp(1 - maxGap / proxyDisagreementFullPct, 0, 1);
  } else if (input.proxyReturns.length === 1) {
    // one live proxy: no cross-check possible, middling score.
    agreement = 0.5;
  } else {
    agreement = 0;
  }

  const score =
    weights.freshness * freshness + weights.depth * depth + weights.proxyAgreement * agreement;
  return Math.round(clamp(score, 0, 1) * 100);
}

export function computeFairValue(input: FairValueInput, cfg: ModelConfig): FairValueOutcome {
  const { regime } = input;
  const anchorStale = input.anchorStale === true;

  // corporate action: drop pre-change ticks before any pricing math runs.
  const ca = applyCorporateActionFilter(input.observations, cfg.corporateAction.changeRelTolerance);
  const observations = ca.observations;
  const corporateAction = ca.corporateAction;

  const { twap, avgDepthFactor, avgDepthQuote } = liquidityWeightedTwap(
    observations,
    input.nowMs,
    cfg.depthFloorQuote
  );
  const driftResult = blendedDrift(input.proxies, input.nowMs, cfg.maxDriftAbs);

  const lastObs = observations.length > 0 ? observations[observations.length - 1]! : null;
  const firstObs = observations.length > 0 ? observations[0]! : null;
  const windowMovePct =
    firstObs && lastObs && firstObs.spot > 0
      ? Math.abs(lastObs.spot / firstObs.spot - 1)
      : 0;

  const anchorPlusDrift =
    input.anchorPrice !== null && input.anchorPrice > 0
      ? input.anchorPrice * (1 + driftResult.drift)
      : null;

  if (anchorPlusDrift === null && twap === null) {
    return {
      ok: false,
      reason: "no anchor and no onchain observations",
      regime,
      corporateAction,
      anchorStale,
    };
  }

  const baseOnchainWeight =
    regime === "market_open" ? cfg.marketOpen.onchainWeight : cfg.onchainWeight;

  let twapClamped: number | null = twap;
  let fair: number;
  let effectiveOnchainWeight: number;

  if (anchorPlusDrift === null) {
    // no anchor yet (fresh listing before the first admin insert). pure
    // onchain, confidence will be depth and freshness bound.
    fair = twap as number;
    effectiveOnchainWeight = 1;
  } else if (twap === null) {
    fair = anchorPlusDrift;
    effectiveOnchainWeight = 0;
  } else {
    twapClamped = clamp(
      twap,
      anchorPlusDrift * (1 - cfg.maxOnchainDeviation),
      anchorPlusDrift * (1 + cfg.maxOnchainDeviation)
    );
    effectiveOnchainWeight = clamp(baseOnchainWeight * avgDepthFactor, 0, 1);
    fair = effectiveOnchainWeight * twapClamped + (1 - effectiveOnchainWeight) * anchorPlusDrift;
  }

  const newestProxyTs = input.proxies.reduce<number | null>((acc, p) => {
    if (p.currentTsMs === null) return acc;
    return acc === null ? p.currentTsMs : Math.max(acc, p.currentTsMs);
  }, null);

  let confidence = scoreConfidence(
    {
      nowMs: input.nowMs,
      newestObservationTsMs: lastObs ? lastObs.tsMs : null,
      newestProxyTsMs: newestProxyTs,
      avgDepthFactor,
      proxyReturns: driftResult.returns,
    },
    cfg
  );

  // corporate action and a stale anchor each cap confidence and widen the
  // band for the cycle. the widen contributions add.
  if (corporateAction) {
    confidence = Math.min(confidence, cfg.corporateAction.maxConfidence);
  }
  if (anchorStale) {
    confidence = Math.min(confidence, cfg.anchorStale.maxConfidence);
  }
  const extraBandWiden =
    (corporateAction ? cfg.corporateAction.bandWidenPct : 0) +
    (anchorStale ? cfg.anchorStale.bandWidenPct : 0);

  // spike guard. an onchain move beyond the threshold inside one window,
  // with flat proxies, is treated as manipulation or a broken pool until
  // proven otherwise: clamp to the band edge around anchor+drift, flag it,
  // and let the api surface it.
  const proxiesFlat =
    driftResult.proxiesUsed > 0 && Math.abs(driftResult.drift) < cfg.proxyFlatThreshold;
  let suspect = false;

  const bandBasePct = regime === "market_open" ? cfg.marketOpen.bandBasePct : cfg.band.basePct;

  const components: FairValueComponents = {
    anchorPlusDrift,
    drift: driftResult.drift,
    driftProxiesUsed: driftResult.proxiesUsed,
    twapRaw: twap,
    twapClamped,
    onchainSpot: lastObs ? lastObs.spot : null,
    avgDepthFactor,
    avgDepthQuote,
    effectiveOnchainWeight,
    windowMovePct,
    proxiesFlat,
    excludedPreChangeTicks: ca.excluded,
  };

  if (
    regime !== "market_open" &&
    anchorPlusDrift !== null &&
    proxiesFlat &&
    windowMovePct > cfg.spikeThreshold
  ) {
    suspect = true;
    // suspect output is worth less by construction.
    confidence = Math.min(confidence, Math.round(confidence * 0.5));
    const half =
      anchorPlusDrift *
        (bandBasePct + cfg.band.confidenceScalePct * (1 - confidence / 100)) +
      anchorPlusDrift * extraBandWiden;
    fair = clamp(fair, anchorPlusDrift - half, anchorPlusDrift + half);
    return {
      ok: true,
      fairValue: fair,
      confidence,
      bandLow: anchorPlusDrift - half,
      bandHigh: anchorPlusDrift + half,
      regime,
      suspect,
      corporateAction,
      anchorStale,
      components,
    };
  }

  const half =
    fair * (bandBasePct + cfg.band.confidenceScalePct * (1 - confidence / 100)) +
    fair * extraBandWiden;
  return {
    ok: true,
    fairValue: fair,
    confidence,
    bandLow: fair - half,
    bandHigh: fair + half,
    regime,
    suspect,
    corporateAction,
    anchorStale,
    components,
  };
}

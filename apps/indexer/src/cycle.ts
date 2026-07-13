// fair value cycle runner. once per cycle (default 600s) it assembles engine
// inputs from the database, computes fair value per token, and upserts the
// results. the commit publisher (phase 4) consumes the rows this produces.
//
// everything tunable comes from @fletch/config; all math lives in
// @fletch/engine as pure functions.

import { calendar, mockMode, model, timing, tokens, proxiesForToken } from "@fletch/config";
import {
  computeFairValue,
  cycleIdFor,
  lastCloseTime,
  regimeAt,
  type CalendarConfig,
  type ProxyInput,
} from "@fletch/engine";
import {
  latestAnchor,
  latestProxyTick,
  proxyTickAt,
  recentObservations,
  upsertFairValues,
  type FairValueRow,
} from "./db.js";
import { log } from "./log.js";

const calendarConfig: CalendarConfig = {
  timezone: calendar.timezone,
  extraHolidays: calendar.extraHolidays,
  extraHalfDays: calendar.extraHalfDays,
};

let lastCompletedCycle = -1;

export interface CycleOutcome {
  cycleId: number;
  regime: string;
  rows: FairValueRow[];
  skipped: { symbol: string; reason: string }[];
}

// returns null when the current cycle has already been computed.
export async function maybeRunCycle(nowMs: number): Promise<CycleOutcome | null> {
  const cycleId = cycleIdFor(nowMs, timing.cycleSeconds);
  if (cycleId === lastCompletedCycle) return null;

  const now = new Date(nowMs);
  const regime = regimeAt(now, calendarConfig);
  const closeTime = lastCloseTime(now, calendarConfig);

  const rows: FairValueRow[] = [];
  const skipped: { symbol: string; reason: string }[] = [];

  for (const token of tokens) {
    try {
      const observations = await recentObservations(token.id, timing.twapWindowSeconds);
      const anchor = await latestAnchor(token.id, "close");

      const proxies: ProxyInput[] = [];
      for (const source of proxiesForToken(token.symbol)) {
        const current = await latestProxyTick(source.name);
        const close = await proxyTickAt(source.name, closeTime);
        proxies.push({
          name: source.name,
          weight: source.weight,
          closeValue: close ? close.value : null,
          currentValue: current ? current.value : null,
          currentTsMs: current ? current.ts.getTime() : null,
          stalenessMs: source.stalenessMs,
        });
      }

      const outcome = computeFairValue(
        {
          nowMs,
          regime,
          anchorPrice: anchor ? anchor.price : null,
          observations: observations.map((o) => ({
            tsMs: o.ts.getTime(),
            spot: o.poolSpot,
            depthQuote: o.depthQuote2pct,
            uiMultiplier: o.uiMultiplier,
          })),
          proxies,
        },
        model
      );

      if (!outcome.ok) {
        skipped.push({ symbol: token.symbol, reason: outcome.reason });
        continue;
      }

      rows.push({
        tokenId: token.id,
        cycleId,
        ts: now,
        fairValue: outcome.fairValue,
        confidence: outcome.confidence,
        bandLow: outcome.bandLow,
        bandHigh: outcome.bandHigh,
        regime: outcome.regime,
        suspect: outcome.suspect,
        corporateAction: outcome.corporateAction,
        anchorPrice: anchor ? anchor.price : null,
        drift: outcome.components.drift,
        onchainTwap: outcome.components.twapRaw,
        onchainSpot: outcome.components.onchainSpot,
        depthQuote: outcome.components.avgDepthQuote,
      });

      if (outcome.suspect) {
        log.warn("suspect fair value published", {
          token: token.symbol,
          cycleId,
          windowMovePct: outcome.components.windowMovePct,
        });
      }
      if (outcome.corporateAction) {
        log.warn("corporate action detected, cycle flagged", {
          token: token.symbol,
          cycleId,
          excludedPreChangeTicks: outcome.components.excludedPreChangeTicks,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push({ symbol: token.symbol, reason: message });
      log.error("cycle computation failed for token", { token: token.symbol, message });
    }
  }

  await upsertFairValues(rows);
  lastCompletedCycle = cycleId;

  log.info("cycle complete", {
    cycleId,
    regime,
    published: rows.length,
    skipped: skipped.length,
    mockMode,
  });

  return { cycleId, regime, rows, skipped };
}

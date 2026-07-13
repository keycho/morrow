// anchor scheduling and validation. pure decision functions; the indexer
// provides the clock, the http fetch, and the database. an anchor is the last
// official close (the model anchor) or the next-open print (feeds accuracy).
//
// the schedule fires an insert once per trading session, a configurable delay
// after the official close and open. validation guards against a bad feed
// print: a price that jumps more than a threshold from the previous anchor is
// rejected, unless a corporate action explains it (a split legitimately moves
// the per-share price). a missing anchor past a deadline is flagged so the
// operator is paged; the manual admin insert remains the override.

export type AnchorKind = "close" | "open";

// whether the scheduled insert for a target instant is due now: the delay has
// elapsed and it has not already been inserted.
export function anchorDue(params: {
  nowMs: number;
  targetMs: number;
  delayMinutes: number;
  alreadyInserted: boolean;
}): boolean {
  if (params.alreadyInserted) return false;
  return params.nowMs >= params.targetMs + params.delayMinutes * 60_000;
}

export interface AnchorValidation {
  ok: boolean;
  deviation: number;
  reason: string;
}

// validate a fetched anchor against the previous anchor of the same kind.
// the first anchor (no previous) always passes. a deviation beyond the
// threshold fails unless a corporate action is flagged for the token.
export function validateAnchor(params: {
  newPrice: number;
  prevPrice: number | null;
  deviationThreshold: number;
  corporateAction: boolean;
}): AnchorValidation {
  const { newPrice, prevPrice, deviationThreshold, corporateAction } = params;
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    return { ok: false, deviation: 0, reason: "price is not a positive number" };
  }
  if (prevPrice === null || prevPrice <= 0) {
    return { ok: true, deviation: 0, reason: "first anchor, no previous to compare" };
  }
  const deviation = Math.abs(newPrice / prevPrice - 1);
  if (deviation > deviationThreshold && !corporateAction) {
    return {
      ok: false,
      deviation,
      reason: `deviation ${(deviation * 100).toFixed(1)}% exceeds ${(deviationThreshold * 100).toFixed(1)}% with no corporate action`,
    };
  }
  if (deviation > deviationThreshold && corporateAction) {
    return { ok: true, deviation, reason: "large deviation allowed by corporate action" };
  }
  return { ok: true, deviation, reason: "within threshold" };
}

// whether a still-missing anchor has passed its ops deadline.
export function anchorMissed(params: {
  nowMs: number;
  targetMs: number;
  deadlineHours: number;
  inserted: boolean;
}): boolean {
  if (params.inserted) return false;
  return params.nowMs >= params.targetMs + params.deadlineHours * 3_600_000;
}

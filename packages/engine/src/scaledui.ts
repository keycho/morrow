// erc-8056 scaled-ui amount support. robinhood stock tokens implement this
// extension: uiMultiplier() returns an 18-decimal fixed-point scalar that
// maps raw token amounts to effective underlying shares, and it changes on
// corporate actions (splits, stock dividends) while raw balances stay fixed.
//
//   effective shares = raw amount * uiMultiplier / 1e18
//
// so one raw token equals m = uiMultiplier / 1e18 effective shares, and a
// price quoted per raw token converts to a per-share price by dividing by m.
// pure functions only; no i/o, no chain access.

// 1e18, the erc-8056 fixed-point one.
export const UI_MULTIPLIER_ONE = 10n ** 18n;

export interface DecodedMultiplier {
  // m = uiMultiplier / 1e18, the effective shares per raw token.
  multiplier: number;
  // true when the token does not expose uiMultiplier(); treated as m = 1.
  missing: boolean;
}

// decode a raw uiMultiplier() reading. a null reading means the call failed
// or the function is absent, in which case the multiplier is 1 and the tick
// is flagged missing so the anomaly is visible rather than silently assumed.
export function decodeUiMultiplier(raw: bigint | null | undefined): DecodedMultiplier {
  if (raw === null || raw === undefined) {
    return { multiplier: 1, missing: true };
  }
  if (raw <= 0n) {
    // a zero or negative multiplier is nonsensical; treat as 1 and flag.
    return { multiplier: 1, missing: true };
  }
  return { multiplier: Number(raw) / Number(UI_MULTIPLIER_ONE), missing: false };
}

// convert a per-raw-token price into a per-effective-share price. a split
// (m > 1) lowers the per-share price proportionally, matching the lower
// post-split quote per share. guards a non-positive multiplier by treating
// it as 1.
export function effectivePerSharePrice(rawPrice: number, multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return rawPrice;
  return rawPrice / multiplier;
}

// whether two multipliers differ enough to count as a corporate action.
// a real split is 2x or more; the tolerance only absorbs storage round-trip
// float noise so an unchanged multiplier never falsely flags.
export function multipliersDiffer(a: number, b: number, relTolerance: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) / scale > relTolerance;
}

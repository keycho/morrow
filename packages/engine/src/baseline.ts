// close-baseline freshness. the drift model measures each proxy's return since
// the last official close, so it needs a proxy tick captured at (or just
// before) that close. if the indexer was down across the close, the nearest
// tick at or before it is stale (or missing) and drift silently reads zero.
// this pure predicate lets the indexer detect that and page.

export function closeBaselineFresh(
  closeMs: number,
  tickMs: number | null,
  maxGapMs: number
): boolean {
  if (tickMs === null) return false;
  // a tick at or after the close moment anchors it directly.
  if (tickMs >= closeMs) return true;
  // otherwise it must be within the allowed gap before the close.
  return closeMs - tickMs <= maxGapMs;
}

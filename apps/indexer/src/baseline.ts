// close-baseline monitor. the drift model needs a proxy tick captured at (or
// just before) the 16:00 et close; without one, drift silently reads zero for
// the whole off-hours session. once per close, after a grace period, this
// checks that each active proxy source has a fresh baseline and pages if not.

import { activeFetchSources, baseline, calendar } from "@morrow/config";
import { closeBaselineFresh, lastCloseTime, type CalendarConfig } from "@morrow/engine";
import type { OpsAlerter } from "@morrow/telegram/ops";
import { proxyTickAt } from "./db.js";
import { log } from "./log.js";

const cal: CalendarConfig = {
  timezone: calendar.timezone,
  extraHolidays: calendar.extraHolidays,
  extraHalfDays: calendar.extraHalfDays,
};

let lastCheckedCloseMs = -1;

// exported for tests / manual reset; the indexer never calls this.
export function resetCloseBaselineState(): void {
  lastCheckedCloseMs = -1;
}

export async function checkCloseBaseline(nowMs: number, alerter: OpsAlerter): Promise<void> {
  const close = lastCloseTime(new Date(nowMs), cal);
  const closeMs = close.getTime();
  const graceMs = baseline.graceMinutes * 60_000;
  const windowMs = baseline.checkWindowMinutes * 60_000;
  const maxGapMs = baseline.maxGapMinutes * 60_000;

  const sinceClose = nowMs - closeMs;
  if (sinceClose < graceMs) return; // too soon; the straddling tick may not be written yet
  if (sinceClose > windowMs) return; // too old to matter, and may predate this process (cold start)
  if (closeMs === lastCheckedCloseMs) return; // already checked this close
  lastCheckedCloseMs = closeMs;

  const missing: string[] = [];
  for (const source of activeFetchSources()) {
    const tick = await proxyTickAt(source.name, close);
    if (!closeBaselineFresh(closeMs, tick ? tick.ts.getTime() : null, maxGapMs)) {
      missing.push(source.name);
    }
  }

  if (missing.length > 0) {
    log.error("close baseline missing", { close: close.toISOString(), missing });
    await alerter.alert({
      key: "close-baseline",
      severity: "page",
      title: "close baseline missing",
      message: `no proxy baseline captured at the ${close.toISOString()} close for: ${missing.join(
        ", "
      )}. drift will read zero for this session until fresh ticks land. was the indexer down across the close?`,
      detail: { close: close.toISOString(), missing },
    });
  } else {
    await alerter.resolve("close-baseline", "close baseline captured for all proxy sources");
  }
}

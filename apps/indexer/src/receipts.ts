// weekly receipt scheduler. on the configured weekday (America/New_York),
// once the open anchors have landed, generate last week's accuracy receipt.
// idempotent: generateWeeklyReceipt skips a week that already exists, and a
// per-day guard avoids re-checking every tick.

import { calendar, receipts } from "@fletch/config";
import { wallTimeAt } from "@fletch/engine";
import { generateWeeklyReceipt } from "@fletch/receipts";
import { db } from "./db.js";
import { log } from "./log.js";

const OPEN_MINUTES = 9 * 60 + 30;

let lastGeneratedDay = "";

export async function maybeGenerateReceipt(nowMs: number): Promise<void> {
  if (!receipts.autoGenerate) return;
  const w = wallTimeAt(new Date(nowMs), calendar.timezone);
  if (w.weekday !== receipts.generateWeekday) return;
  const minutes = w.hour * 60 + w.minute;
  if (minutes < OPEN_MINUTES + receipts.generateAfterOpenMinutes) return;

  const dayKey = `${w.year}-${w.month}-${w.day}`;
  if (dayKey === lastGeneratedDay) return;
  lastGeneratedDay = dayKey;

  try {
    const result = await generateWeeklyReceipt({
      pool: db(),
      now: { year: w.year, month: w.month, day: w.day },
    });
    if (result) {
      log.info("weekly receipt generated", {
        weekStart: result.weekStart,
        weekEnd: result.weekEnd,
        hadPng: result.hadPng,
        cyclesCommitted: result.cyclesCommitted,
      });
    }
  } catch (err) {
    log.error("weekly receipt generation failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

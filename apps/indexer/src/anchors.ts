// anchor scheduler. the imperative shell around the pure scheduling and
// validation helpers in @morrow/engine.
//
// once per session, a configurable delay after the official close and open,
// it fetches the anchor price per token and inserts it, skipping weekends and
// holidays via the nyse calendar and using the 13:00 close on half days.
// validation rejects a price that jumps beyond the deviation threshold unless
// a corporate action explains it. a missing anchor past its deadline raises an
// ops alert; the manual admin insert stays the override. in mock mode the
// price comes from realistic fixtures instead of http.

import {
  anchorSourceFor,
  anchors,
  calendar,
  mockMode,
  tokens,
  type AnchorSourceConfig,
  type ProxySourceConfig,
  type TokenConfig,
} from "@morrow/config";
import {
  anchorDue,
  anchorMissed,
  lastCloseTime,
  lastOpenTime,
  validateAnchor,
  type AnchorKind,
  type CalendarConfig,
} from "@morrow/engine";
import {
  anchorExistsAt,
  hadRecentCorporateAction,
  insertAnchor,
  latestAnchor,
} from "./db.js";
import { fetchProxy } from "./proxies.js";
import { mockBasePrices } from "./mock.js";
import type { OpsAlerter } from "@morrow/telegram/ops";
import { log } from "./log.js";

const calendarConfig: CalendarConfig = {
  timezone: calendar.timezone,
  extraHolidays: calendar.extraHolidays,
  extraHalfDays: calendar.extraHalfDays,
};

function urlFor(source: AnchorSourceConfig, kind: AnchorKind, symbol: string): string {
  const template = kind === "close" ? source.closeUrl : source.openUrl;
  return template
    .replaceAll("{symbol}", symbol)
    .replaceAll("{SYMBOL}", symbol.toUpperCase())
    .replaceAll("{apiKey}", anchors.apiKey);
}

// the price field to read for this kind: the per-kind override when set (a
// single quote endpoint exposes previous-close and open at different fields),
// else the source default.
function jsonPathFor(source: AnchorSourceConfig, kind: AnchorKind): string {
  const override = kind === "close" ? source.closeJsonPath : source.openJsonPath;
  return override ?? source.jsonPath;
}

async function fetchAnchorPrice(
  source: AnchorSourceConfig,
  kind: AnchorKind,
  symbol: string
): Promise<number | null> {
  if (mockMode) {
    // realistic fixture: the open prints a touch above the prior close.
    const base = mockBasePrices[symbol];
    if (base === undefined) return null;
    return kind === "open" ? base * 1.002 : base;
  }
  // reuse the generic http fetcher (shared client, timeout, retries, breaker).
  const asProxy: ProxySourceConfig = {
    name: `${source.name}:${kind}`,
    symbol,
    url: urlFor(source, kind, symbol),
    jsonPath: jsonPathFor(source, kind),
    weight: 1,
    timeoutMs: source.timeoutMs,
    retries: source.retries,
    stalenessMs: 3_600_000,
  };
  const res = await fetchProxy(asProxy);
  return res.ok && res.value !== undefined ? res.value : null;
}

async function processAnchor(
  token: TokenConfig,
  kind: AnchorKind,
  targetMs: number,
  delayMinutes: number,
  nowMs: number,
  alerter: OpsAlerter
): Promise<void> {
  const targetDate = new Date(targetMs);
  const missedKey = `anchor-missed:${token.symbol}:${kind}:${targetMs}`;
  const inserted = await anchorExistsAt(token.id, kind, targetDate);

  if (inserted) {
    // if this target was ever flagged missed, clear it.
    await alerter.resolve(missedKey, `${token.symbol} ${kind} anchor is present`);
    return;
  }

  if (
    anchorMissed({ nowMs, targetMs, deadlineHours: anchors.schedule.missedDeadlineHours, inserted: false })
  ) {
    await alerter.alert({
      key: missedKey,
      severity: "page",
      title: "anchor missed deadline",
      message: `${token.symbol} ${kind} anchor still missing ${anchors.schedule.missedDeadlineHours}h after target`,
      detail: { symbol: token.symbol, kind, target: targetDate.toISOString() },
    });
  }

  if (!anchorDue({ nowMs, targetMs, delayMinutes, alreadyInserted: false })) return;

  const source = anchorSourceFor(token.symbol);
  if (!source) return;

  const price = await fetchAnchorPrice(source, kind, token.symbol);
  if (price === null) {
    log.warn("anchor fetch failed, will retry next tick", { symbol: token.symbol, kind });
    return;
  }

  const prev = await latestAnchor(token.id, kind);
  const corp = await hadRecentCorporateAction(token.id, anchors.corporateActionLookbackHours);
  const validation = validateAnchor({
    newPrice: price,
    prevPrice: prev?.price ?? null,
    deviationThreshold: anchors.deviationThreshold,
    corporateAction: corp,
  });

  if (!validation.ok) {
    await alerter.alert({
      key: `anchor-reject:${token.symbol}:${kind}:${targetMs}`,
      severity: "page",
      title: "anchor rejected",
      message: `${token.symbol} ${kind} ${validation.reason}. insert manually to override.`,
      detail: {
        symbol: token.symbol,
        kind,
        price,
        prev: prev?.price ?? null,
        deviation: validation.deviation,
      },
    });
    return; // manual admin insert is the override path
  }

  await insertAnchor(token.id, kind, price, targetDate, mockMode ? "auto-mock" : "auto");
  await alerter.resolve(missedKey, `${token.symbol} ${kind} anchor inserted`);
  log.info("anchor inserted", {
    symbol: token.symbol,
    kind,
    price,
    marketTs: targetDate.toISOString(),
  });
}

// run one pass of the scheduler. safe to call every tick; it only acts when an
// anchor is due or a deadline has passed. no-op unless automation is enabled.
export async function runAnchorScheduler(nowMs: number, alerter: OpsAlerter): Promise<void> {
  if (!anchors.automatedSource) return;
  const now = new Date(nowMs);
  const closeTarget = lastCloseTime(now, calendarConfig).getTime();
  const openTarget = lastOpenTime(now, calendarConfig).getTime();
  for (const token of tokens) {
    try {
      await processAnchor(token, "close", closeTarget, anchors.schedule.closeDelayMinutes, nowMs, alerter);
      await processAnchor(token, "open", openTarget, anchors.schedule.openDelayMinutes, nowMs, alerter);
    } catch (err) {
      log.error("anchor scheduler failed for token", {
        symbol: token.symbol,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

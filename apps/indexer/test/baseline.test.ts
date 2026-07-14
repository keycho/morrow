import { describe, it, expect, vi, beforeEach } from "vitest";

// intercept the db layer so no postgres is needed: the check reads proxy ticks
// through proxyTickAt only.
const proxyTickAt = vi.fn();
vi.mock("../src/db.js", () => ({
  proxyTickAt: (...args: unknown[]) => proxyTickAt(...args),
}));

import { checkCloseBaseline, resetCloseBaselineState } from "../src/baseline.js";
import { activeFetchSources, baseline } from "@morrow/config";
import { lastCloseTime } from "@morrow/engine";

function fakeAlerter() {
  return {
    alert: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn().mockResolvedValue(undefined),
    // the rest of the OpsAlerter surface is unused by checkCloseBaseline.
  } as unknown as import("@morrow/telegram/ops").OpsAlerter;
}

// a monday 16:30 et instant: the last close is 16:00 et the same day, so we are
// past the grace window and inside the check window.
const NOW = Date.parse("2026-07-13T20:30:00Z");
const CLOSE = lastCloseTime(new Date(NOW), {
  timezone: "America/New_York",
  extraHolidays: [],
  extraHalfDays: [],
}).getTime();

beforeEach(() => {
  proxyTickAt.mockReset();
  resetCloseBaselineState();
});

describe("checkCloseBaseline", () => {
  it("does not alert when every source has a fresh baseline at the close", async () => {
    // a tick 30s before the close for each source.
    proxyTickAt.mockImplementation(async (source: string) => ({
      source,
      ts: new Date(CLOSE - 30_000),
      value: 1,
    }));
    const alerter = fakeAlerter();
    await checkCloseBaseline(NOW, alerter);

    expect(proxyTickAt).toHaveBeenCalledTimes(activeFetchSources().length);
    expect(alerter.alert).not.toHaveBeenCalled();
    expect(alerter.resolve).toHaveBeenCalledWith("close-baseline", expect.any(String));
  });

  it("pages when a close passes with no baseline captured (indexer was down)", async () => {
    proxyTickAt.mockResolvedValue(null);
    const alerter = fakeAlerter();
    await checkCloseBaseline(NOW, alerter);

    expect(alerter.alert).toHaveBeenCalledTimes(1);
    const arg = (alerter.alert as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.key).toBe("close-baseline");
    expect(arg.severity).toBe("page");
  });

  it("pages when the nearest baseline is far too old", async () => {
    proxyTickAt.mockImplementation(async (source: string) => ({
      source,
      ts: new Date(CLOSE - 3 * 3600_000), // 3h before the close
      value: 1,
    }));
    const alerter = fakeAlerter();
    await checkCloseBaseline(NOW, alerter);
    expect(alerter.alert).toHaveBeenCalledTimes(1);
  });

  it("skips within the grace period right after the close", async () => {
    const justAfterClose = CLOSE + (baseline.graceMinutes - 5) * 60_000;
    const alerter = fakeAlerter();
    await checkCloseBaseline(justAfterClose, alerter);
    expect(proxyTickAt).not.toHaveBeenCalled();
    expect(alerter.alert).not.toHaveBeenCalled();
    expect(alerter.resolve).not.toHaveBeenCalled();
  });

  it("checks a given close only once", async () => {
    proxyTickAt.mockResolvedValue(null);
    const alerter = fakeAlerter();
    await checkCloseBaseline(NOW, alerter);
    await checkCloseBaseline(NOW + 60_000, alerter);
    // second call is the same close id, so it is skipped.
    expect(alerter.alert).toHaveBeenCalledTimes(1);
  });
});

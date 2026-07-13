import { describe, expect, it } from "vitest";
import {
  anchorDue,
  anchorMissed,
  lastOpenTime,
  validateAnchor,
  defaultCalendarConfig,
} from "../src/index.js";

const MIN = 60_000;
const HOUR = 3_600_000;

describe("anchorDue", () => {
  const targetMs = Date.UTC(2026, 6, 13, 20, 0, 0); // a close instant

  it("is not due before the delay elapses", () => {
    expect(anchorDue({ nowMs: targetMs + 10 * MIN, targetMs, delayMinutes: 15, alreadyInserted: false })).toBe(false);
  });

  it("is due once the delay elapses", () => {
    expect(anchorDue({ nowMs: targetMs + 15 * MIN, targetMs, delayMinutes: 15, alreadyInserted: false })).toBe(true);
    expect(anchorDue({ nowMs: targetMs + 40 * MIN, targetMs, delayMinutes: 15, alreadyInserted: false })).toBe(true);
  });

  it("is never due once inserted", () => {
    expect(anchorDue({ nowMs: targetMs + 40 * MIN, targetMs, delayMinutes: 15, alreadyInserted: true })).toBe(false);
  });
});

describe("validateAnchor", () => {
  it("passes the first anchor with no previous", () => {
    const v = validateAnchor({ newPrice: 250, prevPrice: null, deviationThreshold: 0.15, corporateAction: false });
    expect(v.ok).toBe(true);
  });

  it("passes a small move", () => {
    const v = validateAnchor({ newPrice: 255, prevPrice: 250, deviationThreshold: 0.15, corporateAction: false });
    expect(v.ok).toBe(true);
  });

  it("rejects a large jump with no corporate action", () => {
    const v = validateAnchor({ newPrice: 25, prevPrice: 250, deviationThreshold: 0.15, corporateAction: false });
    expect(v.ok).toBe(false);
    expect(v.deviation).toBeCloseTo(0.9, 6);
  });

  it("allows the same jump when a corporate action explains it (a 10:1 split)", () => {
    const v = validateAnchor({ newPrice: 25, prevPrice: 250, deviationThreshold: 0.15, corporateAction: true });
    expect(v.ok).toBe(true);
  });

  it("rejects a non-positive price", () => {
    expect(validateAnchor({ newPrice: 0, prevPrice: 250, deviationThreshold: 0.15, corporateAction: false }).ok).toBe(false);
    expect(validateAnchor({ newPrice: -1, prevPrice: 250, deviationThreshold: 0.15, corporateAction: false }).ok).toBe(false);
  });
});

describe("anchorMissed", () => {
  const targetMs = Date.UTC(2026, 6, 13, 20, 0, 0);

  it("is not missed before the deadline", () => {
    expect(anchorMissed({ nowMs: targetMs + 1 * HOUR, targetMs, deadlineHours: 2, inserted: false })).toBe(false);
  });

  it("is missed past the deadline when still not inserted", () => {
    expect(anchorMissed({ nowMs: targetMs + 2 * HOUR, targetMs, deadlineHours: 2, inserted: false })).toBe(true);
  });

  it("is never missed once inserted", () => {
    expect(anchorMissed({ nowMs: targetMs + 5 * HOUR, targetMs, deadlineHours: 2, inserted: true })).toBe(false);
  });
});

describe("lastOpenTime", () => {
  it("finds the most recent 09:30 et open", () => {
    // monday 2026-07-13 at 15:00 utc (11:00 et). open was 09:30 et = 13:30 utc
    const open = lastOpenTime(new Date("2026-07-13T15:00:00Z"), defaultCalendarConfig);
    expect(open.toISOString()).toBe("2026-07-13T13:30:00.000Z");
  });

  it("skips back over the weekend", () => {
    // sunday 2026-07-12 noon utc. last open was friday 2026-07-10 09:30 et
    const open = lastOpenTime(new Date("2026-07-12T12:00:00Z"), defaultCalendarConfig);
    expect(open.toISOString()).toBe("2026-07-10T13:30:00.000Z");
  });
});

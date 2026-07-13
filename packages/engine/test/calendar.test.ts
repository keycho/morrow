import { describe, expect, it } from "vitest";
import {
  defaultCalendarConfig,
  easterSunday,
  isHalfDayDate,
  lastCloseTime,
  marketHolidays,
  nextOpenTime,
  regimeAt,
  wallTimeToUtc,
} from "../src/index.js";

const cfg = defaultCalendarConfig;

describe("timezone conversion", () => {
  it("converts eastern wall time to utc across dst", () => {
    // january: est, utc-5
    expect(wallTimeToUtc(2026, 1, 15, 9, 30, cfg.timezone).toISOString()).toBe(
      "2026-01-15T14:30:00.000Z"
    );
    // july: edt, utc-4
    expect(wallTimeToUtc(2026, 7, 13, 9, 30, cfg.timezone).toISOString()).toBe(
      "2026-07-13T13:30:00.000Z"
    );
  });
});

describe("holiday computation", () => {
  it("computes easter", () => {
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
    expect(easterSunday(2025)).toEqual({ month: 4, day: 20 });
  });

  it("computes the 2026 nyse holiday set", () => {
    const days = marketHolidays(2026);
    expect(days.has("2026-01-01")).toBe(true); // new year's day, thursday
    expect(days.has("2026-01-19")).toBe(true); // mlk day
    expect(days.has("2026-02-16")).toBe(true); // washington's birthday
    expect(days.has("2026-04-03")).toBe(true); // good friday
    expect(days.has("2026-05-25")).toBe(true); // memorial day
    expect(days.has("2026-06-19")).toBe(true); // juneteenth, friday
    expect(days.has("2026-07-03")).toBe(true); // july 4 is saturday, observed friday
    expect(days.has("2026-09-07")).toBe(true); // labor day
    expect(days.has("2026-11-26")).toBe(true); // thanksgiving
    expect(days.has("2026-12-25")).toBe(true); // christmas, friday
  });

  it("does not observe new year's day that falls on saturday", () => {
    // jan 1 2022 was a saturday. nyse stayed open friday dec 31 2021.
    expect(marketHolidays(2022).has("2022-01-01")).toBe(false);
    expect(marketHolidays(2021).has("2021-12-31")).toBe(false);
  });

  it("shifts sunday holidays to monday", () => {
    // christmas 2027 falls on saturday, observed friday dec 24.
    expect(marketHolidays(2027).has("2027-12-24")).toBe(true);
    // july 4 2027 falls on sunday, observed monday july 5.
    expect(marketHolidays(2027).has("2027-07-05")).toBe(true);
  });
});

describe("half days", () => {
  it("flags the day after thanksgiving", () => {
    expect(isHalfDayDate(2026, 11, 27, cfg)).toBe(true);
  });

  it("flags christmas eve when it is a trading day", () => {
    // dec 24 2026 is a thursday, trading day
    expect(isHalfDayDate(2026, 12, 24, cfg)).toBe(true);
  });

  it("does not flag july 3 when it is the observed july 4 holiday", () => {
    // july 3 2026 is the observed independence day, a full closure
    expect(isHalfDayDate(2026, 7, 3, cfg)).toBe(false);
  });
});

describe("regime classification", () => {
  it("classifies a regular monday", () => {
    // monday 2026-07-13, 10:00 et = 14:00 utc
    expect(regimeAt(new Date("2026-07-13T14:00:00Z"), cfg)).toBe("market_open");
    // same day, 18:00 et = 22:00 utc
    expect(regimeAt(new Date("2026-07-13T22:00:00Z"), cfg)).toBe("after_hours");
    // same day, 08:00 et premarket
    expect(regimeAt(new Date("2026-07-13T12:00:00Z"), cfg)).toBe("after_hours");
  });

  it("classifies the weekend", () => {
    // sunday 2026-07-12 noon utc
    expect(regimeAt(new Date("2026-07-12T12:00:00Z"), cfg)).toBe("weekend");
    // saturday 2026-07-11
    expect(regimeAt(new Date("2026-07-11T15:00:00Z"), cfg)).toBe("weekend");
  });

  it("classifies holidays", () => {
    // observed july 4 on friday 2026-07-03, midday
    expect(regimeAt(new Date("2026-07-03T16:00:00Z"), cfg)).toBe("holiday");
  });

  it("closes at 13:00 et on half days", () => {
    // friday after thanksgiving 2026-11-27. 12:30 et = 17:30 utc (est)
    expect(regimeAt(new Date("2026-11-27T17:30:00Z"), cfg)).toBe("market_open");
    // 13:30 et = 18:30 utc
    expect(regimeAt(new Date("2026-11-27T18:30:00Z"), cfg)).toBe("after_hours");
  });
});

describe("close and open walking", () => {
  it("finds the last close from a weekend", () => {
    // saturday 2026-07-11 12:00 utc. last close friday 2026-07-10 16:00 et
    const close = lastCloseTime(new Date("2026-07-11T12:00:00Z"), cfg);
    expect(close.toISOString()).toBe("2026-07-10T20:00:00.000Z");
  });

  it("finds the next open from a weekend", () => {
    const open = nextOpenTime(new Date("2026-07-11T12:00:00Z"), cfg);
    expect(open.toISOString()).toBe("2026-07-13T13:30:00.000Z");
  });

  it("uses the 13:00 close on half days", () => {
    // saturday 2026-11-28. last close was friday 27th at 13:00 et = 18:00 utc
    const close = lastCloseTime(new Date("2026-11-28T12:00:00Z"), cfg);
    expect(close.toISOString()).toBe("2026-11-27T18:00:00.000Z");
  });

  it("skips holidays when walking forward", () => {
    // thursday 2026-07-02 after close (21:00 utc = 17:00 et). friday 07-03 is
    // the observed holiday, weekend follows, next open is monday 07-06.
    const open = nextOpenTime(new Date("2026-07-02T21:00:00Z"), cfg);
    expect(open.toISOString()).toBe("2026-07-06T13:30:00.000Z");
  });
});

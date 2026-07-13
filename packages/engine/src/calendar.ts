// nyse market calendar and regime classification, handled properly in
// America/New_York. pure functions of the supplied instant; no wall clocks
// read here. the operator can patch the computed calendar via config
// (extraHolidays, extraHalfDays), passed in as CalendarConfig.
//
// regular session: 09:30 to 16:00 et, monday to friday.
// half days close at 13:00 et.
// computed full holidays: new year's day, mlk day, washington's birthday,
// good friday, memorial day, juneteenth, independence day, labor day,
// thanksgiving, christmas. weekend holidays follow nyse observance: saturday
// holidays are observed the friday before (except new year's day, which is
// not observed when it falls on saturday), sunday holidays the monday after.
// computed half days: july 3 when it is a trading day, the day after
// thanksgiving, and december 24 when it is a trading day.

export type Regime = "market_open" | "after_hours" | "weekend" | "holiday";

export interface CalendarConfig {
  timezone: string; // always America/New_York in practice
  extraHolidays: readonly string[]; // "yyyy-mm-dd"
  extraHalfDays: readonly string[];
}

export const defaultCalendarConfig: CalendarConfig = {
  timezone: "America/New_York",
  extraHolidays: [],
  extraHalfDays: [],
};

// --- timezone plumbing ------------------------------------------------------

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  weekday: number; // 0 sunday .. 6 saturday
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = partFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hour12: false,
    });
    partFormatters.set(timezone, f);
  }
  return f;
}

const weekdayIndex: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function wallTimeAt(utc: Date, timezone: string): WallTime {
  const parts = formatterFor(timezone).formatToParts(utc);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const hourRaw = Number(get("hour"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    // some icu versions render midnight as 24
    hour: hourRaw === 24 ? 0 : hourRaw,
    minute: Number(get("minute")),
    weekday: weekdayIndex[get("weekday")] ?? 0,
  };
}

// convert a wall time in the given timezone to a utc instant. two-pass
// correction handles dst offsets without a timezone database.
export function wallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const wall = wallTimeAt(new Date(guess), timezone);
    const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    const desired = Date.UTC(year, month - 1, day, hour, minute);
    const diff = desired - wallAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

// --- holiday computation ----------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// weekday of a pure calendar date (0 sunday .. 6 saturday). calendar dates
// are timezone-free here; Date.UTC keeps the arithmetic exact.
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number {
  const first = weekdayOf(year, month, 1);
  const offset = (weekday - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = weekdayOf(year, month, daysInMonth);
  const offset = (last - weekday + 7) % 7;
  return daysInMonth - offset;
}

// easter sunday via the anonymous gregorian computus (meeus/jones/butcher).
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

// shift a fixed-date holiday to its observed date. returns null when not
// observed at all (nyse: new year's day falling on saturday).
function observed(
  year: number,
  month: number,
  day: number,
  saturdayObserved: boolean
): string | null {
  const wd = weekdayOf(year, month, day);
  if (wd === 6) {
    if (!saturdayObserved) return null;
    // friday before
    const d = new Date(Date.UTC(year, month - 1, day - 1));
    return dateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  if (wd === 0) {
    // monday after
    const d = new Date(Date.UTC(year, month - 1, day + 1));
    return dateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return dateKey(year, month, day);
}

const holidayCache = new Map<number, Set<string>>();

export function marketHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const days = new Set<string>();
  const add = (key: string | null): void => {
    if (key) days.add(key);
  };

  // new year's day. saturday occurrence is not observed by nyse.
  add(observed(year, 1, 1, false));
  // mlk day, third monday of january
  add(dateKey(year, 1, nthWeekdayOfMonth(year, 1, 1, 3)));
  // washington's birthday, third monday of february
  add(dateKey(year, 2, nthWeekdayOfMonth(year, 2, 1, 3)));
  // good friday, two days before easter sunday
  {
    const easter = easterSunday(year);
    const gf = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
    add(dateKey(gf.getUTCFullYear(), gf.getUTCMonth() + 1, gf.getUTCDate()));
  }
  // memorial day, last monday of may
  add(dateKey(year, 5, lastWeekdayOfMonth(year, 5, 1)));
  // juneteenth
  add(observed(year, 6, 19, true));
  // independence day
  add(observed(year, 7, 4, true));
  // labor day, first monday of september
  add(dateKey(year, 9, nthWeekdayOfMonth(year, 9, 1, 1)));
  // thanksgiving, fourth thursday of november
  add(dateKey(year, 11, nthWeekdayOfMonth(year, 11, 4, 4)));
  // christmas
  add(observed(year, 12, 25, true));

  holidayCache.set(year, days);
  return days;
}

export function isHolidayDate(year: number, month: number, day: number, cfg: CalendarConfig): boolean {
  const key = dateKey(year, month, day);
  if (cfg.extraHolidays.includes(key)) return true;
  return marketHolidays(year).has(key);
}

export function isHalfDayDate(year: number, month: number, day: number, cfg: CalendarConfig): boolean {
  const key = dateKey(year, month, day);
  if (cfg.extraHalfDays.includes(key)) return true;
  const wd = weekdayOf(year, month, day);
  const isWeekday = wd >= 1 && wd <= 5;
  if (!isWeekday || isHolidayDate(year, month, day, cfg)) return false;
  // july 3, when it is a trading day
  if (month === 7 && day === 3) return true;
  // day after thanksgiving
  if (month === 11) {
    const thanksgiving = nthWeekdayOfMonth(year, 11, 4, 4);
    if (day === thanksgiving + 1) return true;
  }
  // christmas eve, when it is a trading day
  if (month === 12 && day === 24) return true;
  return false;
}

export function isTradingDay(year: number, month: number, day: number, cfg: CalendarConfig): boolean {
  const wd = weekdayOf(year, month, day);
  if (wd === 0 || wd === 6) return false;
  return !isHolidayDate(year, month, day, cfg);
}

// --- regime -----------------------------------------------------------------

export function regimeAt(utc: Date, cfg: CalendarConfig = defaultCalendarConfig): Regime {
  const w = wallTimeAt(utc, cfg.timezone);
  if (w.weekday === 0 || w.weekday === 6) return "weekend";
  if (isHolidayDate(w.year, w.month, w.day, cfg)) return "holiday";
  const minutes = w.hour * 60 + w.minute;
  const openMinutes = 9 * 60 + 30;
  const closeMinutes = isHalfDayDate(w.year, w.month, w.day, cfg) ? 13 * 60 : 16 * 60;
  if (minutes >= openMinutes && minutes < closeMinutes) return "market_open";
  return "after_hours";
}

// most recent official close instant at or before `utc`.
export function lastCloseTime(utc: Date, cfg: CalendarConfig = defaultCalendarConfig): Date {
  const w = wallTimeAt(utc, cfg.timezone);
  // walk back up to two weeks; more than that means a broken calendar.
  let cursor = new Date(Date.UTC(w.year, w.month - 1, w.day));
  for (let i = 0; i < 15; i++) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    if (isTradingDay(y, m, d, cfg)) {
      const closeHour = isHalfDayDate(y, m, d, cfg) ? 13 : 16;
      const close = wallTimeToUtc(y, m, d, closeHour, 0, cfg.timezone);
      if (close.getTime() <= utc.getTime()) return close;
    }
    cursor = new Date(cursor.getTime() - 24 * 3600 * 1000);
  }
  throw new Error("no trading day found in the last 15 days; calendar is broken");
}

// next official open instant strictly after `utc`.
export function nextOpenTime(utc: Date, cfg: CalendarConfig = defaultCalendarConfig): Date {
  const w = wallTimeAt(utc, cfg.timezone);
  let cursor = new Date(Date.UTC(w.year, w.month - 1, w.day));
  for (let i = 0; i < 15; i++) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    if (isTradingDay(y, m, d, cfg)) {
      const open = wallTimeToUtc(y, m, d, 9, 30, cfg.timezone);
      if (open.getTime() > utc.getTime()) return open;
    }
    cursor = new Date(cursor.getTime() + 24 * 3600 * 1000);
  }
  throw new Error("no trading day found in the next 15 days; calendar is broken");
}

// week arithmetic for receipts. pure. computes the most recently completed
// monday-to-friday week relative to a given instant, in the market timezone.
// the generator runs on monday and reports the prior week.

// day of week for a yyyy-mm-dd date, 0 sunday .. 6 saturday. timezone-free.
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function addDays(year: number, month: number, day: number, delta: number): string {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// given a calendar date (the day the generator runs), return the monday and
// friday of the most recently completed week. if run on monday, that is the
// previous monday-friday. on any other day it is the monday of the current
// week's just-passed span, back to the last completed friday.
export function lastCompletedWeek(
  year: number,
  month: number,
  day: number
): { weekStart: string; weekEnd: string } {
  const wd = weekdayOf(year, month, day); // 0..6
  // days since the most recent monday (monday=0)
  const sinceMonday = (wd + 6) % 7;
  // this week's monday
  const thisMonday = addDays(year, month, day, -sinceMonday);
  // the completed week is the one before this monday
  const [ty, tm, td] = thisMonday.split("-").map(Number) as [number, number, number];
  const weekStart = addDays(ty, tm, td, -7);
  const [sy, sm, sd] = weekStart.split("-").map(Number) as [number, number, number];
  const weekEnd = addDays(sy, sm, sd, 4); // friday
  return { weekStart, weekEnd };
}

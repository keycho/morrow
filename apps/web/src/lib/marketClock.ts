// client-side et market clock for the live header pill and landing ticker.
// computes the current regime and a live countdown to the next regular open
// (09:30 et, mon-fri). holidays are not modeled here: the authoritative regime
// rides on every published price from the engine (shown in the feed and
// spreads); this is a lightweight live convenience only, so it never claims
// more than weekend / market hours.

export type Regime = "market_open" | "after_hours" | "weekend";

const OPEN_SEC = 9 * 3600 + 30 * 60; // 09:30 et
const CLOSE_SEC = 16 * 3600; // 16:00 et

// et wall-clock parts of an instant. weekday 0=sun..6=sat, sec since et midnight.
function etParts(d: Date): { weekday: number; sec: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = f.formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = wdMap[get("weekday")] ?? 0;
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const sec = hour * 3600 + Number(get("minute")) * 60 + Number(get("second"));
  return { weekday, sec };
}

export function regimeNow(d: Date = new Date()): Regime {
  const { weekday, sec } = etParts(d);
  if (weekday === 0 || weekday === 6) return "weekend";
  if (sec >= OPEN_SEC && sec < CLOSE_SEC) return "market_open";
  return "after_hours";
}

// seconds until the next regular open. et-wall-second arithmetic; off by an
// hour at most on the two dst-transition weekends a year, which is acceptable
// for a countdown.
export function secsToNextOpen(d: Date = new Date()): number {
  const { weekday, sec } = etParts(d);
  let daysAhead = 0;
  if (weekday >= 1 && weekday <= 5 && sec < OPEN_SEC) {
    daysAhead = 0;
  } else {
    daysAhead = 1;
    let wd = (weekday + 1) % 7;
    while (wd === 0 || wd === 6) {
      daysAhead += 1;
      wd = (wd + 1) % 7;
    }
  }
  return daysAhead * 86400 + (OPEN_SEC - sec);
}

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// day-of-week label of the next open, e.g. "mon".
export function nextOpenDay(d: Date = new Date()): string {
  const secs = secsToNextOpen(d);
  const target = new Date(d.getTime() + secs * 1000);
  return DOW[etParts(target).weekday] ?? "mon";
}

export function fmtCountdown(secs: number): string {
  if (secs <= 0) return "now";
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (days > 0) return `${String(days).padStart(2, "0")}d ${String(hours).padStart(2, "0")}h`;
  if (hours > 0) return `${String(hours).padStart(2, "0")}h ${String(mins).padStart(2, "0")}m`;
  return `${String(mins).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

export function regimeLabel(r: Regime): string {
  return r === "market_open" ? "market open" : r === "weekend" ? "weekend" : "after hours";
}

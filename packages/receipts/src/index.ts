// receipts cli. run with `pnpm receipts`. generates (and stores) last week's
// accuracy receipt. pass --force to regenerate an existing week. generation
// only; nothing is posted.

import { generateWeeklyReceipt } from "./generate.js";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [receipts] ${msg}`);
}

function etToday(): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    log("DATABASE_URL is not set. set it and re-run: DATABASE_URL=... pnpm receipts");
    process.exit(1);
  }
  const force = process.argv.includes("--force");
  const result = await generateWeeklyReceipt({ now: etToday(), force });
  if (result === null) {
    log("receipt for last week already exists. pass --force to regenerate.");
    return;
  }
  log(
    `generated receipt for ${result.weekStart} to ${result.weekEnd}: ` +
      `${result.cyclesCommitted} cycles committed, png ${result.hadPng ? "rendered" : "skipped (resvg not installed)"}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

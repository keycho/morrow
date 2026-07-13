// fletch public divergence alert bot. its own worker.
//
// polls the public /v1/spreads endpoint and posts to a public telegram
// channel when a token's absolute spread crosses the configured threshold,
// with hysteresis and a per-token cooldown so it does not spam on
// oscillation. messages are data statements only, lowercase, terminal style,
// with a single disclaimer footer. dry_run (on by default) logs instead of
// sending.

import { telegram } from "@fletch/config";
import { evaluate, initialState, type AlertState } from "./alertlogic.js";
import { fetchSpreads } from "./client.js";
import { formatAlert } from "./format.js";
import { makeSender } from "./telegram.js";

function log(msg: string, extra?: Record<string, unknown>): void {
  const suffix = extra ? " " + JSON.stringify(extra) : "";
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [telegram] ${msg}${suffix}`);
}

let running = true;

async function main(): Promise<void> {
  const cfg = telegram.public;
  const sender = makeSender({ botToken: cfg.botToken, chatId: cfg.chatId, dryRun: cfg.dryRun });
  const states = new Map<string, AlertState>();

  log("public alert bot starting", {
    apiUrl: cfg.apiUrl,
    pollMs: cfg.pollMs,
    thresholdPct: cfg.alertThresholdPct,
    live: sender.live,
  });

  const alertCfg = {
    thresholdPct: cfg.alertThresholdPct,
    rearmFraction: cfg.rearmFraction,
    cooldownMs: cfg.cooldownMs,
  };

  while (running) {
    const startedAt = Date.now();
    try {
      const rows = await fetchSpreads(cfg.apiUrl);
      const now = Date.now();
      for (const row of rows) {
        const prev = states.get(row.symbol) ?? initialState();
        const { alert, state } = evaluate(prev, row.spreadPct, alertCfg, now);
        states.set(row.symbol, state);
        if (alert) {
          const text = formatAlert(row, cfg.webUrl, cfg.footer);
          try {
            await sender.send(text);
            log("alert sent", { symbol: row.symbol, spreadPct: row.spreadPct });
          } catch (err) {
            log("alert send failed", {
              symbol: row.symbol,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch (err) {
      log("poll failed", { message: err instanceof Error ? err.message : String(err) });
    }
    const waitMs = Math.max(5_000, cfg.pollMs - (Date.now() - startedAt));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

process.on("SIGTERM", () => {
  log("sigterm received, stopping");
  running = false;
});

process.on("unhandledRejection", (reason) => {
  log("unhandled rejection", { reason: String(reason) });
});

main().catch((err) => {
  log("fatal", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

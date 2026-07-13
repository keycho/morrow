// api-side ops monitor. the api is well placed to watch two conditions the
// indexer cannot see about itself: the indexer heartbeat going stale (read
// from the database) and the api's own 5xx response rate spiking. it pages the
// same private ops channel, with cooldown and resolved notifications.

import { ops, timing } from "@morrow/config";
import type { OpsAlerter } from "@morrow/telegram/ops";
import { latestHeartbeats, newestFairValueTs } from "./db.js";

// rolling record of recent 5xx response timestamps (ms).
const fiveXx: number[] = [];

export function record5xx(nowMs: number = Date.now()): void {
  fiveXx.push(nowMs);
  trim5xx(nowMs);
}

function trim5xx(nowMs: number): void {
  const cutoff = nowMs - ops.api5xxWindowMs;
  while (fiveXx.length > 0 && fiveXx[0]! < cutoff) fiveXx.shift();
}

async function checkFiveXx(alerter: OpsAlerter, nowMs: number): Promise<void> {
  trim5xx(nowMs);
  const count = fiveXx.length;
  if (count >= ops.api5xxThreshold) {
    await alerter.alert({
      key: "api-5xx",
      severity: "page",
      title: "api 5xx spike",
      message: `${count} 5xx responses in the last ${Math.round(ops.api5xxWindowMs / 1000)}s`,
      detail: { count, windowMs: ops.api5xxWindowMs },
    });
  } else {
    await alerter.resolve("api-5xx", "api 5xx rate back to normal");
  }
}

async function checkIndexerHeartbeat(alerter: OpsAlerter, nowMs: number): Promise<void> {
  const [heartbeats, newestFv] = await Promise.all([latestHeartbeats(), newestFairValueTs()]);
  const indexerHb = heartbeats.find((h) => h.service === "indexer") ?? null;
  const staleMs = timing.cycleSeconds * ops.heartbeatStaleCycles * 1000;

  if (indexerHb === null) {
    await alerter.alert({
      key: "indexer-heartbeat",
      severity: "page",
      title: "indexer heartbeat missing",
      message: "no indexer heartbeat recorded",
    });
    return;
  }
  const ageMs = nowMs - new Date(indexerHb.ts).getTime();
  if (ageMs > staleMs) {
    await alerter.alert({
      key: "indexer-heartbeat",
      severity: "page",
      title: "indexer heartbeat stale",
      message: `indexer heartbeat is ${Math.round(ageMs / 1000)}s old, over ${ops.heartbeatStaleCycles} cycles`,
      detail: { ageMs, lastHeartbeat: indexerHb.ts, lastCycle: newestFv },
    });
  } else {
    await alerter.resolve("indexer-heartbeat", "indexer heartbeat is fresh again");
  }
}

// starts the monitor loop; returns a stop function.
export function startOpsMonitor(alerter: OpsAlerter): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    void checkFiveXx(alerter, now).catch(() => undefined);
    void checkIndexerHeartbeat(alerter, now).catch(() => undefined);
  }, ops.monitorIntervalMs);
  // do not keep the process alive solely for the monitor.
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

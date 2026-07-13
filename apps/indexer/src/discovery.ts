// weekly pool-discovery scheduler. on the configured weekday and hour
// (America/New_York), run one multi-protocol discovery pass, record it in the
// pool_discovery_runs dataset, and raise ops alerts on two conditions:
//   - a usable pool now exists for a token that has no configured pool
//   - a configured pool's dollar depth has stayed below the alert floor for a
//     sustained window of runs
// discovery never edits config. it surfaces these for the operator to act on.
//
// the discovery itself is @fletch/discovery, shared with the cli, so the
// worker and the operator see identical results. idempotent: a per-day guard
// plus a check of the last stored run keep it to once a week even across a
// restart within the window.

import { calendar, discovery, discoveryCandidates, mockMode } from "@fletch/config";
import { wallTimeAt } from "@fletch/engine";
import {
  analyzeDiscovery,
  lastDiscoveryRunAt,
  readAnchorReferences,
  recentDiscoveryResults,
  runDiscovery,
  storeDiscoveryRun,
} from "@fletch/discovery";
import type { OpsAlerter } from "@fletch/telegram/ops";
import { db } from "./db.js";
import { rpcClient } from "./pools.js";
import { log } from "./log.js";

// a run this recent means another instance (or this one before a restart)
// already ran today; do not run again in the same window.
const RECENT_RUN_MS = 20 * 60 * 60 * 1000;

let lastRunDay = "";

function newPoolKey(tokenId: number): string {
  return `discovery-new-pool-${tokenId}`;
}

function depthKey(tokenId: number): string {
  return `discovery-depth-${tokenId}`;
}

export async function maybeRunDiscovery(
  nowMs: number,
  ethUsdRate: number | null,
  alerter: OpsAlerter
): Promise<void> {
  if (!discovery.schedule.autoWeekly) return;
  // discovery reads the live rpc; mock mode has no chain to probe.
  if (mockMode) return;

  const w = wallTimeAt(new Date(nowMs), calendar.timezone);
  if (w.weekday !== discovery.schedule.weekday) return;
  const minutes = w.hour * 60 + w.minute;
  if (minutes < discovery.schedule.hourEt * 60) return;

  const dayKey = `${w.year}-${w.month}-${w.day}`;
  if (dayKey === lastRunDay) return;

  // survive a restart inside the window: if a run already landed in the last
  // ~20h, mark today done without re-running.
  const last = await lastDiscoveryRunAt(db()).catch(() => null);
  if (last && nowMs - last.getTime() < RECENT_RUN_MS) {
    lastRunDay = dayKey;
    return;
  }
  lastRunDay = dayKey;

  try {
    const refs = await readAnchorReferences(db());
    const result = await runDiscovery(rpcClient(), ethUsdRate, refs);
    await storeDiscoveryRun(db(), result);

    // the just-stored run is the newest; the window includes it at index 0.
    // analyze against the full candidate universe so a usable pool appearing
    // for any captured available token (not only a null launch token) surfaces.
    const candidates = discoveryCandidates();
    const recent = await recentDiscoveryResults(db(), discovery.depthBelowFloorRuns);
    const findings = analyzeDiscovery(recent, candidates);

    const activeKeys = new Set<string>();
    for (const f of findings) {
      const key = f.kind === "new-pool" ? newPoolKey(f.tokenId) : depthKey(f.tokenId);
      activeKeys.add(key);
      await alerter.alert({
        key,
        severity: "warn",
        title: f.kind === "new-pool" ? "discovery: new pool" : "discovery: pool depth low",
        message: f.message,
        detail: f.detail,
      });
    }
    // clear any discovery condition that no longer holds (resolve is a no-op
    // when the key was never active).
    for (const t of candidates) {
      if (!activeKeys.has(newPoolKey(t.id))) await alerter.resolve(newPoolKey(t.id), "no new pool");
      if (!activeKeys.has(depthKey(t.id))) await alerter.resolve(depthKey(t.id), "pool depth recovered");
    }

    log.info("weekly discovery complete", {
      pools: result.judged.length,
      selected: result.selections.filter((s) => s.chosen).length,
      findings: findings.length,
    });
  } catch (err) {
    log.error("weekly discovery failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

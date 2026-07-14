// scheduled data retention. morrow writes raw observations and proxy ticks
// every tick, forever; left alone they fill the database. this prunes the raw,
// reconstructable rows once nothing needs them. the permanent record
// (fair_values, commits, anchors, receipts) is never pruned here.
//
// OFF by default (retention.enabled). the indexer calls this once a day; when
// disabled it is a no-op. observations are kept for the twap window plus a
// safety margin; proxy ticks are kept long enough to outlive the close baseline
// the drift model reads at each close.

import { retention, timing } from "@morrow/config";
import { pruneObservations, pruneProxyTicks } from "./db.js";
import { log } from "./log.js";

export async function runRetention(nowMs: number): Promise<void> {
  if (!retention.enabled) return;

  const obsCutoff = new Date(
    nowMs - (timing.twapWindowSeconds + retention.observationsMarginHours * 3600) * 1000
  );
  const proxyCutoff = new Date(nowMs - retention.proxyTicksDays * 86_400_000);

  const [observations, proxyTicks] = [
    await pruneObservations(obsCutoff),
    await pruneProxyTicks(proxyCutoff),
  ];

  if (observations > 0 || proxyTicks > 0) {
    log.info("retention prune", {
      observations,
      proxyTicks,
      observationsBefore: obsCutoff.toISOString(),
      proxyTicksBefore: proxyCutoff.toISOString(),
    });
  }
}

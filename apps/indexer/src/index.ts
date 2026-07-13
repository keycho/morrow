// fletch indexer. railway worker.
//
// every tick (default 30s):
//   - read each tracked pool: spot, ±2% depth, volume delta, block, timestamp
//   - fetch every proxy source (generic http, per-source breaker)
//   - persist raw observations and proxy ticks to supabase
//   - write a heartbeat row with per-source status
//
// the fair value cycle and the commit publisher attach to this worker in
// later phases. resilience rules: a failed source or a failed tick never
// crashes the worker; everything retries with backoff on the next tick.

import { assertConfigReady, mockMode, timing } from "@fletch/config";
import {
  closePool,
  insertObservations,
  insertProxyTicks,
  pruneOldHeartbeats,
  upsertTokensFromConfig,
  writeHeartbeat,
  type ObservationRow,
  type ProxyTickRow,
} from "./db.js";
import { readPool, trackedTokens, type PoolReading } from "./pools.js";
import {
  fetchAllProxies,
  proxyStatusSnapshot,
  recordSuccess,
  type ProxyFetchResult,
} from "./proxies.js";
import { mockPoolReading, mockProxyResults } from "./mock.js";
import { log } from "./log.js";

let running = true;
let lastPrunedDay = "";

async function collectPools(): Promise<{ readings: PoolReading[]; errors: string[] }> {
  const readings: PoolReading[] = [];
  const errors: string[] = [];
  for (const token of trackedTokens()) {
    if (mockMode) {
      readings.push(mockPoolReading(token));
      continue;
    }
    try {
      readings.push(await readPool(token));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${token.symbol}: ${message}`);
      log.error("pool read failed", { token: token.symbol, message });
    }
  }
  return { readings, errors };
}

async function collectProxies(): Promise<ProxyFetchResult[]> {
  if (mockMode) return mockProxyResults();
  return fetchAllProxies();
}

async function tick(): Promise<void> {
  const startedAt = Date.now();
  const { readings, errors } = await collectPools();
  const proxyResults = await collectProxies();

  const observationRows: ObservationRow[] = readings.map((r) => ({
    tokenId: r.token.id,
    blockNumber: r.blockNumber,
    ts: r.ts,
    poolSpot: r.spot,
    depthQuote2pct: r.depthQuote2pct,
    volumeDelta: r.volumeDeltaQuote,
    source: mockMode ? "mock" : "pool",
  }));

  const proxyRows: ProxyTickRow[] = [];
  const now = Date.now();
  for (const result of proxyResults) {
    if (result.ok && result.value !== undefined) {
      recordSuccess(result.source.name, now);
      proxyRows.push({
        source: result.source.name,
        symbol: result.source.symbol,
        ts: new Date(),
        value: result.value,
        stale: false,
        latencyMs: result.latencyMs,
      });
    }
  }

  await insertObservations(observationRows);
  await insertProxyTicks(proxyRows);

  const failedProxies = proxyResults.filter((r) => !r.ok).map((r) => r.source.name);
  const detail = {
    tickMs: Date.now() - startedAt,
    pools: { ok: readings.length, failed: errors, mock: mockMode },
    proxies: {
      ok: proxyRows.length,
      failed: failedProxies,
      status: proxyStatusSnapshot(now),
    },
  };
  const ok = errors.length === 0 && failedProxies.length < proxyResults.length;
  await writeHeartbeat("indexer", ok, detail);

  // opportunistic daily prune
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastPrunedDay) {
    lastPrunedDay = today;
    await pruneOldHeartbeats().catch((err) =>
      log.warn("heartbeat prune failed", { message: String(err) })
    );
  }

  log.info("tick complete", {
    pools: readings.length,
    poolErrors: errors.length,
    proxyOk: proxyRows.length,
    proxyFailed: failedProxies.length,
    ms: Date.now() - startedAt,
  });
}

async function main(): Promise<void> {
  log.info("fletch indexer starting", { mockMode, pollMs: timing.indexerPollMs });
  assertConfigReady();
  await upsertTokensFromConfig();

  while (running) {
    const startedAt = Date.now();
    try {
      await tick();
    } catch (err) {
      // never let one bad tick kill the worker
      const message = err instanceof Error ? err.message : String(err);
      log.error("tick failed", { message });
      await writeHeartbeat("indexer", false, { error: message }).catch(() => undefined);
    }
    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(1_000, timing.indexerPollMs - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

process.on("SIGTERM", async () => {
  log.info("sigterm received, draining");
  running = false;
  await closePool().catch(() => undefined);
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { reason: String(reason) });
});

main().catch(async (err) => {
  log.error("fatal", { message: err instanceof Error ? err.message : String(err) });
  await closePool().catch(() => undefined);
  process.exit(1);
});

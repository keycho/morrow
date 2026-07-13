// fletch indexer. railway worker.
//
// every tick (default 30s):
//   - read each tracked pool: spot, ±2% depth, volume delta, block, timestamp
//   - fetch every proxy source (generic http, per-source breaker)
//   - persist raw observations and proxy ticks to supabase
//   - write a heartbeat row with per-source status
//
// every cycle (default 600s):
//   - run the fair value engine per token and upsert the outputs
//   - build the merkle tree, store the leaf set, commit the root on-chain
//
// resilience rules: a failed source, a failed tick, or a failed commit never
// crashes the worker; everything retries with backoff on later ticks and the
// commit reconcile pass re-sends anything unconfirmed.

import { assertConfigReady, dollarization, mockMode, timing, wethTokensPresent } from "@fletch/config";
import { lastCloseTime, type EthUsdTick } from "@fletch/engine";
import {
  closePool,
  insertObservations,
  insertProxyTicks,
  latestProxyTick,
  pruneOldHeartbeats,
  seedMockAnchors,
  upsertTokensFromConfig,
  writeHeartbeat,
  type ObservationRow,
  type ProxyTickRow,
} from "./db.js";
import { EthUsdUnavailableError, readPool, trackedTokens, type PoolReading } from "./pools.js";
import {
  fetchAllProxies,
  proxyStatusSnapshot,
  recordSuccess,
  type ProxyFetchResult,
} from "./proxies.js";
import { mockBasePrices, mockPoolReading, mockProxyResults } from "./mock.js";
import { maybeRunCycle } from "./cycle.js";
import { publishCycle, reconcileCommits } from "./publisher.js";
import { log } from "./log.js";

let running = true;
let lastPrunedDay = "";
let lastCycleId: number | null = null;
let ticksSinceReconcile = 0;

async function collectPools(
  ethUsd: EthUsdTick | null
): Promise<{ readings: PoolReading[]; errors: string[]; skipped: string[] }> {
  const readings: PoolReading[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  for (const token of trackedTokens()) {
    if (mockMode) {
      readings.push(mockPoolReading(token));
      continue;
    }
    if (token.pool === null) {
      // undiscovered pool. assertConfigReady blocks live boot on this, but
      // stay defensive so a partially-configured token cannot crash a tick.
      errors.push(`${token.symbol}: pool not discovered`);
      continue;
    }
    try {
      readings.push(await readPool(token, ethUsd));
    } catch (err) {
      if (err instanceof EthUsdUnavailableError) {
        // stale eth/usd: skip this weth token rather than dollarize wrong.
        // no observation is stored, so the engine degrades confidence.
        skipped.push(`${token.symbol}: eth/usd stale`);
        log.warn("skipping weth token, eth/usd stale", { token: token.symbol });
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${token.symbol}: ${message}`);
      log.error("pool read failed", { token: token.symbol, message });
    }
  }
  return { readings, errors, skipped };
}

async function collectProxies(): Promise<ProxyFetchResult[]> {
  if (mockMode) return mockProxyResults();
  return fetchAllProxies();
}

// resolve the eth/usd rate for dollarizing weth pools: prefer the value
// fetched this tick, else fall back to the most recent stored tick (the
// staleness gate in the reader decides whether it is still usable).
async function resolveEthUsd(proxyResults: ProxyFetchResult[]): Promise<EthUsdTick | null> {
  if (!wethTokensPresent()) return null;
  const fresh = proxyResults.find((r) => r.source.name === dollarization.ethUsdSource.name);
  if (fresh?.ok && fresh.value !== undefined) {
    return { rate: fresh.value, tsMs: Date.now() };
  }
  const latest = await latestProxyTick(dollarization.ethUsdSource.name);
  if (latest) return { rate: latest.value, tsMs: latest.ts.getTime() };
  return null;
}

async function tick(): Promise<void> {
  const startedAt = Date.now();
  // proxies first: the eth/usd rate is needed to dollarize weth pools.
  const proxyResults = await collectProxies();
  const ethUsd = await resolveEthUsd(proxyResults);
  const { readings, errors, skipped } = await collectPools(ethUsd);

  const observationRows: ObservationRow[] = readings.map((r) => ({
    tokenId: r.token.id,
    blockNumber: r.blockNumber,
    ts: r.ts,
    poolSpot: r.spot,
    depthQuote2pct: r.depthQuote2pct,
    volumeDelta: r.volumeDeltaQuote,
    uiMultiplier: r.uiMultiplier,
    uiMultiplierMissing: r.uiMultiplierMissing,
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

  // run the fair value cycle and publish the commit when a new cycle begins
  try {
    const cycleOutcome = await maybeRunCycle(now);
    if (cycleOutcome) {
      lastCycleId = cycleOutcome.cycleId;
      await publishCycle(cycleOutcome);
    }
  } catch (err) {
    log.error("cycle run failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // every ~10 ticks, retry anything unconfirmed
  ticksSinceReconcile += 1;
  if (ticksSinceReconcile >= 10) {
    ticksSinceReconcile = 0;
    await reconcileCommits().catch((err) =>
      log.warn("reconcile pass failed", { message: String(err) })
    );
  }

  const failedProxies = proxyResults.filter((r) => !r.ok).map((r) => r.source.name);
  const detail = {
    tickMs: Date.now() - startedAt,
    lastCycleId,
    pools: { ok: readings.length, failed: errors, skipped, mock: mockMode },
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
    poolSkipped: skipped.length,
    proxyOk: proxyRows.length,
    proxyFailed: failedProxies.length,
    ms: Date.now() - startedAt,
  });
}

async function main(): Promise<void> {
  log.info("fletch indexer starting", { mockMode, pollMs: timing.indexerPollMs });
  assertConfigReady();
  await upsertTokensFromConfig();

  if (mockMode) {
    // seed a close anchor per token so the full model path runs on
    // synthetic data
    const close = lastCloseTime(new Date());
    await seedMockAnchors(mockBasePrices, close);
    log.info("mock anchors seeded", { close: close.toISOString() });
  }

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

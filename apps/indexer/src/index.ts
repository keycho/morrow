// morrow indexer. railway worker.
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

import { assertConfigReady, dollarization, mockMode, timing, wethTokensPresent } from "@morrow/config";
import { lastCloseTime, type EthUsdTick } from "@morrow/engine";
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
import { publishCycle, reconcileCommits, checkPublisherBalance } from "./publisher.js";
import { runAnchorScheduler } from "./anchors.js";
import { checkCloseBaseline } from "./baseline.js";
import { runRetention } from "./retention.js";
import { maybeGenerateReceipt } from "./receipts.js";
import { maybeRunDiscovery } from "./discovery.js";
import { OpsAlerter, logTransport, makeTelegramTransport } from "@morrow/telegram/ops";
import { ops, telegram } from "@morrow/config";
import { log } from "./log.js";

let running = true;
let lastPrunedDay = "";
let lastCycleId: number | null = null;
let ticksSinceReconcile = 0;
let consecutiveRpcFailTicks = 0;

// interruptible wait so a sigterm during the between-tick sleep wakes at once.
let wakeup: (() => void) | null = null;
function interruptibleWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeup = null;
      resolve();
    }, ms);
    wakeup = () => {
      clearTimeout(timer);
      wakeup = null;
      resolve();
    };
  });
}

// ops alerter: logs and pages the private telegram ops channel.
const alerter = new OpsAlerter(ops.alertCooldownMs, [
  logTransport,
  makeTelegramTransport(telegram.ops),
]);

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

  // rpc/pool read failures: page after several consecutive failing ticks
  // (mock mode never reads rpc). resolve once a clean tick returns.
  if (!mockMode) {
    if (errors.length > 0 && readings.length === 0) {
      consecutiveRpcFailTicks += 1;
      if (consecutiveRpcFailTicks >= ops.rpcFailureTicks) {
        await alerter.alert({
          key: "rpc-failures",
          severity: "page",
          title: "rpc failures",
          message: `${consecutiveRpcFailTicks} consecutive ticks with no pool reads`,
          detail: { errors },
        });
      }
    } else {
      consecutiveRpcFailTicks = 0;
      await alerter.resolve("rpc-failures", "pool reads recovered");
    }
  }

  // anchor scheduler: insert close/open anchors on schedule (no-op unless
  // automation is enabled). never let it sink the tick.
  try {
    await runAnchorScheduler(now, alerter);
  } catch (err) {
    log.error("anchor scheduler pass failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // close-baseline check: page if a 16:00 et close passed with no proxy
  // baseline captured (the drift model would silently read zero otherwise).
  try {
    await checkCloseBaseline(now, alerter);
  } catch (err) {
    log.error("close baseline check failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // run the fair value cycle and publish the commit when a new cycle begins
  try {
    const cycleOutcome = await maybeRunCycle(now);
    if (cycleOutcome) {
      lastCycleId = cycleOutcome.cycleId;
      await publishCycle(cycleOutcome, alerter);
    }
  } catch (err) {
    log.error("cycle run failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // publisher wallet gas runway: page when the balance drops below the floor.
  await checkPublisherBalance(alerter).catch((err) =>
    log.warn("publisher balance check failed", { message: String(err) })
  );

  // weekly accuracy receipt: generate on the configured day after the open.
  await maybeGenerateReceipt(now).catch((err) =>
    log.warn("receipt scheduler failed", { message: String(err) })
  );

  // weekly pool discovery: probe every venue, record the run, alert on a new
  // pool for an unconfigured token or a configured pool drying up.
  await maybeRunDiscovery(now, ethUsd?.rate ?? null, alerter).catch((err) =>
    log.warn("discovery scheduler failed", { message: String(err) })
  );

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

  // opportunistic daily prune: heartbeats always, then the config-gated data
  // retention prune (off by default; deletes only raw observations and proxy
  // ticks, never the permanent record).
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastPrunedDay) {
    lastPrunedDay = today;
    await pruneOldHeartbeats().catch((err) =>
      log.warn("heartbeat prune failed", { message: String(err) })
    );
    await runRetention(Date.now()).catch((err) =>
      log.warn("retention prune failed", { message: String(err) })
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
  log.info("morrow indexer starting", { mockMode, pollMs: timing.indexerPollMs });
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
    // a sigterm during the tick drains after the in-flight cycle, not mid-way.
    if (!running) break;
    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(1_000, timing.indexerPollMs - elapsed);
    await interruptibleWait(waitMs);
  }

  log.info("indexer drained; in-flight cycle finished");
  await closePool().catch(() => undefined);
}

// graceful shutdown: stop after the current tick so a commit is never
// truncated mid-publish across a railway deploy.
function requestDrain(signal: string): void {
  log.info(`${signal} received, draining after the in-flight tick`);
  running = false;
  if (wakeup) wakeup();
}
process.on("SIGTERM", () => requestDrain("sigterm"));
process.on("SIGINT", () => requestDrain("sigint"));

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { reason: String(reason) });
});

main()
  .then(() => {
    // exit naturally so buffered logs flush; force-exit as a backstop in case
    // a handle lingers. never process.exit() straight away, which would
    // truncate the drain log.
    log.info("indexer stopped");
    setTimeout(() => process.exit(0), 2_000).unref();
  })
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error("fatal", { message });
    await alerter
      .alert({ key: "indexer-crash", severity: "page", title: "indexer crashed", message })
      .catch(() => undefined);
    await closePool().catch(() => undefined);
    setTimeout(() => process.exit(1), 2_000).unref();
    process.exitCode = 1;
  });

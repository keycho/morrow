// health endpoint. heartbeat freshness, last cycle age, per-source
// staleness. always answers 200 with a status field so monitors can parse
// the body; "down" means the indexer heartbeat has gone quiet.

import type { FastifyInstance } from "fastify";
import { disclaimer, mockMode, proxySources, timing } from "@fletch/config";
import { lastProxyTickPerSource, latestHeartbeats, newestFairValueTs } from "../db.js";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", async () => {
    const now = Date.now();
    const [heartbeats, newestFv, proxyTicks] = await Promise.all([
      latestHeartbeats(),
      newestFairValueTs(),
      lastProxyTickPerSource(),
    ]);

    const indexerHb = heartbeats.find((h) => h.service === "indexer") ?? null;
    const publisherHb = heartbeats.find((h) => h.service === "publisher") ?? null;

    const indexerAgeMs = indexerHb ? now - new Date(indexerHb.ts).getTime() : null;
    const lastCycleAgeMs = newestFv ? now - new Date(newestFv).getTime() : null;

    const tickBySource = new Map(proxyTicks.map((t) => [t.source, t.ts]));
    const sources = proxySources.map((s) => {
      const lastTs = tickBySource.get(s.name) ?? null;
      const ageMs = lastTs ? now - new Date(lastTs).getTime() : null;
      return {
        name: s.name,
        symbol: s.symbol,
        lastTickTs: lastTs,
        ageMs,
        stale: ageMs === null ? true : ageMs > s.stalenessMs,
      };
    });

    let status: "ok" | "degraded" | "down";
    if (indexerAgeMs === null || indexerAgeMs > timing.heartbeatStaleMs * 5) {
      status = "down";
    } else if (
      indexerAgeMs > timing.heartbeatStaleMs ||
      (lastCycleAgeMs !== null && lastCycleAgeMs > timing.cycleSeconds * 2 * 1000) ||
      (indexerHb !== null && !indexerHb.ok) ||
      sources.some((s) => s.stale)
    ) {
      status = "degraded";
    } else {
      status = "ok";
    }

    return {
      data: {
        status,
        mockMode,
        indexer: indexerHb
          ? { lastHeartbeat: indexerHb.ts, ageMs: indexerAgeMs, ok: indexerHb.ok }
          : null,
        publisher: publisherHb
          ? { lastHeartbeat: publisherHb.ts, ok: publisherHb.ok, detail: publisherHb.detail }
          : null,
        lastCycle: { newestFairValueTs: newestFv, ageMs: lastCycleAgeMs },
        cycleSeconds: timing.cycleSeconds,
        sources,
      },
      disclaimer,
    };
  });
}

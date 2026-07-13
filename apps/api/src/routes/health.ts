// health endpoint. per-subsystem status (indexer, engine, publisher, anchors,
// proxies) with last-success timestamps and plain-language descriptions, plus
// an overall status. always answers 200 with a status field so monitors can
// parse the body; "down" means a core subsystem has gone quiet.

import type { FastifyInstance } from "fastify";
import { anchors, disclaimer, mockMode, ops, proxySources, timing } from "@morrow/config";
import {
  lastProxyTickPerSource,
  latestHeartbeats,
  newestAnchorTs,
  newestConfirmedCommitTs,
  newestFairValueTs,
} from "../db.js";

type SubsystemStatus = "ok" | "degraded" | "down";

interface Subsystem {
  name: string;
  status: SubsystemStatus;
  lastSuccess: string | null;
  ageMs: number | null;
  description: string;
}

const RANK: Record<SubsystemStatus, number> = { ok: 0, degraded: 1, down: 2 };

function worst(subsystems: Subsystem[]): SubsystemStatus {
  return subsystems.reduce<SubsystemStatus>(
    (acc, s) => (RANK[s.status] > RANK[acc] ? s.status : acc),
    "ok"
  );
}

const DAY_MS = 24 * 3600 * 1000;

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", async () => {
    const now = Date.now();
    const [heartbeats, newestFv, proxyTicks, newestAnchor, newestCommit] = await Promise.all([
      latestHeartbeats(),
      newestFairValueTs(),
      lastProxyTickPerSource(),
      newestAnchorTs(),
      newestConfirmedCommitTs(),
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

    // indexer: heartbeat freshness.
    const indexerStatus: SubsystemStatus =
      indexerAgeMs === null || indexerAgeMs > timing.heartbeatStaleMs * 5
        ? "down"
        : indexerAgeMs > timing.heartbeatStaleMs || (indexerHb !== null && !indexerHb.ok)
          ? "degraded"
          : "ok";

    // engine: are fair value cycles landing.
    const engineStatus: SubsystemStatus =
      lastCycleAgeMs === null
        ? "down"
        : lastCycleAgeMs > timing.cycleSeconds * 3 * 1000
          ? "degraded"
          : "ok";

    // publisher: commits confirming on-chain. no heartbeat yet means it has
    // not run; that is degraded, not down (proofs still store locally).
    const commitAgeMs = newestCommit ? now - new Date(newestCommit).getTime() : null;
    const publisherStatus: SubsystemStatus =
      publisherHb === null
        ? "degraded"
        : !publisherHb.ok
          ? "degraded"
          : "ok";

    // anchors: is the model anchor being maintained.
    const anchorAgeMs = newestAnchor ? now - new Date(newestAnchor).getTime() : null;
    const anchorStatus: SubsystemStatus =
      anchorAgeMs === null
        ? "degraded"
        : anchorAgeMs > 3 * DAY_MS
          ? "degraded"
          : "ok";

    // proxies: 24/7 drift signals fresh.
    const staleSources = sources.filter((s) => s.stale).length;
    const proxyNewest = proxyTicks.reduce<number | null>((acc, t) => {
      const ms = new Date(t.ts).getTime();
      return acc === null ? ms : Math.max(acc, ms);
    }, null);
    const proxyStatus: SubsystemStatus =
      sources.length === 0
        ? "ok"
        : staleSources === sources.length
          ? "down"
          : staleSources > 0
            ? "degraded"
            : "ok";

    const subsystems: Subsystem[] = [
      {
        name: "indexer",
        status: indexerStatus,
        lastSuccess: indexerHb ? indexerHb.ts : null,
        ageMs: indexerAgeMs,
        description:
          indexerStatus === "ok"
            ? "polling pools and proxies on schedule"
            : indexerStatus === "degraded"
              ? "heartbeat is late or the last tick reported errors"
              : "no recent heartbeat; the worker may be down",
      },
      {
        name: "engine",
        status: engineStatus,
        lastSuccess: newestFv,
        ageMs: lastCycleAgeMs,
        description:
          engineStatus === "ok"
            ? "fair value cycles are publishing"
            : engineStatus === "degraded"
              ? "the last cycle is older than expected"
              : "no fair value cycles have published",
      },
      {
        name: "publisher",
        status: publisherStatus,
        lastSuccess: newestCommit,
        ageMs: commitAgeMs,
        description:
          publisherStatus === "ok"
            ? "commits are confirming on-chain"
            : "no publisher heartbeat or the last commit failed; proofs still store locally",
      },
      {
        name: "anchors",
        status: anchorStatus,
        lastSuccess: newestAnchor,
        ageMs: anchorAgeMs,
        description:
          anchorStatus === "ok"
            ? "close and open anchors are current"
            : anchors.automatedSource
              ? "no recent anchor; automation may be failing (check the ops channel)"
              : "no recent anchor; insert manually or enable automation",
      },
      {
        name: "proxies",
        status: proxyStatus,
        lastSuccess: proxyNewest === null ? null : new Date(proxyNewest).toISOString(),
        ageMs: proxyNewest === null ? null : now - proxyNewest,
        description:
          proxyStatus === "ok"
            ? "24/7 proxy signals are fresh"
            : proxyStatus === "degraded"
              ? `${staleSources} of ${sources.length} proxy sources are stale`
              : "all proxy sources are stale",
      },
    ];

    const status = worst(subsystems);

    return {
      data: {
        status,
        mockMode,
        subsystems,
        heartbeatStaleCycles: ops.heartbeatStaleCycles,
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

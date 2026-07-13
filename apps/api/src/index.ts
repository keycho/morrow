// fletch api. fastify on railway.
//
// endpoints:
//   GET /v1/tokens
//   GET /v1/prices                       latest fair value, all tokens
//   GET /v1/prices/:symbol               latest plus 24h history
//   GET /v1/prices/:symbol/history       paginated history (from, to)
//   GET /v1/commits                      commit records with tx hashes
//   GET /v1/commits/:cycleId
//   GET /v1/proof/:symbol/:cycleId       merkle proof for verification
//   GET /v1/accuracy/:symbol             realized error vs next-open prints
//   GET /health
//   POST /v1/admin/anchors               bearer ADMIN_TOKEN
//   POST /v1/admin/keys                  bearer ADMIN_TOKEN
//
// tiers: anonymous (free, rate limited), api key via x-api-key (keyed
// limits), and an x402 payment-required path on the price endpoints for
// agent pay-per-query (skeleton; settlement behind an interface).

import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { api, disclaimer, ops, telegram } from "@fletch/config";
import { OpsAlerter, logTransport, makeTelegramTransport } from "@fletch/telegram/ops";
import { resolveTier, type Tier } from "./auth.js";
import { closeDb } from "./db.js";
import { createX402Middleware, UnwiredVerifier } from "./x402.js";
import { record5xx, startOpsMonitor } from "./opsmonitor.js";
import { registerPriceRoutes } from "./routes/prices.js";
import { registerCommitRoutes } from "./routes/commits.js";
import { registerAccuracyRoutes } from "./routes/accuracy.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerSpreadRoutes } from "./routes/spreads.js";
import { registerReceiptRoutes } from "./routes/receipts.js";

interface TieredRequest extends FastifyRequest {
  fletchTier?: Tier;
  fletchKeyHash?: string | null;
}

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: "info" },
    trustProxy: true,
  });

  await app.register(cors, { origin: api.corsOrigin });

  // ops alerter: logs and pages the private telegram ops channel.
  const alerter = new OpsAlerter(ops.alertCooldownMs, [
    logTransport,
    makeTelegramTransport(telegram.ops),
  ]);

  // resolve the caller tier before the rate limiter runs
  app.addHook("onRequest", async (req) => {
    const tiered = req as TieredRequest;
    const { tier, keyHash } = await resolveTier(req);
    tiered.fletchTier = tier;
    tiered.fletchKeyHash = keyHash;
  });

  // record 5xx responses for the spike monitor.
  app.addHook("onResponse", async (_req: FastifyRequest, reply: FastifyReply) => {
    if (reply.statusCode >= 500) record5xx();
  });

  await app.register(rateLimit, {
    global: true,
    max: (req) =>
      (req as TieredRequest).fletchTier === "keyed"
        ? api.rateLimit.keyedPerMinute
        : api.rateLimit.freePerMinute,
    timeWindow: "1 minute",
    keyGenerator: (req) => (req as TieredRequest).fletchKeyHash ?? req.ip,
    allowList: (req) => req.url === "/health",
    errorResponseBuilder: (_req, context) => ({
      error: "rate limit exceeded",
      retryAfterMs: context.ttl,
      hint: "send an api key in x-api-key for higher limits",
      disclaimer,
    }),
  });

  // x402 skeleton. swap UnwiredVerifier for a real implementation to wire
  // settlement; nothing else changes.
  const x402 = createX402Middleware(new UnwiredVerifier());

  registerPriceRoutes(app, x402);
  registerCommitRoutes(app);
  registerAccuracyRoutes(app);
  registerHealthRoutes(app);
  registerAdminRoutes(app);
  registerSpreadRoutes(app);
  registerReceiptRoutes(app);

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: "not found", disclaimer });
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    app.log.error({ err }, "request failed");
    const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    void reply.code(statusCode).send({ error: "internal error", disclaimer });
  });

  const stopMonitor = startOpsMonitor(alerter);

  // graceful shutdown: fastify drains in-flight requests before closing.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info("draining, closing after in-flight requests");
    stopMonitor();
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await app.listen({ port: api.port, host: api.host });
  app.log.info(`fletch api listening on ${api.host}:${api.port}`);

  // unhandled worker crash: page the ops channel, then exit non-zero.
  process.on("uncaughtException", (err) => {
    void alerter
      .alert({ key: "api-crash", severity: "page", title: "api crashed", message: err.message })
      .finally(() => process.exit(1));
  });
}

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error("fatal:", message);
  const alerter = new OpsAlerter(ops.alertCooldownMs, [
    logTransport,
    makeTelegramTransport(telegram.ops),
  ]);
  await alerter
    .alert({ key: "api-crash", severity: "page", title: "api failed to start", message })
    .catch(() => undefined);
  process.exit(1);
});

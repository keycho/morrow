// generic 24/7 proxy signal fetcher. each source is an http endpoint plus a
// json path, defined entirely in config. per-source timeout, bounded retries
// with exponential backoff, staleness flags, and a circuit breaker. one bad
// source never blocks the others.

import { activeFetchSources, type ProxySourceConfig } from "@morrow/config";
import { CircuitBreaker, backoffDelayMs, sleep } from "./breaker.js";
import { log } from "./log.js";

const breakers = new Map<string, CircuitBreaker>();

function breakerFor(name: string): CircuitBreaker {
  let b = breakers.get(name);
  if (!b) {
    b = new CircuitBreaker(name);
    breakers.set(name, b);
  }
  return b;
}

// walk a dot path like "data.items.0.price" through parsed json.
export function extractJsonPath(payload: unknown, path: string): number {
  let cursor: unknown = payload;
  for (const part of path.split(".")) {
    if (cursor === null || cursor === undefined) {
      throw new Error(`json path dead-ends at "${part}"`);
    }
    if (Array.isArray(cursor)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) throw new Error(`expected array index, got "${part}"`);
      cursor = cursor[idx];
    } else if (typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      throw new Error(`json path hit a scalar before "${part}"`);
    }
  }
  const value = typeof cursor === "string" ? Number(cursor) : cursor;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`json path did not resolve to a finite number`);
  }
  return value;
}

async function fetchOnce(source: ProxySourceConfig): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), source.timeoutMs);
  try {
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "morrow-indexer/0.1" },
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const body: unknown = await res.json();
    return extractJsonPath(body, source.jsonPath);
  } finally {
    clearTimeout(timer);
  }
}

export interface ProxyFetchResult {
  source: ProxySourceConfig;
  ok: boolean;
  value?: number;
  latencyMs: number;
  error?: string;
  skippedByBreaker: boolean;
}

export async function fetchProxy(source: ProxySourceConfig): Promise<ProxyFetchResult> {
  const breaker = breakerFor(source.name);
  const startedAt = Date.now();
  if (!breaker.allow(startedAt)) {
    return {
      source,
      ok: false,
      latencyMs: 0,
      error: "circuit breaker open",
      skippedByBreaker: true,
    };
  }
  let lastError = "";
  for (let attempt = 0; attempt <= source.retries; attempt++) {
    try {
      const value = await fetchOnce(source);
      breaker.success();
      return {
        source,
        ok: true,
        value,
        latencyMs: Date.now() - startedAt,
        skippedByBreaker: false,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < source.retries) await sleep(backoffDelayMs(attempt));
    }
  }
  breaker.failure(Date.now());
  log.warn("proxy source failed", { source: source.name, error: lastError });
  return {
    source,
    ok: false,
    latencyMs: Date.now() - startedAt,
    error: lastError,
    skippedByBreaker: false,
  };
}

export async function fetchAllProxies(): Promise<ProxyFetchResult[]> {
  return Promise.all(activeFetchSources().map((s) => fetchProxy(s)));
}

// per-source status for the heartbeat detail payload.
const lastSuccessAt = new Map<string, number>();

export function recordSuccess(name: string, at: number): void {
  lastSuccessAt.set(name, at);
}

export function proxyStatusSnapshot(now: number): Record<string, unknown> {
  const status: Record<string, unknown> = {};
  for (const s of activeFetchSources()) {
    const b = breakerFor(s.name).snapshot();
    const last = lastSuccessAt.get(s.name);
    status[s.name] = {
      breaker: b.state,
      consecutiveFailures: b.consecutiveFailures,
      lastSuccessAgoMs: last === undefined ? null : now - last,
      stale: last === undefined ? true : now - last > s.stalenessMs,
    };
  }
  return status;
}

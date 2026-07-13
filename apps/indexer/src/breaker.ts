// per-source circuit breaker. a source that fails repeatedly is opened and
// skipped until the cooldown passes, then a single probe is allowed. one bad
// source must never take down the worker or starve the others.

import { circuitBreaker } from "@fletch/config";

export type BreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  readonly name: string;
  private failures = 0;
  private openedAt = 0;
  private state: BreakerState = "closed";

  constructor(name: string) {
    this.name = name;
  }

  // returns true when a call may proceed.
  allow(now: number): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (now - this.openedAt >= circuitBreaker.cooldownMs) {
        this.state = "half_open";
        return true; // one probe
      }
      return false;
    }
    // half_open: a probe is already in flight this tick; block extras.
    return false;
  }

  success(): void {
    this.failures = 0;
    this.state = "closed";
  }

  failure(now: number): void {
    this.failures += 1;
    if (this.state === "half_open" || this.failures >= circuitBreaker.failureThreshold) {
      this.state = "open";
      this.openedAt = now;
    }
  }

  snapshot(): { state: BreakerState; consecutiveFailures: number } {
    return { state: this.state, consecutiveFailures: this.failures };
  }
}

export function backoffDelayMs(attempt: number): number {
  const raw = circuitBreaker.backoffBaseMs * 2 ** attempt;
  return Math.min(raw, circuitBreaker.backoffMaxMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

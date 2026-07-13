// ops alerting. an oracle with silent downtime is a product failure, so the
// worker raises alerts on conditions the operator must know about. this module
// is the alert plumbing: a cooldown-aware alerter with pluggable transports.
// task 1 uses the logging transport; ops hardening (task 3) adds a telegram
// transport and more triggers, and wires resolved notifications.

import { log } from "./log.js";

export type OpsSeverity = "warn" | "page";

export interface OpsEvent {
  // stable key identifying the condition, used for cooldown and resolve.
  key: string;
  severity: OpsSeverity;
  title: string;
  message: string;
  detail?: Record<string, unknown>;
}

export type OpsPhase = "alert" | "resolved";

export type OpsTransport = (event: OpsEvent, phase: OpsPhase) => Promise<void>;

// logs every alert and resolution. never throws.
export const logTransport: OpsTransport = async (event, phase) => {
  const head = phase === "resolved" ? "ops resolved" : `ops ${event.severity}`;
  log.warn(`${head}: ${event.title}`, {
    key: event.key,
    message: event.message,
    ...(event.detail ?? {}),
  });
};

export class OpsAlerter {
  private firedAt = new Map<string, number>();
  private active = new Set<string>();

  constructor(
    private readonly cooldownMs: number,
    private readonly transports: OpsTransport[]
  ) {}

  // raise an alert. repeated alerts for the same key inside the cooldown are
  // suppressed, but the condition stays marked active so it can be resolved.
  async alert(event: OpsEvent, nowMs: number = Date.now()): Promise<void> {
    this.active.add(event.key);
    const last = this.firedAt.get(event.key);
    if (last !== undefined && nowMs - last < this.cooldownMs) return;
    this.firedAt.set(event.key, nowMs);
    for (const t of this.transports) {
      await t(event, "alert").catch(() => undefined);
    }
  }

  // clear a previously active condition and send a resolved notification once.
  async resolve(key: string, message: string): Promise<void> {
    if (!this.active.has(key)) return;
    this.active.delete(key);
    this.firedAt.delete(key);
    const event: OpsEvent = { key, severity: "warn", title: "resolved", message };
    for (const t of this.transports) {
      await t(event, "resolved").catch(() => undefined);
    }
  }

  isActive(key: string): boolean {
    return this.active.has(key);
  }
}

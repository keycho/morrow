// ops alerting. an oracle with silent downtime is a product failure, so the
// workers raise alerts on conditions the operator must know about. this is the
// shared plumbing: a cooldown-aware alerter with pluggable transports and
// resolved notifications. the indexer and the api both use it, both pointing
// at the private ops telegram channel.

import { sendTelegramMessage } from "./send.js";

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

function stamp(): string {
  return new Date().toISOString();
}

// logs every alert and resolution. never throws.
export const logTransport: OpsTransport = async (event, phase) => {
  const head = phase === "resolved" ? "ops resolved" : `ops ${event.severity}`;
  // eslint-disable-next-line no-console
  console.log(
    `${stamp()} [${head}] ${event.title}: ${event.message}` +
      (event.detail ? " " + JSON.stringify(event.detail) : "")
  );
};

export interface TelegramTransportConfig {
  botToken: string;
  chatId: string;
  dryRun: boolean;
}

// sends ops events to a telegram channel, or logs when dry-run or unconfigured.
export function makeTelegramTransport(cfg: TelegramTransportConfig): OpsTransport {
  const live = !cfg.dryRun && cfg.botToken !== "" && cfg.chatId !== "";
  return async (event, phase) => {
    const head = phase === "resolved" ? "resolved" : event.severity;
    const lines = [`fletch ops ${head}`, event.title.toLowerCase(), event.message.toLowerCase()];
    const text = lines.join("\n");
    if (!live) {
      // eslint-disable-next-line no-console
      console.log(`${stamp()} [ops dry-run] ${text.replace(/\n/g, " | ")}`);
      return;
    }
    await sendTelegramMessage(cfg.botToken, cfg.chatId, text);
  };
}

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

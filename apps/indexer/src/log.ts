// tiny structured logger. lowercase, timestamped, no dependencies. every line
// (message and extra) runs through redactSecrets at this boundary, so a secret
// can never reach stdout even if some upstream error message embeds one (an
// alchemy key inside a viem error, the finnhub key inside an anchor url).

import { redactSecrets } from "@morrow/config";

function line(level: string, msg: string, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const suffix = extra ? " " + JSON.stringify(extra) : "";
  // eslint-disable-next-line no-console
  console.log(redactSecrets(`${ts} [${level}] ${msg}${suffix}`));
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => line("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => line("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => line("error", msg, extra),
};

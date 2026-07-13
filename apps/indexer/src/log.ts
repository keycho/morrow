// tiny structured logger. lowercase, timestamped, no dependencies.
// never pass secrets to these functions.

function line(level: string, msg: string, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const suffix = extra ? " " + JSON.stringify(extra) : "";
  // eslint-disable-next-line no-console
  console.log(`${ts} [${level}] ${msg}${suffix}`);
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => line("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => line("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => line("error", msg, extra),
};

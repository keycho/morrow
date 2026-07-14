// shared pino logger. all log copy is lowercase, no exclamation marks.

import { pino } from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
});

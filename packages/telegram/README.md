# @fletch/telegram

```
>>--->  fletch
```

the public divergence alert bot. a standalone worker that polls the fletch
`/v1/spreads` endpoint and posts to a public telegram channel when a tracked
token's absolute onchain-vs-fair spread crosses a threshold.

- hysteresis: after an alert the token disarms and only re-arms once the
  spread falls back below `threshold * rearmFraction`, so it does not spam
  while a spread hovers near the line.
- cooldown: at most one alert per token per `cooldownMs`.
- messages are data statements only, lowercase, terminal style, with a single
  disclaimer footer. no trading advice language.
- `dry_run` is on by default: it logs the message instead of sending until the
  bot token is set.

## env

| var | meaning |
| --- | --- |
| `FLETCH_API_URL` | fletch api base url to poll |
| `FLETCH_TG_THRESHOLD_PCT` | absolute spread percent that triggers an alert (default 2) |
| `FLETCH_TG_COOLDOWN_MS` | minimum ms between alerts per token (default 30m) |
| `FLETCH_TG_POLL_MS` | poll interval (default 60s) |
| `FLETCH_PUBLIC_WEB_URL` | dashboard base url for the token link |
| `TELEGRAM_PUBLIC_BOT_TOKEN` | bot token. secret. env only |
| `TELEGRAM_PUBLIC_CHAT_ID` | public channel chat id |
| `TELEGRAM_DRY_RUN` | log instead of send. defaults true |

## run

```
pnpm --filter @fletch/telegram start
```

## the fine print

informational feed, not trading advice.

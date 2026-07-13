# morrow setup

```
>>--->  morrow
```

the ordered checklist for taking this repo from clone to production.

chain facts and token addresses are already filled in `packages/config/config.ts`,
verified from official sources (docs.robinhood.com/chain/contracts,
developers.uniswap.org) as of july 2026. what remains is operator-specific:
a database, an rpc provider key, pool discovery, a funded publisher wallet,
the contract deploy, anchors, and the two hosting deploys.

## what is already done

- chain id 4663, public rpc, blockscout explorer, verifier url
- uniswap v3 factory, quoter, ticklens, multicall, routers
- quote assets: usdg and weth
- the five launch stock tokens (tsla, aapl, nvda, msft, amzn) with verified
  addresses, plus seven more captured in `availableStockTokens` for later

## what you must still do

| # | step | why |
| --- | --- | --- |
| 1 | supabase project + migrations | storage |
| 2 | rpc provider key | do not run against the public endpoint |
| 3 | discover pools | pool addresses are resolved from the factory, not published |
| 4 | proxy sources | the 24/7 drift signal, operator-wired |
| 5 | publisher wallet + funding | signs on-chain commits |
| 6 | deploy MorrowCommits | the commit registry |
| 7 | anchors | last-close and next-open prints |
| 8 | railway (indexer + api) | run the services |
| 9 | vercel (dashboard) | the public site |

## step 0. prerequisites

- node >= 20 and pnpm >= 9 (`corepack enable`)
- foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- a supabase project, a railway account, a vercel account
- an alchemy or quicknode robinhood chain rpc key

```
pnpm install
pnpm -r typecheck
pnpm -r test        # engine suite must be green before anything else
```

## step 0b. try the whole pipeline in mock mode (optional)

works before any placeholder is filled. you only need a database.

```
cp .env.example .env       # set DATABASE_URL only
MOCK_MODE=true pnpm dev:indexer
pnpm dev:api
NEXT_PUBLIC_API_URL=http://localhost:8080 pnpm dev:web
```

synthetic pools and proxies flow through the real engine, real merkle
commits (stored, not sent on-chain), the real api including proofs, and the
real dashboard.

## step 1. database (supabase)

1.1 create the project, note the postgres connection string, set
`DATABASE_URL` in `.env`. use the pooled (transaction mode) string for the
api; the direct string is fine for the indexer.

1.2 apply migrations in order (0001 through 0009). either paste each file
from `supabase/migrations/` into the supabase sql editor, or:

```
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

## step 2. rpc provider key

get an alchemy or quicknode robinhood chain endpoint and set `MORROW_RPC_URL`
in `.env`. the public endpoint (the config default) is rate limited and must
not be used for the indexer or for discovery.

## step 3. discover pools

pool addresses are not published as a table; they are resolved from each
venue. discovery probes uniswap v2, v3, and v4 for every candidate token — the
launch set in `tokens` plus every captured address in `availableStockTokens`
(see `discoveryCandidates`), so one run reports on the whole robinhood chain
equity universe, not only the launch set:

- v3: usdg and weth quotes across the 500, 3000, 10000 fee tiers
- v2: usdg and weth pairs
- v4: usdg, weth (erc20), and native eth quotes across the standard
  fee/tick-spacing combos, at the no-hook pool id, read through the state-view
  lens by pool id (not a per-pool address)

each hit is read and priced through the erc-8056 ui multiplier, and its depth
is normalized to the same ±2% quote-depth measure across venues (v2's
constant-product reserves and v3/v4's concentrated liquidity resolve to one
comparable number, so the model's depth floor means the same thing
everywhere). the script prints one table sorted by dollar depth plus a
ready-to-paste config snippet selecting the deepest usable pool per token
(preferring usdg, since fair value is dollar denominated).

```
MORROW_RPC_URL=<your rpc url> pnpm discover-pools
# machine-readable (stdout is pure json, logs go to stderr):
MORROW_RPC_URL=<your rpc url> pnpm --silent discover-pools --json
```

the v2 factory, v4 pool manager, and v4 state-view addresses in config were
confirmed as deployed contracts on chain (code size greater than zero) before
being trusted, the same check the multicall3 address gets. never assume a
venue address; verify it.

paste the emitted snippet's `protocol`, `pool`, `invert`, `quote`, and
`quoteDecimals` values into the matching entries in `tokens` in
`packages/config/config.ts`. `pool` is a pool/pair address for v2 and v3, or a
v4 pool id (bytes32) for v4. the script excludes any token with no usable pool
from the launch set and flags any weth-only token as needing an eth/usd proxy
to dollarize.

plausibility gate: when `DATABASE_URL` is set, discovery reads the latest close
anchor per token as a reference and marks any pool whose per-share price
deviates more than `MORROW_DISCOVERY_PLAUSIBILITY` (default 25%) from it as
implausible. an implausible pool is shown with the flag but never selected, so
a tokenized market trading far from the underlying cannot silently become the
tracked pool.

honest launch set from a live full-universe run over all ~95 verified robinhood
chain equity tokens (july 2026, 145 pools found, eth/usd 3500 for weth/eth
depth), already reflected in config. only seven pools clear ~$1,000 of ±2%
depth; the six tracked tokens each have a real v4 usdg pool at a plausible
price:

- tsla: pool 0x8517f807.., depth ~$4,000, ~$392/share (vs ~397 ref).
- aapl: pool 0xda4116b5.., depth ~$2,900, ~$316/share (vs ~298 ref, ~6%).
  (an earlier config note used a stale ~235 reference and wrongly excluded this
  pool; at the real ~298 it is inside the gate.)
- nvda: pool 0x3bb34a44.., invert true, depth ~$5,500, ~$204/share.
- googl: pool 0xef22239f.., depth ~$4,200, ~$355/share (vs ~331 ref, ~7%).
- meta: pool 0x5875d407.., invert true, depth ~$1,770, ~$661/share.
- spy: pool 0x7eeda68c.., depth ~$1,290, ~$743/share (s&p 500 etf).

the whole equity universe is captured in `availableStockTokens` and probed
every run, but nothing else clears the bar:

- spcx (spacex): the deepest pool on the network (~$12,000) but a private,
  pre-ipo equity with no official market close to anchor, so the off-hours
  fair-value model (last close + 24/7 drift) cannot price it. tracked only if a
  close reference is defined for it.
- ~74 further tokens (dell, mstr, lly, asml, cost, tsm, avgo, ba, ... ) have a
  real but boilerplate-thin pool clustered around $500-715 of ±2% depth, far
  below the model depth floor, so their onchain weight would be ~0. left
  captured; the weekly worker alerts if any deepens into a real market.
- msft, amzn: no usable pool at all. both also sit in `tokens` as null, which
  blocks live boot until a pool exists or they are removed.
- arm, dram, nasa, nok, rvi: on the operator's list but no full verified
  address resolved on chain, so intentionally absent (not guessed); voo and
  openai likewise have no on-chain contract.

promote a captured token by re-running discovery (its `promotable available
tokens` snippet block), giving it a fresh unused id, and wiring a proxy and
anchor source, then moving it into `tokens`.

weth-quoted pools and dollarization: a weth or native-eth pool prices a stock
in eth, not dollars. the reader dollarizes it by multiplying price and depth by
an eth/usd rate (`dollarization.ethUsdSource` in config, fetched alongside the
proxies and gated by `MORROW_ETHUSD_STALENESS_MS`). a stale eth/usd rate skips
the token for that tick, which degrades confidence rather than publishing a
wrong price. to enable a real weth/eth token later: set its `quote` to "weth",
fill protocol/pool/invert/quoteDecimals from discovery (run with `ETH_USD=<rate>`
to see dollarized prices and depth), and set `MORROW_ETHUSD_URL` and
`MORROW_ETHUSD_JSONPATH`. none of the current launch tokens need this.

keeping discovery current: the indexer runs a discovery pass on a weekly
schedule (`MORROW_DISCOVERY_AUTO`, default on; `MORROW_DISCOVERY_WEEKDAY` /
`MORROW_DISCOVERY_HOUR_ET`) and records every run — cli or worker — in the
`pool_discovery_runs` table, so pool liquidity arriving over time becomes a
queryable dataset. the worker never edits config; it raises an ops alert when
a usable pool appears for a token that is currently null, or when a configured
pool's dollar depth stays below `MORROW_DISCOVERY_DEPTH_ALERT_USD` (default
$500) for `MORROW_DISCOVERY_DEPTH_ALERT_RUNS` (default 3) consecutive runs. you
review the alert and update config by hand.

re-run discovery against your own production rpc before launch; pools and
liquidity evolve. then either fill the remaining tokens or remove them from
the `tokens` array. `assertConfigReady()` refuses to boot live mode while any
listed token's pool is still null, so a missing pool fails loudly at startup
rather than publishing nothing for that token.

note on liquidity: tokenized float is extremely thin at launch (the deepest
launch pools are a few thousand dollars). expect the depth floor to hold the
onchain weight near zero, so fair value will be mostly anchor plus proxy
drift. that is correct behavior, surfaced honestly through the confidence
score, not a bug.

## step 4. proxy signal sources (config.ts)

for each entry in `proxySources`, replace the `url` (`https://PROXY_SOURCE_URL_*`)
and `jsonPath` (`REPLACE.WITH.PATH`) with a real 24/7 source. test the shape
with curl first: a response of `{"data":{"mark_price":"250.1"}}` means
`jsonPath: "data.mark_price"`. multiple sources per token are blended by
weight. drift stays 0 until a source has ticks spanning the last official
close.

## step 5. publisher wallet (.env)

| # | env var | note |
| --- | --- | --- |
| 5.1 | `PUBLISHER_PRIVATE_KEY` | fresh wallet, used only for commits. secret |
| 5.2 | `PUBLISHER_ADDRESS` | its public address (constructor arg at deploy) |
| 5.3 | `DEPLOYER_PRIVATE_KEY` | can be the same wallet for v1. secret |
| 5.4 | fund it | send a little eth on robinhood chain (canonical arbitrum bridge) for gas. one commit per 600s cycle is cheap |

## step 6. deploy MorrowCommits

```
cd packages/contracts
forge install foundry-rs/forge-std   # first time only, creates lib/
forge build
forge test -vv                        # all tests must pass
forge script script/Deploy.s.sol --rpc-url "$MORROW_RPC_URL" --broadcast
```

set `MORROW_COMMITS_ADDRESS` in `.env` to the address the script prints.
optional verification target: `https://robinhoodchain.blockscout.com/api/`.

## step 7. anchors (close and open prices)

the model anchor is the last official close per token; the next-open print
feeds accuracy. two ways to maintain them:

automated (recommended): fill `anchors.sources` in config.ts with a close url,
open url (`{symbol}` is substituted), and json path per token, then set
`MORROW_ANCHOR_AUTOMATED=true`. the indexer inserts the close 15m after the
16:00 et close (13:00 on half days) and the open 5m after 09:30, validates
each against the previous anchor (a jump over 15% is rejected unless a
corporate action explains it), and pages the ops channel on a rejection or a
missed deadline. a missed close is surfaced as a stale-anchor cycle (confidence
capped, band widened) so the feed does not go dark.

manual (the override, always available): set `ADMIN_TOKEN` in `.env`, boot the
api, then per token:

```
curl -X POST "$API_URL/v1/admin/anchors" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"symbol":"tsla","kind":"close","price":REPLACE,"marketTs":"2026-07-11T20:00:00Z"}'
```

`marketTs` is the official print time (16:00 et close, 09:30 et open). keep
inserting a close after every session and an `open` row each morning; opens
feed the accuracy endpoint, which is the marketing.

note on corporate actions: robinhood stock tokens are erc-8056 scaled-ui
tokens. on a split or stock dividend the token's `uiMultiplier()` changes;
the engine detects this, flags the cycle `corporate_action`, and widens the
band. re-insert a fresh close anchor at the post-action per-share price when
that happens.

## step 8. deploy to railway (indexer worker + api)

8.1 indexer (worker, no public port)
- build: `pnpm install --frozen-lockfile`
- start: `pnpm --filter @morrow/indexer start`
- env: `MORROW_RPC_URL`, `MORROW_COMMITS_ADDRESS`, `DATABASE_URL`,
  `PUBLISHER_PRIVATE_KEY`, `TELEGRAM_OPS_BOT_TOKEN`, `TELEGRAM_OPS_CHAT_ID`
  (leave `TELEGRAM_OPS_DRY_RUN=true` until ready), `MORROW_ANCHOR_AUTOMATED`,
  optionally `MORROW_POLL_MS`, `MORROW_CYCLE_SECONDS`,
  `MORROW_TWAP_WINDOW_SECONDS`. the indexer also generates the weekly receipt
  and pages the ops channel.

8.2 api (public)
- build: `pnpm install --frozen-lockfile`
- start: `pnpm --filter @morrow/api start`
- env: `DATABASE_URL`, `ADMIN_TOKEN`, `API_PORT` (or let it read railway's
  injected `PORT`), `API_CORS_ORIGIN` (your vercel domain),
  `MORROW_COMMITS_ADDRESS`, `MORROW_EXPLORER_URL`, `TELEGRAM_OPS_BOT_TOKEN`,
  `TELEGRAM_OPS_CHAT_ID`, `X402_ENABLED` when ready

8.3 public alert bot (worker, no public port, optional)
- start: `pnpm --filter @morrow/telegram start`
- env: `MORROW_API_URL` (the api url), `MORROW_PUBLIC_WEB_URL` (the vercel
  domain), `TELEGRAM_PUBLIC_BOT_TOKEN`, `TELEGRAM_PUBLIC_CHAT_ID`,
  `TELEGRAM_DRY_RUN=false` to go live, optionally `MORROW_TG_THRESHOLD_PCT`.
  dry-run (default) logs the messages so you can watch before wiring the token.

## step 9. deploy the dashboard to vercel

- root directory: `apps/web` (vercel detects the pnpm workspace and installs
  from the repo root)
- env: `NEXT_PUBLIC_API_URL` (the railway api url),
  `NEXT_PUBLIC_EXPLORER_URL` (defaults to the blockscout url)

## optional. publish the mcp package

```
cd packages/mcp
pnpm build
npm publish --access public
```

users configure it with their `MORROW_API_URL` (and `MORROW_RPC_URL` for the
on-chain check). see `packages/mcp/README.md` for the claude desktop snippet.

## weekly receipts

the indexer generates the weekly accuracy card automatically on the configured
weekday (default monday) after the open anchors land, and stores it. to
generate one by hand:

```
DATABASE_URL=... pnpm receipts          # generate last week's receipt
DATABASE_URL=... pnpm receipts --force  # regenerate an existing week
```

the png is rasterized by `@resvg/resvg-js` (an optional native dep, no
headless browser); if it is not installed the markdown and svg still generate
and the png is omitted. receipts are generated only, never auto-posted; post
the cards yourself from the `/receipts` page or `GET /v1/receipts`.

## weekly discovery

the indexer runs a multi-protocol discovery pass weekly (default monday at noon
et, `MORROW_DISCOVERY_*`) and records every run in `pool_discovery_runs`. it
does not edit config; it alerts when a usable pool appears for a null token or a
configured pool's depth stays below the floor for several runs (see the runbook
below). to run one by hand and inspect the dataset:

```
MORROW_RPC_URL=... DATABASE_URL=... pnpm discover-pools          # table + snippet
MORROW_RPC_URL=... DATABASE_URL=... pnpm --silent discover-pools --json > run.json
```

both the cli and the worker append to the same table, so the history of which
venues and pools appeared, at what depth, week by week, is one query away.

## optional. publish the mcp package

(unchanged; see `packages/mcp/README.md`.)

## optional. x402 pay-per-query

the 402 path is live behind `X402_ENABLED=true`, but settlement is an
interface (`apps/api/src/x402.ts`, `PaymentVerifier`). before enabling, fill
`api.x402.network` and `api.x402.payTo` in config.ts and swap
`UnwiredVerifier` for your verifier. no token, treasury, or payout logic
exists in this repo by design.

## ops runbook

each ops alert pages the private telegram channel with a stable key and a
resolved notice when the condition clears. what each means and the first thing
to check:

| alert | what it means | first thing to check |
| --- | --- | --- |
| indexer heartbeat stale | no indexer heartbeat for over 3 cycles | is the indexer worker running on railway; check its logs and the db connection |
| rpc failures | several consecutive ticks read no pools | is `MORROW_RPC_URL` (alchemy/quicknode) up and not rate limited; check the provider dashboard |
| publisher wallet low | gas balance below the floor, with a runway estimate | top up the publisher wallet with eth over the canonical bridge |
| commit publish failed / tx reverted | a cycle commit did not confirm | check gas, the rpc, and `MORROW_COMMITS_ADDRESS`; the reconcile pass retries automatically |
| anchor rejected | an automated anchor jumped over the threshold with no corporate action | verify the print at the source; if it is a real split, the flag clears once a corporate_action cycle records; otherwise insert the correct anchor manually |
| anchor missed deadline | an anchor is still missing hours after its target | check the anchor source url and json path; insert manually to unblock, the engine is running stale-anchor meanwhile |
| api 5xx spike | the api returned many 5xx in the window | check the api logs and the db; likely a query or connection issue |
| discovery: new pool | a usable pool appeared for a token that is null in config | review the pool in `pool_discovery_runs` (or run `pnpm discover-pools`); if it is a real market, add protocol/pool/invert/quote to config by hand |
| discovery: pool depth low | a configured pool's depth stayed below the alert floor for several runs | the pool may be drying up; check `pool_discovery_runs`, and consider re-running discovery for a deeper venue or lowering the token's weight |
| indexer/api crashed | an unhandled error took a worker down | read the crash message in the page and the worker logs; the process exits non-zero so railway restarts it |

## verify the deployment

- `GET $API_URL/health` says `"status": "ok"` and every source is fresh
- the dashboard feed shows all tokens with a regime badge that matches the
  clock in new york
- `GET $API_URL/v1/commits` shows `confirmed` rows with tx hashes; open one
  on the explorer
- on the commits page, verify an observation in the browser; then run the
  mcp `verify_observation` tool with `MORROW_RPC_URL` set so the root is
  checked against the chain itself
- after the first market open, insert the `open` anchors and check
  `GET $API_URL/v1/accuracy/tsla`
- the `/spreads` board ranks the onchain-vs-fair divergences; the public
  alert bot logs (dry-run) or posts when a spread crosses the threshold
- `/health` shows every subsystem green; force a condition (stop the
  indexer) and confirm the ops channel pages, then recovers
- run `pnpm receipts` and check `/receipts` and
  `GET $API_URL/v1/receipts/<week>/card.png`

## positioning

chainlink is robinhood chain's official oracle and feeds stock token prices.
morrow does not compete with that feed. morrow's product is the off-hours
fair value blend and the verifiable commit trail, a different object. the
docs page says this explicitly so nobody frames morrow as a chainlink
replacement.

## remaining placeholder index (grep targets)

only these remain before live mode:

```
PROXY_SOURCE_URL_*                     config.ts (step 4)
REPLACE.WITH.PATH                      config.ts (step 4)
token pool: null                       config.ts (step 3, discovery fills)
X402_NETWORK_PLACEHOLDER, X402_PAY_TO  config.ts (only for x402)
ANCHOR_SOURCE_URL_PLACEHOLDER          config.ts (future automation)
MORROW_COMMITS_ADDRESS                 .env (after step 6)
DATABASE_URL, PUBLISHER_PRIVATE_KEY,
  DEPLOYER_PRIVATE_KEY, ADMIN_TOKEN    .env (secrets)
MORROW_RPC_URL                         .env (step 2, provider key)
NEXT_PUBLIC_API_URL                    vercel env
```

## the fine print

informational feed. not for use in liquidations, settlement, or as sole
pricing source. no warranty.

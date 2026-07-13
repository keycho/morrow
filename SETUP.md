# fletch setup

```
>>--->  fletch
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
| 6 | deploy FletchCommits | the commit registry |
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

get an alchemy or quicknode robinhood chain endpoint and set `FLETCH_RPC_URL`
in `.env`. the public endpoint (the config default) is rate limited and must
not be used for the indexer or for discovery.

## step 3. discover pools

pool addresses are not published as a table; they are resolved from the v3
factory. the discovery script probes usdg and weth quotes across the 500,
3000, and 10000 fee tiers for each launch token, reads each pool, and prints
a ready-to-paste config snippet selecting the deepest pool per token
(preferring usdg, since fair value is dollar denominated).

```
FLETCH_RPC_URL=<your rpc url> pnpm discover-pools
```

paste the emitted snippet's `pool`, `invert`, `quote`, and `quoteDecimals`
values into the matching entries in `tokens` in `packages/config/config.ts`.
the script excludes any token with no pool from the launch set and flags any
weth-only token as needing an eth/usd proxy to dollarize (not wired in v1).

note on liquidity: tokenized float is extremely thin at launch. expect the
depth floor to hold the onchain weight near zero, so fair value will be
mostly anchor plus proxy drift. that is correct behavior, surfaced honestly
through the confidence score, not a bug.

`assertConfigReady()` refuses to boot live mode while any launch token's pool
is still null, so a missed paste fails loudly at startup.

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

## step 6. deploy FletchCommits

```
cd packages/contracts
forge install foundry-rs/forge-std   # first time only, creates lib/
forge build
forge test -vv                        # all tests must pass
forge script script/Deploy.s.sol --rpc-url "$FLETCH_RPC_URL" --broadcast
```

set `FLETCH_COMMITS_ADDRESS` in `.env` to the address the script prints.
optional verification target: `https://robinhoodchain.blockscout.com/api/`.

## step 7. anchors (close and open prices)

the model anchor is the last official close per token. v1 is manual by
design (`anchors.automatedSource` in config.ts reserves the automated path).

set `ADMIN_TOKEN` in `.env`, boot the api, then per token:

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
- start: `pnpm --filter @fletch/indexer start`
- env: `FLETCH_RPC_URL`, `FLETCH_COMMITS_ADDRESS`, `DATABASE_URL`,
  `PUBLISHER_PRIVATE_KEY`, optionally `FLETCH_POLL_MS`,
  `FLETCH_CYCLE_SECONDS`, `FLETCH_TWAP_WINDOW_SECONDS`

8.2 api (public)
- build: `pnpm install --frozen-lockfile`
- start: `pnpm --filter @fletch/api start`
- env: `DATABASE_URL`, `ADMIN_TOKEN`, `API_PORT` (or let it read railway's
  injected `PORT`), `API_CORS_ORIGIN` (your vercel domain),
  `FLETCH_COMMITS_ADDRESS`, `FLETCH_EXPLORER_URL`, `X402_ENABLED` when ready

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

users configure it with their `FLETCH_API_URL` (and `FLETCH_RPC_URL` for the
on-chain check). see `packages/mcp/README.md` for the claude desktop snippet.

## optional. x402 pay-per-query

the 402 path is live behind `X402_ENABLED=true`, but settlement is an
interface (`apps/api/src/x402.ts`, `PaymentVerifier`). before enabling, fill
`api.x402.network` and `api.x402.payTo` in config.ts and swap
`UnwiredVerifier` for your verifier. no token, treasury, or payout logic
exists in this repo by design.

## verify the deployment

- `GET $API_URL/health` says `"status": "ok"` and every source is fresh
- the dashboard feed shows all tokens with a regime badge that matches the
  clock in new york
- `GET $API_URL/v1/commits` shows `confirmed` rows with tx hashes; open one
  on the explorer
- on the commits page, verify an observation in the browser; then run the
  mcp `verify_observation` tool with `FLETCH_RPC_URL` set so the root is
  checked against the chain itself
- after the first market open, insert the `open` anchors and check
  `GET $API_URL/v1/accuracy/tsla`

## positioning

chainlink is robinhood chain's official oracle and feeds stock token prices.
fletch does not compete with that feed. fletch's product is the off-hours
fair value blend and the verifiable commit trail, a different object. the
docs page says this explicitly so nobody frames fletch as a chainlink
replacement.

## remaining placeholder index (grep targets)

only these remain before live mode:

```
PROXY_SOURCE_URL_*                     config.ts (step 4)
REPLACE.WITH.PATH                      config.ts (step 4)
token pool: null                       config.ts (step 3, discovery fills)
X402_NETWORK_PLACEHOLDER, X402_PAY_TO  config.ts (only for x402)
ANCHOR_SOURCE_URL_PLACEHOLDER          config.ts (future automation)
FLETCH_COMMITS_ADDRESS                 .env (after step 6)
DATABASE_URL, PUBLISHER_PRIVATE_KEY,
  DEPLOYER_PRIVATE_KEY, ADMIN_TOKEN    .env (secrets)
FLETCH_RPC_URL                         .env (step 2, provider key)
NEXT_PUBLIC_API_URL                    vercel env
```

## the fine print

informational feed. not for use in liquidations, settlement, or as sole
pricing source. no warranty.

# fletch setup

```
>>--->  fletch
```

the exact ordered checklist for taking this repo from clone to production.
every placeholder in the codebase is listed here. nothing in the repo guesses
chain facts: robinhood chain launched july 2026 and its chain id, rpc
endpoints, and pool addresses must come from official robinhood chain docs,
defillama, or dune, or be supplied by you.

placeholders live in exactly two places:

- `packages/config/config.ts` (pool addresses, proxy sources, x402 details)
- `.env` (chain facts, secrets, deployment urls), documented in `.env.example`

## step 0. prerequisites

- node >= 20 and pnpm >= 9 (`corepack enable`)
- foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- a supabase project (free tier is fine to start)
- a railway account (indexer worker + api) and a vercel account (dashboard)

```
pnpm install
pnpm -r typecheck
pnpm -r test        # engine suite must be green before anything else
```

## step 1. try the whole pipeline in mock mode (optional but recommended)

works before any placeholder is filled. you only need a database (step 3 can
be a local postgres for this).

```
cp .env.example .env       # set DATABASE_URL only
MOCK_MODE=true pnpm dev:indexer
pnpm dev:api
NEXT_PUBLIC_API_URL=http://localhost:8080 pnpm dev:web
```

synthetic pools and proxies flow through the real engine, real merkle
commits (stored, not sent on-chain), the real api including proofs, and the
real dashboard.

## step 2. chain facts (fill in .env)

from official robinhood chain docs only. do not guess. if a value is not
published yet, stop and get it from me.

| # | env var | where it comes from |
| --- | --- | --- |
| 2.1 | `FLETCH_CHAIN_ID` | official robinhood chain docs |
| 2.2 | `FLETCH_RPC_URL` | official robinhood chain docs (https json-rpc) |
| 2.3 | `FLETCH_EXPLORER_URL` | official block explorer base url |

## step 3. database (supabase)

3.1 create the project, note the postgres connection string, set
`DATABASE_URL` in `.env`. use the pooled (transaction mode) string for the
api; the direct string is fine for the indexer.

3.2 apply migrations in order. either paste each file from
`supabase/migrations/` (0001 through 0008) into the supabase sql editor, or:

```
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

## step 4. tracked token pools (fill in config.ts)

for each entry in `tokens` in `packages/config/config.ts`:

| # | field | placeholder to replace | where it comes from |
| --- | --- | --- | --- |
| 4.1 | `pool` | `0xPOOL_TSLA`, `0xPOOL_AAPL`, `0xPOOL_NVDA`, `0xPOOL_MSFT`, `0xPOOL_AMZN` | official robinhood chain docs, defillama, or dune. uniswap v3 pool per stock token |
| 4.2 | `invert` | `false` | check the pool's `token0()` on the explorer. if the stock token is token1, set true |
| 4.3 | `baseDecimals` / `quoteDecimals` | `18` / `6` | erc20 decimals of the stock token and the quote token |

sanity check after filling: run the indexer live for one tick and compare the
logged spot against a known market price. a wildly wrong number means the
invert flag or decimals are wrong. add or remove token entries freely; ids
must stay stable once used (they are hashed into merkle leaves).

## step 5. proxy signal sources (fill in config.ts)

for each entry in `proxySources`:

| # | field | placeholder to replace |
| --- | --- | --- |
| 5.1 | `url` | `https://PROXY_SOURCE_URL_*` per token |
| 5.2 | `jsonPath` | `REPLACE.WITH.PATH` dot path to the numeric price in the response |
| 5.3 | `weight` | relative weight in the drift blend |

test each source shape with curl before boot, e.g. a response of
`{"data":{"mark_price":"250.1"}}` means `jsonPath: "data.mark_price"`.
multiple sources per token are blended; add entries and reference them from
the token's `proxies` list. drift stays 0 until a source has ticks spanning
the last official close, which takes one session boundary.

## step 6. publisher wallet (fill in .env)

| # | env var | note |
| --- | --- | --- |
| 6.1 | `PUBLISHER_PRIVATE_KEY` | fresh wallet, used only for commits. secret |
| 6.2 | `PUBLISHER_ADDRESS` | its public address (constructor arg at deploy) |
| 6.3 | `DEPLOYER_PRIVATE_KEY` | can be the same wallet for v1. secret |
| 6.4 | fund it | send a little eth on robinhood chain for gas. one commit per 600s cycle is cheap; top up as needed |

## step 7. deploy FletchCommits

```
cd packages/contracts
forge install foundry-rs/forge-std   # first time only, creates lib/
forge build
forge test -vv                        # all tests must pass
forge script script/Deploy.s.sol --rpc-url "$FLETCH_RPC_URL" --broadcast
```

| # | env var | value |
| --- | --- | --- |
| 7.1 | `FLETCH_COMMITS_ADDRESS` | the address the deploy script prints |

## step 8. anchors (initial close prices)

the model anchor is the last official close per token. v1 is manual by
design (`anchors.automatedSource` in config.ts reserves the automated path,
`ANCHOR_SOURCE_URL_PLACEHOLDER` stays untouched until then).

set `ADMIN_TOKEN` in `.env`, boot the api, then per token:

```
curl -X POST "$API_URL/v1/admin/anchors" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"symbol":"tsla","kind":"close","price":REPLACE,"marketTs":"2026-07-11T20:00:00Z"}'
```

or straight sql into `anchors`. `marketTs` is the official print time
(16:00 et close). keep inserting a close after every session, and an `open`
row (09:30 et) each morning; opens feed the accuracy endpoint, which is the
marketing. until you automate this, a calendar reminder works.

## step 9. deploy to railway (indexer worker + api)

create two services from this repo:

9.1 indexer (worker, no public port)
- build: `pnpm install --frozen-lockfile`
- start: `pnpm --filter @fletch/indexer start`
- env: `FLETCH_CHAIN_ID`, `FLETCH_RPC_URL`, `FLETCH_COMMITS_ADDRESS`,
  `DATABASE_URL`, `PUBLISHER_PRIVATE_KEY`, optionally `FLETCH_POLL_MS`,
  `FLETCH_CYCLE_SECONDS`, `FLETCH_TWAP_WINDOW_SECONDS`

9.2 api (public)
- build: `pnpm install --frozen-lockfile`
- start: `pnpm --filter @fletch/api start`
- env: `DATABASE_URL`, `ADMIN_TOKEN`, `API_PORT` (railway injects `PORT`;
  set `API_PORT` to the same value or map it), `API_CORS_ORIGIN` (your
  vercel domain), `FLETCH_CHAIN_ID`, `FLETCH_COMMITS_ADDRESS`,
  `FLETCH_EXPLORER_URL`, `X402_ENABLED` when ready

## step 10. deploy the dashboard to vercel

- root directory: `apps/web` (vercel detects the pnpm workspace and installs
  from the repo root)
- env: `NEXT_PUBLIC_API_URL` (the railway api url),
  `NEXT_PUBLIC_EXPLORER_URL` (same as `FLETCH_EXPLORER_URL`)

## step 11. publish the mcp package (optional)

```
cd packages/mcp
pnpm build
npm publish --access public
```

users configure it with their `FLETCH_API_URL` (and `FLETCH_RPC_URL` for the
on-chain check). see `packages/mcp/README.md` for the claude desktop snippet.

## step 12. x402 (optional, later)

the 402 path is live behind `X402_ENABLED=true`, but settlement is an
interface (`apps/api/src/x402.ts`, `PaymentVerifier`). before enabling:

| # | config.ts field | placeholder |
| --- | --- | --- |
| 12.1 | `api.x402.network` | `X402_NETWORK_PLACEHOLDER` |
| 12.2 | `api.x402.payTo` | `X402_PAY_TO_PLACEHOLDER` |
| 12.3 | swap `UnwiredVerifier` for your verifier implementation | |

no token, treasury, or payout logic exists in this repo by design.

## step 13. verify the deployment

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

## placeholder index (grep targets)

everything that must change before live mode, in one list:

```
0xPOOL_TSLA 0xPOOL_AAPL 0xPOOL_NVDA 0xPOOL_MSFT 0xPOOL_AMZN   config.ts
PROXY_SOURCE_URL_*                                             config.ts
REPLACE.WITH.PATH                                              config.ts
X402_NETWORK_PLACEHOLDER X402_PAY_TO_PLACEHOLDER               config.ts (only for x402)
ANCHOR_SOURCE_URL_PLACEHOLDER                                  config.ts (future automation)
FLETCH_CHAIN_ID FLETCH_RPC_URL FLETCH_EXPLORER_URL             .env
FLETCH_COMMITS_ADDRESS                                         .env (after step 7)
DATABASE_URL PUBLISHER_PRIVATE_KEY DEPLOYER_PRIVATE_KEY        .env (secrets)
PUBLISHER_ADDRESS ADMIN_TOKEN                                  .env
NEXT_PUBLIC_API_URL NEXT_PUBLIC_EXPLORER_URL                   vercel env
```

`assertConfigReady()` refuses to boot live mode while chain facts or pool
placeholders remain, so a missed value fails loudly at startup instead of
publishing garbage.

## the fine print

informational feed. not for use in liquidations, settlement, or as sole
pricing source. no warranty.

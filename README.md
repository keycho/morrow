# morrow

```
>>--->  morrow
```

what stocks are worth when the market is closed.

when nyse and nasdaq are closed, morrow publishes a fair value estimate per
tracked stock token with a confidence band, and commits merkle roots of all
observations on-chain so every published price is later verifiable. a
morrower makes arrows.

this is a port of an architecture previously run in production on solana
(600s commit cycles, merkle roots, twap anchoring), replicated on evm.

## architecture

```
apps/indexer      railway worker. polls pools + proxy sources, persists raw
                  observations, runs the engine every cycle, publishes commits.
apps/api          fastify. prices, history, commits, merkle proofs, accuracy,
                  health. free tier, api-key tier, x402 skeleton.
apps/web          next.js 14 dashboard. terminal aesthetic.
packages/engine   pure fair value math + merkle tree. fully unit tested.
packages/contracts MorrowCommits.sol + foundry deploy script.
packages/mcp      mcp server exposing the feed to agents. npm publishable.
packages/config   config.ts, the single source of every tunable.
supabase/         numbered sql migrations.
```

## data flow

```
pools (uniswap v3) ---\
                       >---> indexer ---> supabase ---> api ---> web / mcp
proxy sources (24/7) -/         |
                                v
                        engine (fair value)
                                |
                                v
                    merkle root ---> MorrowCommits (robinhood chain)
```

## quickstart

1. read SETUP.md. it lists every placeholder you must fill before first run.
2. `pnpm install`
3. apply migrations in supabase (see SETUP.md step 3).
4. `MOCK_MODE=true pnpm dev:indexer` runs the full pipeline on synthetic data.
5. `pnpm dev:api` then `pnpm dev:web`.

## the fine print

informational feed. not for use in liquidations, settlement, or as sole
pricing source. no warranty.

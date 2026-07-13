# rhscan indexer

the indexer and database layer for a robinhood chain block explorer. a single
long-running process that fills a postgres database with chain data fast and
keeps it at the head. no frontend, that gets built on top of this.

## chain facts

- robinhood chain mainnet, arbitrum orbit l2, evm equivalent
- chain id 4663, native currency eth
- public rpc `https://rpc.mainnet.chain.robinhood.com` (rate limited, not for backfill)
- transactions carry an l1 data fee; blocks and receipts carry `l1BlockNumber`,
  `gasUsedForL1`, `effectiveGasPrice`, which are preserved end to end.

## rpc probe results (day 1)

checked against the public rpc before writing the workers:

1. `eth_getBlockReceipts` is **supported** and returns the l2 fields, so the
   backfill uses one receipts call per block. no per-tx receipt fallback needed.
2. head was around block **8,896,833** at check time, so the backfill is roughly
   8.9m blocks / 44.5k ranges of 200.
3. `trace_block` and `debug_traceBlockByNumber` are **not available** (`-32601`).
   internal-transaction indexing is therefore not possible on this rpc and is
   left out of scope entirely.
4. multicall3 is **deployed** at the canonical
   `0xcA11bde05977b3631167028862bE2a173976CA11`, so token metadata uses it.

## how it works

- **schema** (`migrations/0001_init.sql`) is denormalized for read speed on the
  four explorer pages. `block_timestamp` is copied onto every child row so tx and
  token lists never join blocks, and `address_transactions` holds one row per
  (tx, participant) so the address page is a single index range read instead of
  an or across from/to.
- **backfill** (`src/backfill.ts`) is a work queue, not a for loop. genesis..head
  is chunked into `backfill_ranges` once; `CONCURRENCY` workers each claim a
  pending range with `for update ... skip locked` (safe in parallel and across
  processes), fetch blocks and receipts through viem's batched transport, and
  write the whole range in one transaction of chunked `on conflict do nothing`
  inserts. failed ranges are requeued with backoff, killed after 5 attempts,
  never the process. progress (ranges, blocks/s, eta) prints on an interval.
- **tail** (`src/tail.ts`) polls the head, processes catch-up blocks in batches,
  and handles reorgs: before writing a block it checks parent_hash against the
  stored hash, and on mismatch walks back to the last matching block, deletes
  every row above it across all tables, rewinds `sync_state`, and resumes.
- **tokens** (`src/tokens.ts`) resolves name/symbol/decimals/totalSupply for
  unknown tokens via multicall3, writing a null-filled row for tokens that do not
  implement the metadata methods so they are never retried.

backfill and tail write the same tables and are safe to run at once; every insert
is idempotent.

## running

```
pnpm install          # from the repo root
cp apps/rhscan/.env.example apps/rhscan/.env   # then fill in DATABASE_URL and RPC_URL

# from apps/rhscan (or: pnpm --filter @fletch/rhscan <script> from the root)
pnpm dev              # runs migrations, then MODE=both (backfill + tail + tokens)
pnpm migrate          # apply migrations only
pnpm backfill         # MODE=backfill
pnpm tail             # MODE=tail
```

`pnpm dev` runs migrations first (the process migrates itself on boot too), then
starts in `both` mode.

## deploy

deploy target is railway, database is supabase postgres. a single long-running
process. set `DATABASE_URL`, `RPC_URL`, and `MODE` (default `both`). the start
command is `pnpm --filter @fletch/rhscan start`, which migrates then runs.

## env vars

see `.env.example` for the full list. the important ones:

| var | default | purpose |
| --- | --- | --- |
| `DATABASE_URL` | (required) | supabase postgres connection string |
| `RPC_URL` | public rpc | paid provider rpc for backfill |
| `MODE` | `both` | `backfill` \| `tail` \| `both` \| `tokens` |
| `RANGE_SIZE` | `200` | blocks per backfill range |
| `CONCURRENCY` | `50` | parallel backfill workers |
| `POLL_MS` | `1000` | tail head poll interval |
| `TAIL_BATCH` | `100` | max blocks per tail poll |
| `BATCH_WAIT` | `20` | ms before flushing a json-rpc batch |
| `BATCH_SIZE` | `100` | max requests per json-rpc batch |

# rhscan indexer

the indexer and database layer for a robinhood chain block explorer. a single
long-running process that keeps a rolling recent window of chain data in
postgres, and a resolver library the frontend calls for anything older.

## chain facts

- robinhood chain mainnet, arbitrum orbit l2, evm equivalent
- chain id 4663, native currency eth
- public rpc `https://rpc.mainnet.chain.robinhood.com` (rate limited, not for backfill)
- transactions carry an l1 data fee; blocks and receipts carry `l1BlockNumber`,
  `gasUsedForL1`, `effectiveGasPrice`, preserved end to end.

## the windowed model (read this)

we do not index full history, ever. the explorer indexes a rolling recent window
(`WINDOW_DAYS`) and falls back to live rpc for anything older. this is a
deliberate product decision, built for, not worked around.

- **backfill** seeds work only from the window floor (the lowest block within
  `WINDOW_DAYS` of now, found by binary search) up to head, and claims ranges
  newest-first so the explorer is useful within minutes.
- **tail** follows the head with reorg handling.
- **pruner** rolls the window forward by dropping whole partitions once they fall
  below the floor (see partitioning below).
- **resolver** (`src/resolve.ts`) is a library, not a worker. it reads postgres
  first, falls back to live rpc, and caches rpc results in separate `cold_*`
  tables so repeat lookups are fast and the pruner never touches them.
- **holders** hydrate token balances on demand (see tokens and holders below).

two watermarks are published to `sync_state` for the frontend:

- `window_floor` the lowest block the window covers (tell users what is indexed)
- `backfill_floor` the contiguous-from-head watermark: the lowest block above
  which every range is done. **this is the number the ui should trust** as
  "fully indexed from here up", not the window floor.

## the shape of the chain (measured, day 3)

the earlier 520 GB / 46 GB/day estimate rested on a sample near the head. a
200-block sample spread evenly across the chain's whole life (`pnpm sample`)
tells a different story. block time is sub-second and the 1-second timestamp
resolution only resolves it across a wide block span, so block time is measured
per decile from the decile's endpoints.

| decile | dates | txns/blk | logs/blk | bytes/blk | blk_s | GB/day |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 04-30..07-01 | 2.2 | 2.4 | 5.6k | 5.85 | 0.1 |
| 2 | 07-02..07-03 | 2.9 | 5.3 | 8.8k | 0.15 | 5.4 |
| 3 | 07-03..07-05 | 2.9 | 3.5 | 7.7k | 0.20 | 3.4 |
| 4 | 07-05..07-07 | 2.3 | 3.7 | 6.7k | 0.19 | 3.2 |
| 5 | 07-07..07-09 | 7.8 | 16.4 | 25.5k | 0.10 | 22.5 |
| 6 | 07-09..07-10 | 9.9 | 19.1 | 31.1k | 0.10 | 27.4 |
| 7 | 07-10..07-11 | 14.4 | 78.8 | 80.5k | 0.10 | 71.1 |
| 8 | 07-11..07-12 | 10.0 | 39.0 | 45.1k | 0.10 | 39.8 |
| 9 | 07-12..07-13 | 9.2 | 31.6 | 37.7k | 0.10 | 33.3 |
| 10 | 07-13..07-14 | 7.2 | 25.9 | 30.4k | 0.10 | 26.8 |

what this changes:

- **the 46 GB/day figure does not survive.** the head (decile 10) is ~27 GB/day,
  and the rate is volatile: it ranged 0.1 to 71 GB/day over the chain's life and
  spiked to 71 around 07-10. the head is not the peak, decile 7 was.
- block time is **~0.10 s since early july** (10 blocks/sec), ~0.67 s lifetime.
  that is a genuinely busy chain: 7-14 txns/block at 10 blocks/sec is ~70-140
  tps sustained for over a week, not a one-afternoon artifact.
- the whole chain (9.6M blocks) is about **270 GB**, not 520. head-density
  extrapolation overcounted.

sizing at the recent rate (~27-40 GB/day):

| target | window |
| --- | --- |
| ~50 GB  | ~1.5 days |
| ~100 GB | ~3 days |
| ~150 GB | ~4-5 days |

**recommended default `WINDOW_DAYS=7`** (~200-280 GB, within the decile-7 spike),
which the `.env.example` now uses. if 150 GB is a hard ceiling, use ~4 days, but
the pruner refuses under 7 as a safety floor, so to go lower either relax that
floor or switch the knob to hours. with partition-drop pruning there is no bloat,
so on-disk size is just window content plus a partition of slack.

**backfill wall-clock** is rpc-bound (2 batched calls/block). at a sustained S
req/s, blocks/s is S/2: a 7-day window (~6M blocks) is ~1.7 h at 1000 req/s,
~33 min at 3000, ~17 min at 6000.

## partitioning

the window tables (`blocks`, `transactions`, `logs`, `token_transfers`,
`address_transactions`) are `partition by range (block_number)` in
`PARTITION_SIZE` chunks (default 500,000). the partition maintainer creates
partitions ahead of the head so the tail never writes into a missing range, and
the pruner drops whole partitions below the floor: instant, disk straight back to
the os, zero vacuum work. delete-based pruning is gone.

partitioning breaks two things, both solved:

1. a unique key on a partitioned table must include the partition key, so
   `transactions` cannot key on `hash` and `blocks` cannot be found by hash
   without scanning every partition. `tx_locations` and `block_locations` are
   tiny unpartitioned `hash -> block_number` maps written in the same
   transaction, so a hash lookup is one small hit then a partition-pruned read.
   confirmed with `explain`: a block-range query and a tx-hash lookup each scan a
   single partition.
2. the cold cache must outlive the window, so it lives in unpartitioned `cold_*`
   tables, never dropped by the pruner.

## tokens and holders

with a window measured in days, a token's transfer history predates the window,
so holders cannot come from indexed transfers. instead each token is hydrated on
demand (`src/holders.ts`): pull that one token's whole `Transfer` history via
chunked `eth_getLogs` (starting at its known deployment block when we have it,
shrinking the chunk on the provider's 10000-log cap), replay to a balance set,
and store it in `token_balances`. hydration is triggered lazily on first request
and eagerly for the top `EAGER_TOP_N` tokens by windowed transfer count; a page
never blocks on it and returns a `hydrating` flag.

after hydration, balances are maintained incrementally from windowed transfers.
**the incremental path applies deltas only for transfer rows actually inserted**
(`insert ... on conflict do nothing returning *`), never from the input array, so
a retried backfill range applies nothing (all conflicts, nothing returned) and a
balance is never double-counted. the zero address is stored as a real row (mint
and burn) and excluded from holder counts and top-holder lists at read time.

`token_stats` (holder_count, transfer_count, first_transfer_block, deployer, its
balance share, top10 share) is refreshed periodically. the new-token feed and
"what else did this deployer launch" come from `contracts` (a deployment is a tx
with no `to` whose receipt carried a `contract_address`). facts only, no scoring.

`pnpm verify:balances` proves the replay: for N tokens it compares the top holder
balances against live `balanceOf` via multicall3, at the hydrated block so an
actively-traded token's real-time movement is not mistaken for drift.

## cold-path resolver

`src/resolve.ts` exports `resolveTx`, `resolveBlock`, `resolveAddress` and a
`resolveQuery` dispatcher. every result carries `source: 'indexed' | 'rpc'` for
debugging (the ui does not show it). a hash lookup checks the window map, then the
cold cache, then live rpc, caching the whole containing block into `cold_*`. an
address returns live header data (balance, nonce, code) plus a windowed
transaction list from the index, always with `historyTruncated: true` and the
window floor, because an address's full history cannot be reconstructed from rpc.

## rpc probe results (day 1)

1. `eth_getBlockReceipts` supported and returns the l2 fields.
2. head around 9.6M at measurement.
3. `trace_block` / `debug_traceBlockByNumber` not available (`-32601`), so
   internal-transaction indexing is out of scope.
4. multicall3 deployed at the canonical `0xcA11...CA11`, used by token metadata.

## deploy

railway, single long-running process; database is supabase postgres. set
`DATABASE_URL`, `RPC_URL`, `WINDOW_DAYS`, and `MODE` (default `both`). start
command `pnpm --filter @fletch/rhscan start`. build indexes once with
`pnpm --filter @fletch/rhscan indexes:create` after the first backfill catches up.

## env vars

see `.env.example` for the full list. the important ones:

| var | default | purpose |
| --- | --- | --- |
| `DATABASE_URL` | (required) | supabase postgres connection string |
| `RPC_URL` | public rpc | paid provider rpc for backfill |
| `MODE` | `both` | `backfill` \| `tail` \| `both` \| `tokens` \| `prune` |
| `WINDOW_DAYS` | `90` | days of recent history to index (see sizing note) |
| `PRUNE_INTERVAL_HOURS` | `24` | how often the window rolls forward |
| `RANGE_SIZE` | `200` | blocks per backfill range |
| `CONCURRENCY` | `50` | parallel backfill workers |
| `POLL_MS` | `1000` | tail head poll interval |
| `TAIL_BATCH` | `100` | max blocks per tail poll |

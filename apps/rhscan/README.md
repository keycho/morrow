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
- **pruner** rolls the window forward on a schedule, deleting everything below
  the recomputed floor so disk stays steady-state.
- **resolver** (`src/resolve.ts`) is a library, not a worker. it reads postgres
  first, falls back to live rpc, and caches rpc results back into the same tables
  marked `cold` so the pruner leaves them and repeat lookups are fast.

two watermarks are published to `sync_state` for the frontend:

- `window_floor` the lowest block the window covers (tell users what is indexed)
- `backfill_floor` the contiguous-from-head watermark: the lowest block above
  which every range is done. **this is the number the ui should trust** as
  "fully indexed from here up", not the window floor.

## the numbers (measured on a 1500-block recent sample)

storage was measured, not guessed: rows written and `pg_total_relation_size`
(heap plus read indexes) per table, divided by blocks.

- **~54 KB per block**, ~106 rows per block, over recent (busy) blocks.
  per block: 11.3 txns, 47.5 logs, 23.2 token transfers, 22.6 address rows.
- the chain launched 2026-04-30 and was ~75 days old at measurement, so **a
  90-day window today is essentially the whole chain, about 9.6M blocks, roughly
  520 GB** with read indexes.
- recent block time is about **0.10 s/block**, so the chain produces roughly
  **860k blocks/day, about 46 GB/day**. once the chain is older than 90 days, a
  steady-state 90-day window would be about 77M blocks, **roughly 4.2 TB**.

**recommendation: 90 days is far over the 150 GB ceiling, drop it hard.** at the
current cadence:

| target | window | blocks |
| --- | --- | --- |
| ~50 GB  | ~1 day  | ~0.9M |
| ~100 GB | ~2 days | ~1.9M |
| ~150 GB | ~3 days | ~2.8M |

one caveat to decide on: the pruner refuses `WINDOW_DAYS` under 7 as a safety
floor, but 7 days is already ~326 GB at this cadence. to land under 150 GB you
either lower that guard and pass a fractional value like `WINDOW_DAYS=3`, or we
switch the window knob to hours. say which and it is a small change. block rate
this high may also be a burst; if it settles, GB/day drops proportionally.

**backfill wall-clock** is bound by rpc throughput (2 calls per block:
`eth_getBlockByNumber` plus `eth_getBlockReceipts`, both batched). i could not
measure a paid provider from here (the public endpoint rate-limits), so, at a
sustained requests/sec S, blocks/sec is S/2:

| provider throughput | 3-day window (2.8M blk) | whole chain (9.6M blk) |
| --- | --- | --- |
| 1000 req/s | ~1.5 h | ~5.3 h |
| 3000 req/s | ~31 min | ~1.8 h |
| 6000 req/s | ~15 min | ~53 min |

## load sequence

read-path indexes are built separately with `create index concurrently` so the
write-bound bulk backfill is not slowed by index maintenance. `0001_init.sql`
holds only tables, primary keys and operational indexes.

```
pnpm install                                   # from the repo root
cp apps/rhscan/.env.example apps/rhscan/.env    # fill DATABASE_URL, RPC_URL, WINDOW_DAYS

# from apps/rhscan (or pnpm --filter @fletch/rhscan <script> from the root)
pnpm migrate           # create tables (no read indexes yet)
pnpm backfill          # seed the window and fill it, newest-first
pnpm indexes:create    # build read indexes concurrently once caught up
pnpm dev               # MODE=both: backfill + tail + tokens + prune

pnpm indexes:drop      # before a fresh bulk reload, to keep it write-bound
```

`pnpm dev` runs migrations first (the process also migrates itself on boot),
then starts in `both` mode. read indexes persist across runs; you only build
them once.

## pruning and disk

the pruner deletes below the window floor in block-number batches inside
transactions (never one giant delete, never locks the tail out), and runs
`vacuum` (not `full`) after each batch group. postgres does not return the freed
disk to the os, it reuses it for new rows, which is exactly right for a
steady-state window: the on-disk size plateaus rather than growing. `tokens` and
`contracts` are never pruned (small, keyed by address, useful forever). cold
rows (rpc lookups cached back in) are never pruned.

## cold-path resolver

`src/resolve.ts` exports `resolveTx`, `resolveBlock`, `resolveAddress` and a
`resolveQuery` dispatcher. every result carries `source: 'indexed' | 'rpc'` for
debugging (the ui does not show it). tx and block fall back to rpc and cache the
whole containing block cold. an address returns live header data (balance, nonce,
code) plus a windowed transaction list from the index, always with
`historyTruncated: true` and the window floor, because an address's full history
cannot be reconstructed from rpc without an indexer.

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

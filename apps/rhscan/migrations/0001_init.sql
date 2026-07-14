-- rhscan schema: tables, primary keys and operational indexes only.
--
-- read-path indexes live in migrations/read_indexes.sql and are built with
-- create index concurrently by `pnpm indexes:create` after the bulk window
-- backfill, so the write-bound backfill runs without index maintenance. see the
-- readme for the load sequence.
--
-- the explorer indexes only a rolling recent window (see WINDOW_DAYS) and falls
-- back to live rpc for older data. rpc-fetched rows are cached back into these
-- same tables with cold = true so the pruner leaves them in place.
--
-- conventions:
--   hashes and addresses are text, lowercase, 0x-prefixed, everywhere.
--   raw calldata and log data are bytea.
--   wei amounts are numeric(78,0) (uint256 fits in 78 digits).
--   gas units, block numbers, nonces are bigint.

-- ---------------------------------------------------------------------------
-- blocks
-- ---------------------------------------------------------------------------
create table if not exists blocks (
  number            bigint       primary key,
  hash              text         not null,
  parent_hash       text         not null,
  timestamp         timestamptz  not null,
  miner             text         not null,
  gas_used          bigint       not null,
  gas_limit         bigint       not null,
  base_fee_per_gas  numeric(78,0),
  tx_count          integer      not null,
  size              bigint,
  l1_block_number   bigint,
  cold              boolean      not null default false
);

-- ---------------------------------------------------------------------------
-- transactions
--   block_timestamp is denormalized so tx lists never join blocks.
--   method_id is a generated column: the first 4 bytes of calldata, the
--   function selector rendered as "Transfer" style labels later.
-- ---------------------------------------------------------------------------
create table if not exists transactions (
  hash                     text         primary key,
  block_number             bigint       not null,
  block_timestamp          timestamptz  not null,
  tx_index                 integer      not null,
  from_address             text         not null,
  to_address               text,
  value                    numeric(78,0) not null,
  gas_limit                bigint,
  gas_used                 bigint,
  effective_gas_price      numeric(78,0),
  gas_used_for_l1          bigint,
  max_fee_per_gas          numeric(78,0),
  max_priority_fee_per_gas numeric(78,0),
  nonce                    bigint,
  input                    bytea,
  method_id                bytea generated always as (substring(input from 1 for 4)) stored,
  tx_type                  integer,
  status                   integer,
  contract_address         text,
  cold                     boolean      not null default false
);

-- ---------------------------------------------------------------------------
-- logs
-- ---------------------------------------------------------------------------
create table if not exists logs (
  block_number     bigint       not null,
  log_index        integer      not null,
  tx_hash          text         not null,
  block_timestamp  timestamptz  not null,
  address          text         not null,
  topic0           text,
  topic1           text,
  topic2           text,
  topic3           text,
  data             bytea,
  cold             boolean      not null default false,
  primary key (block_number, log_index)
);

-- ---------------------------------------------------------------------------
-- token_transfers
--   decoded erc-20 and erc-721 Transfer events. value is null for erc-721,
--   token_id is null for erc-20. one row per Transfer log.
-- ---------------------------------------------------------------------------
create table if not exists token_transfers (
  block_number     bigint        not null,
  log_index        integer       not null,
  tx_hash          text          not null,
  block_timestamp  timestamptz   not null,
  token_address    text          not null,
  from_address     text          not null,
  to_address       text          not null,
  value            numeric(78,0),
  token_id         numeric(78,0),
  token_type       text          not null,
  cold             boolean       not null default false,
  primary key (block_number, log_index)
);

-- ---------------------------------------------------------------------------
-- address_transactions
--   one row per (tx, participant). turns the address page into one index range
--   read instead of an or scan across from/to.
-- ---------------------------------------------------------------------------
create table if not exists address_transactions (
  address       text     not null,
  block_number  bigint   not null,
  tx_index      integer  not null,
  tx_hash       text     not null,
  direction     text     not null,
  cold          boolean  not null default false,
  primary key (address, block_number, tx_index, direction)
);

-- ---------------------------------------------------------------------------
-- tokens (metadata, keyed by address, never pruned)
-- ---------------------------------------------------------------------------
create table if not exists tokens (
  address       text     primary key,
  name          text,
  symbol        text,
  decimals      integer,
  token_type    text,
  total_supply  numeric(78,0)
);

-- ---------------------------------------------------------------------------
-- contracts (creation metadata, keyed by address, never pruned)
-- ---------------------------------------------------------------------------
create table if not exists contracts (
  address        text     primary key,
  creator        text,
  creation_tx    text,
  creation_block bigint,
  bytecode_hash  text
);

-- ---------------------------------------------------------------------------
-- sync_state
--   one row per worker. also holds published scalars the frontend reads:
--   worker='tail'           highest block the tail has committed
--   worker='window_floor'   lowest block the window currently covers
--   worker='backfill_floor' contiguous-from-head watermark (trust this in ui)
-- ---------------------------------------------------------------------------
create table if not exists sync_state (
  worker             text        primary key,
  last_indexed_block bigint      not null,
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- backfill_ranges (the work queue)
-- ---------------------------------------------------------------------------
create table if not exists backfill_ranges (
  id          bigserial   primary key,
  from_block  bigint      not null,
  to_block    bigint      not null,
  status      text        not null default 'pending',
  claimed_at  timestamptz,
  attempts    integer     not null default 0,
  unique (from_block)
);

-- operational index for claim (kept here, not a read-path index): claim scans
-- only pending rows, in from_block order (forward or reverse).
create index if not exists backfill_ranges_pending_idx
  on backfill_ranges (from_block) where status = 'pending';

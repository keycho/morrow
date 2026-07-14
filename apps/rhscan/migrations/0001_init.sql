-- rhscan schema: range-partitioned window tables, unpartitioned lookup and cold
-- tables, and metadata.
--
-- the window tables are partitioned by range (block_number) in PARTITION_SIZE
-- chunks. the pruner drops whole partitions once they fall below the window
-- floor: instant, reclaims disk to the os immediately, zero vacuum work. this
-- replaces day-2's delete-based pruning entirely.
--
-- two consequences of partitioning, both solved here:
--   1. a unique key on a partitioned table must include the partition key, so
--      transactions cannot key on hash alone and blocks cannot be found by hash
--      without scanning every partition. tx_locations and block_locations are
--      tiny unpartitioned hash -> block_number maps, written in the same
--      transaction as the row, so a hash lookup is one small hit then a
--      partition-pruned read.
--   2. the cold cache (rpc lookups below the window) must outlive the window, so
--      it lives in separate unpartitioned cold_* tables, never dropped by the
--      pruner.
--
-- conventions: hashes and addresses are lowercase 0x text; wei is numeric(78,0);
-- calldata and log data are bytea; gas, block numbers, nonces are bigint.
-- read-path indexes are defined on the partitioned parents, so every partition
-- (created empty, ahead of the head) inherits them instantly.

-- ===========================================================================
-- partitioned window tables
-- ===========================================================================

create table if not exists blocks (
  number            bigint       not null,
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
  primary key (number)
) partition by range (number);

create index if not exists blocks_timestamp_desc_idx on blocks (timestamp desc);

create table if not exists transactions (
  hash                     text          not null,
  block_number             bigint        not null,
  block_timestamp          timestamptz   not null,
  tx_index                 integer       not null,
  from_address             text          not null,
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
  primary key (block_number, tx_index)
) partition by range (block_number);

create index if not exists transactions_block_idx
  on transactions (block_number desc, tx_index desc);
create index if not exists transactions_from_idx
  on transactions (from_address, block_number desc);

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
  primary key (block_number, log_index)
) partition by range (block_number);

create index if not exists logs_address_idx on logs (address, block_number desc);
create index if not exists logs_tx_hash_idx on logs (tx_hash);

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
  primary key (block_number, log_index)
) partition by range (block_number);

create index if not exists token_transfers_token_idx
  on token_transfers (token_address, block_number desc);
create index if not exists token_transfers_from_idx on token_transfers (from_address);
create index if not exists token_transfers_to_idx on token_transfers (to_address);
create index if not exists token_transfers_tx_idx on token_transfers (tx_hash);

create table if not exists address_transactions (
  address       text     not null,
  block_number  bigint   not null,
  tx_index      integer  not null,
  tx_hash       text     not null,
  direction     text     not null,
  primary key (address, block_number, tx_index, direction)
) partition by range (block_number);

create index if not exists address_transactions_addr_idx
  on address_transactions (address, block_number desc, tx_index desc);

-- ===========================================================================
-- unpartitioned hash -> block_number lookup maps (written with the row)
-- ===========================================================================

create table if not exists tx_locations (
  hash         text   primary key,
  block_number bigint not null
);

create table if not exists block_locations (
  hash         text   primary key,
  block_number bigint not null
);

-- ===========================================================================
-- unpartitioned cold cache (rpc lookups below the window; never pruned)
-- ===========================================================================

create table if not exists cold_blocks (
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
  l1_block_number   bigint
);
create unique index if not exists cold_blocks_hash_idx on cold_blocks (hash);

create table if not exists cold_transactions (
  hash                     text          primary key,
  block_number             bigint        not null,
  block_timestamp          timestamptz   not null,
  tx_index                 integer       not null,
  from_address             text          not null,
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
  contract_address         text
);
create index if not exists cold_transactions_block_idx on cold_transactions (block_number);

create table if not exists cold_logs (
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
  primary key (block_number, log_index)
);
create index if not exists cold_logs_tx_idx on cold_logs (tx_hash);

create table if not exists cold_token_transfers (
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
  primary key (block_number, log_index)
);
create index if not exists cold_token_transfers_tx_idx on cold_token_transfers (tx_hash);

create table if not exists cold_address_transactions (
  address       text     not null,
  block_number  bigint   not null,
  tx_index      integer  not null,
  tx_hash       text     not null,
  direction     text     not null,
  primary key (address, block_number, tx_index, direction)
);
create index if not exists cold_address_transactions_addr_idx
  on cold_address_transactions (address);

-- ===========================================================================
-- metadata (unpartitioned, keyed by address, never pruned)
-- ===========================================================================

-- metadata only. hydration state (including hydrated_at_block) lives in
-- token_hydration, so a bare tokens row never blocks the metadata worker.
create table if not exists tokens (
  address       text     primary key,
  name          text,
  symbol        text,
  decimals      integer,
  token_type    text,
  total_supply  numeric(78,0)
);

create table if not exists contracts (
  address        text     primary key,
  creator        text,
  creation_tx    text,
  creation_block bigint,
  bytecode_hash  text
);
create index if not exists contracts_creator_idx on contracts (creator);
create index if not exists contracts_creation_block_idx on contracts (creation_block desc);

-- ===========================================================================
-- worker state
-- ===========================================================================

create table if not exists sync_state (
  worker             text        primary key,
  last_indexed_block bigint      not null,
  updated_at         timestamptz not null default now()
);

create table if not exists backfill_ranges (
  id          bigserial   primary key,
  from_block  bigint      not null,
  to_block    bigint      not null,
  status      text        not null default 'pending',
  claimed_at  timestamptz,
  attempts    integer     not null default 0,
  unique (from_block)
);

create index if not exists backfill_ranges_pending_idx
  on backfill_ranges (from_block) where status = 'pending';

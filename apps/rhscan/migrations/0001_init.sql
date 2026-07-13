-- rhscan initial schema.
--
-- design goal: the four explorer pages (home, block, tx, address) never scan
-- and never join on the read path. we denormalize block_timestamp onto every
-- child row so tx and token lists sort by time without touching blocks, and we
-- keep a dedicated address_transactions table so the address page is a single
-- index range read instead of an or across from/to.
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
  l1_block_number   bigint
);

-- home page: latest blocks first.
create index if not exists blocks_timestamp_desc_idx on blocks (timestamp desc);

-- ---------------------------------------------------------------------------
-- transactions
--   block_timestamp is denormalized so tx lists never join blocks.
--   method_id is a generated column: the first 4 bytes of calldata, which is
--   the function selector we render as "Transfer" style labels later.
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
  contract_address         text
);

-- block page: txs of a block, and home page: latest txs across all blocks.
create index if not exists transactions_block_idx
  on transactions (block_number desc, tx_index desc);
-- address page (sender side). the address_transactions table covers both
-- directions, but a direct from_address index keeps sender-only queries cheap.
create index if not exists transactions_from_idx
  on transactions (from_address, block_number desc);

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
  primary key (block_number, log_index)
);

-- address page: logs emitted by a contract, newest first.
create index if not exists logs_address_idx on logs (address, block_number desc);

-- ---------------------------------------------------------------------------
-- token_transfers
--   decoded erc-20 and erc-721 Transfer events. value is null for erc-721,
--   token_id is null for erc-20. one row per Transfer log, so it shares the
--   log's (block_number, log_index) identity.
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
  primary key (block_number, log_index)
);

-- token page: transfers of a token, newest first.
create index if not exists token_transfers_token_idx
  on token_transfers (token_address, block_number desc);
-- address page: token movements in and out of an address.
create index if not exists token_transfers_from_idx on token_transfers (from_address);
create index if not exists token_transfers_to_idx on token_transfers (to_address);

-- ---------------------------------------------------------------------------
-- address_transactions
--   one row per (tx, participant). turns the address page from an or scan
--   across from/to into one index range read. both sides inserted per tx.
-- ---------------------------------------------------------------------------
create table if not exists address_transactions (
  address       text     not null,
  block_number  bigint   not null,
  tx_index      integer  not null,
  tx_hash       text     not null,
  direction     text     not null,
  primary key (address, block_number, tx_index, direction)
);

create index if not exists address_transactions_addr_idx
  on address_transactions (address, block_number desc, tx_index desc);

-- ---------------------------------------------------------------------------
-- tokens
--   populated lazily by the metadata worker. a row with null name/symbol means
--   we tried and the token does not implement the metadata methods; its
--   presence stops us from retrying it forever.
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
-- contracts
--   creation metadata only. source verification is proxied from blockscout
--   later and is out of scope here.
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
--   one row per worker. tail advances last_indexed_block only after a block's
--   rows are committed.
-- ---------------------------------------------------------------------------
create table if not exists sync_state (
  worker             text        primary key,
  last_indexed_block bigint      not null,
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- backfill_ranges
--   the work queue. workers claim a pending range with
--   for update skip locked, which makes parallel and multi-process claims safe.
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

-- claim scans only pending rows in from_block order.
create index if not exists backfill_ranges_pending_idx
  on backfill_ranges (from_block) where status = 'pending';

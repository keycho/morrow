-- token holders, hydration state and stats.
--
-- with a window measured in days, almost every token's transfer history predates
-- the window, so holders cannot be derived from indexed transfers. instead each
-- token is hydrated on demand: we pull that one token's whole Transfer history
-- via eth_getLogs and replay it into token_balances, then maintain it
-- incrementally from windowed transfers. all of these tables are unpartitioned
-- and never pruned; they are keyed by address, not block.

create table if not exists token_balances (
  token_address      text          not null,
  holder_address     text          not null,
  balance            numeric(78,0)  not null default 0,
  last_updated_block bigint,
  primary key (token_address, holder_address)
);

-- top holders of a token, and holdings of an address.
create index if not exists token_balances_top_idx
  on token_balances (token_address, balance desc);
create index if not exists token_balances_holder_idx
  on token_balances (holder_address);

-- hydration queue and state. status: pending -> hydrating -> done | failed.
create table if not exists token_hydration (
  token_address     text         primary key,
  status            text         not null default 'pending',
  requested_at      timestamptz  not null default now(),
  started_at        timestamptz,
  done_at           timestamptz,
  hydrated_at_block bigint,
  transfer_count    bigint,
  error             text
);

create index if not exists token_hydration_pending_idx
  on token_hydration (requested_at) where status = 'pending';

-- refreshed by a periodic job. age is derived at read time from
-- first_transfer_block, so it is not stored.
create table if not exists token_stats (
  token_address         text          primary key,
  holder_count          bigint        not null default 0,
  transfer_count        bigint        not null default 0,
  first_transfer_block  bigint,
  deployer_address      text,
  deployer_balance_share numeric,
  top10_share           numeric,
  updated_at            timestamptz   not null default now()
);

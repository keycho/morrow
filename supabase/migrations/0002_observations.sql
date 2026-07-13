-- raw onchain observations, one row per token per indexer tick.
-- pool_spot is quote-per-stock-token. depth_quote_2pct is the approximate
-- quote-token liquidity within ±2% of spot. volume_delta is the cumulative
-- swap volume change since the previous tick (quote units, best effort).

create table if not exists observations (
  id              bigint generated always as identity primary key,
  token_id        integer not null references tokens (id),
  block_number    bigint not null,
  ts              timestamptz not null,
  pool_spot       numeric(24, 10) not null,
  depth_quote_2pct numeric(24, 4) not null default 0,
  volume_delta    numeric(24, 4) not null default 0,
  source          text not null default 'pool',  -- 'pool' or 'mock'
  created_at      timestamptz not null default now()
);

create index if not exists observations_token_ts_idx
  on observations (token_id, ts desc);

create index if not exists observations_ts_idx
  on observations (ts desc);

alter table observations enable row level security;

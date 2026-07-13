-- 24/7 proxy signal ticks, one row per source per successful fetch.
-- value is the raw numeric price extracted from the source response.
-- stale marks a tick that was already older than the source staleness budget
-- when recorded (for example a source serving cached data).

create table if not exists proxy_ticks (
  id          bigint generated always as identity primary key,
  source      text not null,
  symbol      text not null,
  ts          timestamptz not null,
  value       numeric(24, 10) not null,
  stale       boolean not null default false,
  latency_ms  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists proxy_ticks_source_ts_idx
  on proxy_ticks (source, ts desc);

create index if not exists proxy_ticks_symbol_ts_idx
  on proxy_ticks (symbol, ts desc);

alter table proxy_ticks enable row level security;

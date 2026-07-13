-- pool discovery runs. one row per discovery run (weekly from the worker, or
-- manual). stores the full judged pool set and the per-token selection as
-- jsonb, so pool liquidity arriving on the chain over time becomes a dataset:
-- which venues and pools appear, at what depth, week by week. additive.

create table if not exists pool_discovery_runs (
  id         bigint generated always as identity primary key,
  run_at     timestamptz not null default now(),
  eth_usd    numeric(24, 6),
  num_pools  integer not null default 0,
  results    jsonb not null
);

create index if not exists pool_discovery_runs_run_at_idx on pool_discovery_runs (run_at desc);

alter table pool_discovery_runs enable row level security;

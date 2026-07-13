-- service heartbeats, one row per indexer tick and per publisher cycle.
-- downtime is detectable as a gap. /health reads the newest row per service
-- and flags staleness. detail carries per-source breaker and staleness state.

create table if not exists heartbeats (
  id         bigint generated always as identity primary key,
  service    text not null,          -- 'indexer' or 'publisher'
  ts         timestamptz not null default now(),
  ok         boolean not null default true,
  detail     jsonb not null default '{}'::jsonb
);

create index if not exists heartbeats_service_ts_idx
  on heartbeats (service, ts desc);

alter table heartbeats enable row level security;

-- keep the table small: heartbeats older than 14 days are garbage. a
-- scheduled job or manual vacuum can run this; the indexer also prunes
-- opportunistically once a day.

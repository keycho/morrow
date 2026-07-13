-- engine outputs, one row per token per cycle. this is what the api serves
-- and what gets hashed into merkle leaves. suspect rows are surfaced, never
-- hidden. regime is one of: market_open, after_hours, weekend, holiday.

create table if not exists fair_values (
  id           bigint generated always as identity primary key,
  token_id     integer not null references tokens (id),
  cycle_id     bigint not null,
  ts           timestamptz not null,
  fair_value   numeric(24, 10) not null,
  confidence   integer not null check (confidence between 0 and 100),
  band_low     numeric(24, 10) not null,
  band_high    numeric(24, 10) not null,
  regime       text not null check (regime in ('market_open', 'after_hours', 'weekend', 'holiday')),
  suspect      boolean not null default false,
  -- decomposition, kept for the dashboard and postmortems
  anchor_price numeric(24, 10),
  drift        numeric(12, 8),
  onchain_twap numeric(24, 10),
  onchain_spot numeric(24, 10),
  depth_quote  numeric(24, 4),
  created_at   timestamptz not null default now(),
  unique (token_id, cycle_id)
);

create index if not exists fair_values_token_cycle_idx
  on fair_values (token_id, cycle_id desc);

create index if not exists fair_values_token_ts_idx
  on fair_values (token_id, ts desc);

alter table fair_values enable row level security;

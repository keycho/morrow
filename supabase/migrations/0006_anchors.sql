-- official market prints per token. kind 'close' rows are the model anchor
-- (last official close). kind 'open' rows are the realized next-open prints
-- used by the accuracy endpoint. v1 is manual admin insert; the config flag
-- anchors.automatedSource reserves the automated path.

create table if not exists anchors (
  id         bigint generated always as identity primary key,
  token_id   integer not null references tokens (id),
  kind       text not null check (kind in ('close', 'open')),
  price      numeric(24, 10) not null,
  -- the official market timestamp of the print (16:00 et for closes,
  -- 09:30 et for opens), not the insert time.
  market_ts  timestamptz not null,
  source     text not null default 'manual',
  created_at timestamptz not null default now(),
  unique (token_id, kind, market_ts)
);

create index if not exists anchors_token_kind_ts_idx
  on anchors (token_id, kind, market_ts desc);

alter table anchors enable row level security;

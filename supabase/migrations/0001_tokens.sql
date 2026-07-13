-- tracked stock tokens. mirrors packages/config/config.ts tokens[]; the
-- indexer upserts this table from config on boot so the api and dashboard
-- can join on it. id is the stable numeric id used in merkle leaves.

create table if not exists tokens (
  id           integer primary key,
  symbol       text not null unique,
  name         text not null,
  pool_address text not null,
  base_decimals  integer not null default 18,
  quote_decimals integer not null default 6,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table tokens enable row level security;

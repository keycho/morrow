-- api keys for the keyed rate-limit tier. only the sha-256 hash of the key
-- is stored. the plaintext key is shown once at creation and never persisted.

create table if not exists keys (
  id         bigint generated always as identity primary key,
  key_hash   text not null unique,
  label      text not null,
  tier       text not null default 'keyed' check (tier in ('keyed')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

alter table keys enable row level security;

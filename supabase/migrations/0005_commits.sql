-- merkle commits, one row per cycle. leaves holds the full canonical leaf
-- set (ordered) so proofs can be rebuilt for any historical observation.
-- tx_hash is null until the onchain commit confirms, then backfilled.

create table if not exists commits (
  cycle_id          bigint primary key,
  merkle_root       text not null,
  observation_count integer not null,
  tx_hash           text,
  status            text not null default 'pending' check (status in ('pending', 'confirmed', 'failed')),
  -- ordered array of { tokenId, cycleId, fairValue, confidence, timestamp, leaf }
  leaves            jsonb not null,
  committed_at      timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists commits_created_idx
  on commits (created_at desc);

alter table commits enable row level security;

-- backtest results. morrow's core claim is that its off-hours number predicts
-- the next open better than "the stock opens where it closed". this table is
-- the evidence: one run per `pnpm backtest`, results accumulate as history
-- grows. additive and read-only to the live pipeline: the indexer, api, and
-- publisher never write here, so a backtest can never disturb the feed.
--
-- errors are stored as percent of the actual open (comparable across tokens).
-- a `scope` of 'pooled' is the all-token aggregate; otherwise it is a token
-- symbol. the three predictors are:
--   naive  -> predicted open = last close (the baseline morrow must beat)
--   drift  -> close plus reconstructed proxy drift, no onchain component
--   morrow -> the full model as configured

create table if not exists backtest_runs (
  id           bigint generated always as identity primary key,
  run_at       timestamptz not null default now(),
  source       text not null,          -- history source, e.g. 'yahoo-daily'
  method       text not null,          -- short reconstruction description
  history_from date,
  history_to   date,
  sessions     integer not null,       -- total session boundaries scored (pooled)
  notes        text
);

create table if not exists backtest_results (
  id                bigint generated always as identity primary key,
  run_id            bigint not null references backtest_runs (id) on delete cascade,
  scope             text not null,      -- token symbol, or 'pooled'
  predictor         text not null check (predictor in ('naive', 'drift', 'morrow')),
  n                 integer not null,
  mae_pct           numeric(12, 6) not null,   -- mean absolute error, percent
  median_ae_pct     numeric(12, 6) not null,
  rmse_pct          numeric(12, 6) not null,
  mean_error_pct    numeric(12, 6) not null,   -- signed, positive = predicts high
  worst_pct         numeric(12, 6) not null,   -- worst absolute error
  p50_abs_pct       numeric(12, 6) not null,
  p90_abs_pct       numeric(12, 6) not null,
  hit_rate          numeric(6, 4),             -- directional; null for naive
  win_rate_vs_naive numeric(6, 4),             -- fraction of sessions strictly beating naive; null for naive
  created_at        timestamptz not null default now(),
  unique (run_id, scope, predictor)
);

create index if not exists backtest_results_run_idx on backtest_results (run_id);
create index if not exists backtest_runs_run_at_idx on backtest_runs (run_at desc);

alter table backtest_runs enable row level security;
alter table backtest_results enable row level security;

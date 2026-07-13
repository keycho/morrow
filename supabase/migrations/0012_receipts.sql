-- weekly accuracy receipts. one row per reported week (the monday of the
-- just-completed mon-fri). stores the markdown summary, the svg source, an
-- optional rasterized png (base64), and a structured summary. generated only,
-- never auto-posted.

create table if not exists receipts (
  week_start   date primary key,
  week_end     date not null,
  generated_at timestamptz not null default now(),
  markdown     text not null,
  svg          text not null,
  png_base64   text,
  summary      jsonb not null
);

create index if not exists receipts_generated_idx on receipts (generated_at desc);

alter table receipts enable row level security;

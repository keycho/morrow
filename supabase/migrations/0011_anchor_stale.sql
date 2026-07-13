-- stale anchor flag on fair value cycles. additive only.
--
-- set when the model anchor was older than the most recent official close (an
-- expected close print was missed). the engine keeps producing a number but
-- caps confidence and widens the band; this column records that it did so.

alter table fair_values
  add column if not exists anchor_stale boolean not null default false;

-- migrate:up
-- Persist bucket OPEN/HIGH/LOW alongside close on 5m bars (2026-07-30).
--
-- Grading motive: the first production review of the reclaim layer could only
-- compute MFE/MAE from 5-minute CLOSES, which cannot answer the question the
-- data actually raised — whether a tight invalidation triggers BEFORE the
-- favourable excursion arrives. Measured on a session/time-matched control,
-- confirms carry ~2.0x the +5% moves but ~2.3x the -3% moves, so the whole
-- keep/kill decision now rests on target-before-stop ordering, which needs
-- intrabar extremes.
--
-- The feed already supplies these: the Databento sidecar emits {o,h,l,c,v} and
-- tickfeed's onBar already parses them; they were simply dropped before
-- persistence. Nullable so existing rows and every historical backfill path
-- (which carry close/volume only) stay valid. EMA math continues to read
-- close/volume exclusively — these columns are grading evidence, not inputs.
ALTER TABLE bars_5m
  ADD COLUMN IF NOT EXISTS open  double precision,
  ADD COLUMN IF NOT EXISTS high  double precision,
  ADD COLUMN IF NOT EXISTS low   double precision;

-- migrate:down
ALTER TABLE bars_5m
  DROP COLUMN IF EXISTS open,
  DROP COLUMN IF EXISTS high,
  DROP COLUMN IF EXISTS low;

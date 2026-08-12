-- migrate:up
-- Price structure for the experimental MOMO SETUPS trigger. Nullable keeps
-- all pre-migration bars and close-only historical backfills valid.
ALTER TABLE bars_2m
  ADD COLUMN IF NOT EXISTS open double precision,
  ADD COLUMN IF NOT EXISTS high double precision,
  ADD COLUMN IF NOT EXISTS low double precision;

-- migrate:down
ALTER TABLE bars_2m
  DROP COLUMN IF EXISTS open,
  DROP COLUMN IF EXISTS high,
  DROP COLUMN IF EXISTS low;

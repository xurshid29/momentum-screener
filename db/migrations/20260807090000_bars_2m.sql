-- migrate:up
-- Closed 2m bars — the ⤴ MOMO tab's second MACD variant (3/15/8 on 2-minute
-- buckets, 2026-08-07, operator's ask: their other TV setup). 23-bar warmup
-- (~46 min of active tape) would restart on every deploy without persistence
-- — the XCROSS lesson; the default tab cannot go blank for an hour after
-- each rollout. Aggregated in-process from the tick feed's per-second
-- stream (known runners only), short retention (3d, pruned at midnight ET).
CREATE TABLE bars_2m (
  ticker varchar(12) NOT NULL,
  bar_ts timestamptz NOT NULL,
  close double precision NOT NULL,
  volume double precision NOT NULL,
  PRIMARY KEY (ticker, bar_ts)
);
CREATE INDEX idx_bars_2m_ts ON bars_2m (bar_ts);

-- migrate:down
DROP TABLE bars_2m;

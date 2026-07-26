-- migrate:up
CREATE TABLE bars_15m (
  ticker varchar(12) NOT NULL,
  bar_ts timestamptz NOT NULL,
  close double precision NOT NULL,
  volume double precision NOT NULL,
  PRIMARY KEY (ticker, bar_ts)
);
CREATE INDEX idx_bars_15m_ts ON bars_15m (bar_ts);

-- migrate:down
DROP TABLE bars_15m;

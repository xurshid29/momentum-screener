-- migrate:up
CREATE TABLE bars_1d (
  ticker varchar(12) NOT NULL,
  bar_ts timestamptz NOT NULL,
  close double precision NOT NULL,
  volume double precision NOT NULL,
  PRIMARY KEY (ticker, bar_ts)
);
CREATE INDEX idx_bars_1d_ts ON bars_1d (bar_ts);

-- migrate:down
DROP TABLE bars_1d;

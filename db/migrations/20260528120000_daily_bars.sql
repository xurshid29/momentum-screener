-- migrate:up

-- Daily OHLCV bars per ticker. Source: Finviz `quote_export?t=TICKER&p=d`
-- (CSV: Date,Open,High,Low,Close,Volume). Powers the Swing screener's
-- daily-timeframe signals — 20/50/200-day SMAs, 52w high, ATR, base
-- detection, breakout detection. See docs/swing-screener-spec.md §4.1.
--
-- Backfill model: one-shot fill for the Swing universe (~500 names × ~250
-- bars = ~125k rows, trivial), then a nightly refresh at midnight ET that
-- adds the new daily bar. The in-day bar is updated best-effort from the
-- live price/volume during each Swing scan; the final value is overwritten
-- from Finviz after close.
--
-- Primary key (ticker, date) — Finviz returns one bar per ET trading day,
-- and we upsert on every refresh.
create table daily_bars (
    ticker      varchar(16) not null,
    date        date        not null,
    open        numeric(12, 4),
    high        numeric(12, 4),
    low         numeric(12, 4),
    close       numeric(12, 4),
    volume      bigint,
    -- last source-fetch timestamp; lets the refresh job pick up bars that
    -- haven't been touched recently (and skip already-fresh ones).
    fetched_at  timestamptz not null default current_timestamp,
    primary key (ticker, date)
);

-- "Give me the most recent N bars for ticker X" is the hot query path —
-- the SMA / 52w-high / base-detection logic all order by date desc, limit N.
create index idx_daily_bars_ticker_date on daily_bars (ticker, date desc);

-- migrate:down
drop table if exists daily_bars;

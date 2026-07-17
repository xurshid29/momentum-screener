-- migrate:up
-- Closed 4-hour bars (ET-session-aligned buckets) for the known-runner set —
-- the 📈 4h EMA-cross layer's warmup store, same pattern as bars_5m. A 4h
-- EMA(6/50) needs ~50 closed bars ≈ 2-3 weeks of tape, which can never be
-- accumulated live after a deploy; boot replays from here and a Databento
-- historical backfill (ohlcv-1h aggregated) fills gaps for new symbols.
-- Retention: pruned to 40 days at the midnight roll.
create table bars_4h (
    ticker  varchar(12) not null,
    bar_ts  timestamptz not null,      -- bar CLOSE time
    close   double precision not null,
    volume  double precision not null,
    primary key (ticker, bar_ts)
);

create index idx_bars_4h_ts on bars_4h (bar_ts);

-- migrate:down
drop table bars_4h;

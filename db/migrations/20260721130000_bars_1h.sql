-- migrate:up
-- Closed 1-hour bars for the known-runner set — the 📈 1h EMA-cross layer's
-- warmup store, same pattern as bars_4h (see 20260717120000). EMA50(1h)
-- needs ~150 banked bars for TV-parity convergence; boot replays from here
-- and the Databento ohlcv-1h backfill fills gaps. Retention: 35 days.
create table bars_1h (
    ticker  varchar(12) not null,
    bar_ts  timestamptz not null,      -- bar CLOSE time
    close   double precision not null,
    volume  double precision not null,
    primary key (ticker, bar_ts)
);

create index idx_bars_1h_ts on bars_1h (bar_ts);

-- migrate:down
drop table bars_1h;

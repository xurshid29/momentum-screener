-- migrate:up
-- Closed 5-minute bars for the known-runner set, written by the tick feed's
-- EMA-cross tracker and replayed at boot to survive deploys. Without this,
-- the EMA(6/50) layer needs ~50 closed bars per symbol (a full trading day
-- for thin names) after every container restart — three deploys on
-- 2026-07-14 left the layer completely silent on 07-15. Retention: pruned
-- to 3 days at the midnight roll (only ~50 bars per symbol are needed).
create table bars_5m (
    ticker  varchar(12) not null,
    bar_ts  timestamptz not null,      -- bar CLOSE time
    close   double precision not null,
    volume  double precision not null,
    primary key (ticker, bar_ts)
);

create index idx_bars_5m_ts on bars_5m (bar_ts);

-- migrate:down
drop table bars_5m;

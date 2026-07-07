-- migrate:up
-- Durable record of every early-detection tier transition (🤫 accum, 👀/🛰️
-- tick, 📰 radar). These were console.log-only, but each CI deploy recreates
-- the api container and wipes its logs — four deploys on 2026-07-07 erased the
-- day's grading evidence four times. Persisting the transitions makes tier
-- precision a SQL query over any date range and finally gives tick catches a
-- DB footprint (the old "display-only" open item).
--
-- tier:  'accum' | 'tick' | 'radar'
-- event: accum → flag | promote | expire
--        tick  → watch | watch_suppressed | confirm | fade | watch_expired
--        radar → hit | moving | expired | dropped
-- meta:  free-form event context (chg, fast_rv, via, watch_change_pct, pts,
--        minutes, impact, url, reason…) — shapes documented at the call sites.
create table tier_events (
    id      uuid primary key default extensions.uuid_generate_v4(),
    tier    varchar(10) not null,
    event   varchar(20) not null,
    ticker  varchar(12) not null,
    at      timestamptz not null default current_timestamp,
    meta    jsonb
);

create index idx_tier_events_at on tier_events (at);
create index idx_tier_events_ticker on tier_events (ticker, at);
create index idx_tier_events_tier_event on tier_events (tier, event, at);

-- migrate:down
drop table tier_events;

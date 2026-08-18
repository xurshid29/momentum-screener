-- migrate:up
-- User-defined 1-minute execution playbook. EMA periods are deliberately
-- per-user/per-ticker: Edge evaluates the operator's saved chart levels; it
-- does not search EMA combinations or turn them into a global stock picker.
create table user_edge_presets (
    user_id          uuid not null references users(id) on delete cascade,
    ticker           varchar(12) not null,
    ema_fast         integer not null check (ema_fast between 2 and 499),
    ema_slow         integer not null check (ema_slow between 3 and 500),
    proximity_pct    numeric(6,3) not null default 0.750
                         check (proximity_pct between 0.05 and 10),
    stop_buffer_pct  numeric(6,3) not null default 0.500
                         check (stop_buffer_pct between 0 and 10),
    alert_armed      boolean not null default true,
    alert_entry      boolean not null default true,
    alert_bailout    boolean not null default true,
    telegram_enabled boolean not null default true,
    active           boolean not null default true,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    primary key (user_id, ticker),
    check (ema_fast < ema_slow)
);

create index user_edge_presets_ticker_idx
    on user_edge_presets (ticker) where active;

-- A small, shared warmup store for only the tickers with Edge presets. This
-- is intentionally separate from the parked global technical-bar tables.
create table edge_bars_1m (
    ticker varchar(12) not null,
    bar_ts timestamptz not null,
    open   numeric(18,6) not null,
    high   numeric(18,6) not null,
    low    numeric(18,6) not null,
    close  numeric(18,6) not null,
    volume bigint not null,
    primary key (ticker, bar_ts)
);

create index edge_bars_1m_ts_idx on edge_bars_1m (bar_ts);

-- Durable transition log for alert dedupe, review, and later trade-journal
-- attribution. Snapshot freezes the indicator geometry at the decision.
create table edge_events (
    id         uuid primary key default extensions.uuid_generate_v4(),
    user_id    uuid not null references users(id) on delete cascade,
    ticker     varchar(12) not null,
    event      varchar(12) not null check (event in ('armed', 'entry', 'bailout')),
    setup      varchar(24),
    price      numeric(18,6) not null,
    level      numeric(18,6),
    bailout    numeric(18,6),
    at         timestamptz not null default now(),
    snapshot   jsonb not null default '{}'::jsonb
);

create index edge_events_user_at_idx on edge_events (user_id, at desc);
create index edge_events_ticker_at_idx on edge_events (ticker, at desc);

-- migrate:down
drop table if exists edge_events;
drop table if exists edge_bars_1m;
drop table if exists user_edge_presets;

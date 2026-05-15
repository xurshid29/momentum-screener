-- migrate:up
-- Persists the global poller config (ScreenerFilterSnapshot) across restarts.
-- Single row — the poller is a global singleton, so one config for everyone.
-- The id=1 check makes the single-row invariant explicit.
create table screener_settings (
    id int primary key default 1 check (id = 1),
    config jsonb not null,
    updated_at timestamptz not null default now()
);

-- migrate:down
drop table if exists screener_settings;

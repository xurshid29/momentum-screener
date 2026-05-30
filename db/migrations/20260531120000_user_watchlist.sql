-- migrate:up
-- Per-user watchlist / favorites with an expiration date. The "add it while
-- the market's closed, analyze it, act at the open" list. Each entry has a
-- free-text note (the thesis) and an expires_at date; entries are removed
-- once expires_at passes (the GET endpoint does the ET-day cleanup, same
-- pattern as user_hidden_tickers). PK (user_id, ticker) so re-adding a ticker
-- updates its note/expiry rather than duplicating.
create table user_watchlist (
    user_id    uuid not null references users(id) on delete cascade,
    ticker     text not null,
    note       text,
    expires_at date not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (user_id, ticker)
);

create index user_watchlist_lookup_idx
    on user_watchlist (user_id, expires_at);

-- migrate:down
drop table if exists user_watchlist;

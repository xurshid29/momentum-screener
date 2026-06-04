-- migrate:up
-- Per-user "avoid / burned" list — a manual warning flag on tickers that
-- pump-and-dumped on the operator (VIVK: hot $108M crude-deal news, ripped to
-- ~$2.60, dumped to ~$0.93). Unlike the watchlist (transient trade idea, 2-day
-- expiry), a burned flag is a STRUCTURAL fact about the ticker — the promoter /
-- float / dilution vehicle persists and these names recur — so it has NO expiry;
-- the user removes it manually if the name ever cleans up. Surfaces as a ⚠
-- warning + dimmed row everywhere the ticker appears. Complements the automatic
-- pump-and-dump detection off screener_outcomes (no table — computed live).
create table user_flagged_tickers (
    user_id    uuid not null references users(id) on delete cascade,
    ticker     text not null,
    note       text,
    created_at timestamptz not null default now(),
    primary key (user_id, ticker)
);

create index user_flagged_tickers_user_idx on user_flagged_tickers (user_id);

-- migrate:down
drop table if exists user_flagged_tickers;

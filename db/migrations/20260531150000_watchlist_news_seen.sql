-- migrate:up
-- Powers the watchlist "new news" indicator: a 🆕 dot lights up when an
-- article newer than this timestamp is linked to the ticker, and clears once
-- the user opens that row's news (POST /watchlist/:ticker/seen sets it to now).
-- NULL = never viewed, so the baseline is the entry's created_at.
alter table user_watchlist add column news_seen_at timestamptz;

-- migrate:down
alter table user_watchlist drop column news_seen_at;

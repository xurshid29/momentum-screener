-- migrate:up
-- Ticker columns were varchar(16). Finviz news tags aggregate articles with a
-- comma-joined ticker list ("OCG,FCHL,TDIC"); a long-enough list overflowed
-- varchar(16) and failed the whole persist transaction. The poller now splits
-- that field per-ticker, but widen to text so a stray long value can never
-- wedge the cycle again. (Applied manually on prod during the incident.)
alter table news_ticker_links alter column ticker type text;
alter table screener_results alter column ticker type text;

-- migrate:down
alter table news_ticker_links alter column ticker type varchar(16);
alter table screener_results alter column ticker type varchar(16);

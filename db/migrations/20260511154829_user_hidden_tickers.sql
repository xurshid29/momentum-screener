-- migrate:up
create table user_hidden_tickers (
    user_id uuid not null references users(id) on delete cascade,
    ticker text not null,
    hidden_date date not null,
    hidden_at timestamptz not null default now(),
    primary key (user_id, ticker, hidden_date)
);

create index user_hidden_tickers_lookup_idx
    on user_hidden_tickers (user_id, hidden_date);

-- migrate:down
drop table if exists user_hidden_tickers;

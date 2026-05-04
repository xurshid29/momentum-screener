-- migrate:up

-- One row per poll cycle. filter_snapshot stores the exact filter+config
-- the poller used at that moment, so we can reconstruct historical context.
create table screener_cycles (
    id uuid primary key default extensions.uuid_generate_v4(),
    polled_at timestamptz not null default current_timestamp,
    filter_snapshot jsonb not null,
    row_count integer not null default 0,
    created_at timestamptz not null default current_timestamp
);
create index idx_screener_cycles_polled_at on screener_cycles (polled_at desc);

-- One row per ticker per cycle. status is the row classification the poller
-- assigned ('NEW' / 'ACC' / 'UP' / 'NEWS' / null). prev_change_pct is whatever
-- the poller saw last cycle for the same ticker (null if it's a NEW entrant).
create table screener_results (
    id uuid primary key default extensions.uuid_generate_v4(),
    cycle_id uuid not null references screener_cycles(id) on delete cascade,
    ticker varchar(16) not null,
    change_pct numeric(8, 4),
    float_m numeric(12, 4),
    price numeric(12, 4),
    volume bigint,
    mcap_m numeric(14, 4),
    country varchar(32),
    status varchar(8),
    prev_change_pct numeric(8, 4),
    accel_delta numeric(8, 4)
);
create index idx_screener_results_cycle on screener_results (cycle_id);
create index idx_screener_results_ticker on screener_results (ticker);

-- Deduped news. url is the natural key (same article from different sources
-- often shares the URL; we treat them as one). raw stores the source-specific
-- payload (e.g. Benzinga's full JSON object) for retroactive analysis.
create table news_articles (
    id uuid primary key default extensions.uuid_generate_v4(),
    source varchar(16) not null,
    url text not null unique,
    title text not null,
    published_at timestamptz,
    fetched_at timestamptz not null default current_timestamp,
    raw jsonb
);
create index idx_news_articles_published_at on news_articles (published_at desc);
create index idx_news_articles_source on news_articles (source);

-- M:N article ↔ ticker. Most articles are tagged with one ticker; Benzinga
-- multi-ticker articles get a row per ticker.
create table news_ticker_links (
    article_id uuid not null references news_articles(id) on delete cascade,
    ticker varchar(16) not null,
    primary key (article_id, ticker)
);
create index idx_news_ticker_links_ticker on news_ticker_links (ticker);

-- Per-user filter presets. is_default flags the one applied at login.
create table user_filter_presets (
    id uuid primary key default extensions.uuid_generate_v4(),
    user_id uuid not null references users(id) on delete cascade,
    name varchar(64) not null,
    filter jsonb not null,
    is_default boolean not null default false,
    created_at timestamptz not null default current_timestamp,
    updated_at timestamptz not null default current_timestamp
);
create unique index idx_user_filter_presets_default
    on user_filter_presets (user_id) where is_default;

-- Per-user panel layout (sizes/visibility for the 4 left-side panels).
create table user_panel_layout (
    user_id uuid primary key references users(id) on delete cascade,
    layout jsonb not null,
    updated_at timestamptz not null default current_timestamp
);

-- Per-user chart slot configuration. slot is 1..4 (the 2x2 grid).
-- ticker may be null until the user picks one (defaults to "follow screener selection").
create table user_chart_prefs (
    user_id uuid not null references users(id) on delete cascade,
    slot integer not null check (slot between 1 and 4),
    ticker varchar(16),
    interval varchar(8) not null default '5',
    follow_selection boolean not null default true,
    primary key (user_id, slot)
);

-- migrate:down
drop table if exists user_chart_prefs;
drop table if exists user_panel_layout;
drop table if exists user_filter_presets;
drop table if exists news_ticker_links;
drop table if exists news_articles;
drop table if exists screener_results;
drop table if exists screener_cycles;

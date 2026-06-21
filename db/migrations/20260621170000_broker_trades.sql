-- migrate:up
-- Broker trade import — the foundation for the trade-journal / P&L-calendar and
-- the future "did the screener predict my actual trades?" report. Two tables:
--
--   broker_imports    — one row per uploaded statement file (IBKR TradeLog .tlg
--                       for now), with a content hash so a re-upload of the same
--                       file is recognisable. Informational; dedup is per-fill.
--   trade_executions  — one row per individual fill (leg). The source of truth.
--                       Round-trip "trades" (flat-to-flat per symbol) are derived
--                       from these in code (services/ibkr-tlg.ts matchTrades), not
--                       stored, so there's nothing to keep in sync.
--
-- Idempotent re-import: the broker's own execution id is globally unique, so a
-- UNIQUE (user_id, exec_id) lets you re-upload overlapping date ranges without
-- duplicating fills (ON CONFLICT DO NOTHING on insert).
--
-- Timezone: IBKR TradeLog timestamps are US-Eastern wall clock (the user trades
-- US pre-market from 04:00 ET). executed_at is stored as that ET wall clock
-- (timestamp WITHOUT time zone — no conversion, no DST footguns); et_date is the
-- ET trading date used for all calendar grouping. The screener is ET-anchored
-- too, so this joins cleanly to screener_outcomes on (ticker, et_date) later.
create table broker_imports (
    id            uuid primary key default extensions.uuid_generate_v4(),
    user_id       uuid not null references users(id) on delete cascade,
    broker        varchar(20) not null default 'ibkr',
    filename      text,
    account       varchar(32),                 -- e.g. U22894397 (from ACT_INF)
    file_hash     varchar(64),                 -- sha256 of file content (re-upload detection)
    period_start  date,
    period_end    date,
    executions_seen     integer not null default 0,   -- fills parsed from the file
    executions_imported integer not null default 0,   -- fills actually new (post-dedup)
    created_at    timestamptz not null default current_timestamp
);

create index idx_broker_imports_user on broker_imports (user_id, created_at desc);

create table trade_executions (
    id          uuid primary key default extensions.uuid_generate_v4(),
    user_id     uuid not null references users(id) on delete cascade,
    import_id   uuid references broker_imports(id) on delete set null,
    exec_id     varchar(40) not null,          -- broker execution id (natural dedup key)
    symbol      varchar(16) not null,
    description text,
    venue       varchar(40),                   -- routing venue(s), e.g. NASDAQ / "PEARL,MEMX"
    side        varchar(4) not null,           -- 'buy' | 'sell'
    open_close  varchar(1),                    -- 'O' (open) | 'C' (close)
    action_raw  varchar(16),                   -- BUYTOOPEN / SELLTOCLOSE / …
    quantity    numeric(18, 4) not null,       -- signed: + buy, − sell
    multiplier  numeric(12, 4) not null default 1,
    price       numeric(18, 6) not null,
    amount      numeric(18, 4) not null,       -- quantity × price, signed (notional, per the .tlg)
    commission  numeric(14, 4) not null default 0,  -- broker commission, ≤ 0 (a cost)
    currency    varchar(8) not null default 'USD',
    executed_at timestamp not null,            -- ET wall clock (no tz — see header)
    et_date     date not null,                 -- ET trading date (calendar grouping key)
    created_at  timestamptz not null default current_timestamp,
    unique (user_id, exec_id)
);

create index idx_trade_executions_user_date on trade_executions (user_id, et_date);
create index idx_trade_executions_user_symbol on trade_executions (user_id, symbol, executed_at);

-- migrate:down
drop table if exists trade_executions;
drop table if exists broker_imports;

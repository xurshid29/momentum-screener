-- migrate:up
-- Forward outcome tracking. One row per (screen, ticker, ET trading day): the
-- entry context as it was at detection, plus the close-to-close move over the
-- next 1/3/5 trading days read from daily_bars. Turns "did the score/catalyst/
-- shelf predict the move?" into a single GROUP BY instead of ad-hoc psql.
--
-- Populated by the OutcomesService daily job (services/outcomes.ts), fired from
-- the poller's post-close hook. The job upserts and revisits each row until
-- bars_forward >= 5, so a name detected today gets chg_1d tomorrow, chg_3d in 3
-- days, chg_5d in 5. Entry anchor is the detection-day daily_bars close (the
-- honest overnight/multi-day-hold reference); first/peak_change_pct preserve
-- the intraday context so "already-extended entries fade" is directly testable.
create table screener_outcomes (
    id                 uuid primary key default extensions.uuid_generate_v4(),
    screen             varchar(12) not null,        -- 'momentum' | 'ignition' | 'swing'
    ticker             varchar(16) not null,
    et_date            date not null,               -- ET trading day of detection

    -- entry context, denormalized from that day's screen rows + classifications
    entry_close        numeric(14, 4),              -- daily_bars close on et_date — the anchor
    next_open          numeric(14, 4),              -- next session open (overnight-gap context)
    entry_score        numeric(6, 2),               -- peak runner/swing score that day; null for momentum
    first_change_pct   numeric(8, 2),               -- earliest observed change% that day (how extended at entry)
    peak_change_pct    numeric(8, 2),               -- intraday peak change% that day
    catalyst_score     integer,                     -- best classified impact_score that day
    catalyst_direction varchar(10),
    catalyst_urgency   varchar(10),
    catalyst_type      varchar(40),
    shelf_level        varchar(12),                 -- shelf/effective/active/null at detection
    sessions           text[],                      -- ET sessions it appeared in {premarket,regular,afterhours}

    -- forward outcomes off daily_bars, close-to-close from entry_close (percent)
    chg_1d             numeric(8, 2),
    chg_3d             numeric(8, 2),
    chg_5d             numeric(8, 2),
    peak_5d            numeric(8, 2),               -- max high over +1..+5 vs entry_close (best case)
    drawdown_5d        numeric(8, 2),               -- min low  over +1..+5 vs entry_close (worst case)
    bars_forward       integer not null default 0,  -- forward daily bars available (completeness)

    computed_at        timestamptz not null default current_timestamp,
    updated_at         timestamptz not null default current_timestamp,
    unique (screen, ticker, et_date)
);

create index idx_screener_outcomes_screen_date on screener_outcomes (screen, et_date);
create index idx_screener_outcomes_ticker      on screener_outcomes (ticker);

-- migrate:down
drop table if exists screener_outcomes;

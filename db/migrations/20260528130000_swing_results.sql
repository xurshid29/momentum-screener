-- migrate:up

-- One row per Swing-screener candidate per scan. Like ignition_results, this
-- table is fully separate from screener_results — zero impact on existing
-- Momentum queries — and records the swing_score *as of evaluation time* so
-- the weights can be tuned/backtested against real outcomes later (forward-
-- join ticker → daily_bars next-N-days). See docs/swing-screener-spec.md §5.
--
-- Note the cadence mismatch: the Swing scan only runs every ~60 poll cycles
-- (~20 min) plus a forced post-close refresh, but each scan references the
-- screener_cycles row it ran *inside* — no separate swing_cycles table needed.
create table swing_results (
    id                uuid primary key default extensions.uuid_generate_v4(),
    cycle_id          uuid not null references screener_cycles(id) on delete cascade,
    ticker            varchar(16) not null,
    swing_score       numeric(5, 2) not null,
    score_breakdown   jsonb not null,
    -- Live screener context
    price             numeric(12, 4),
    change_pct        numeric(8, 4),
    float_m           numeric(12, 4),
    mcap_m            numeric(12, 4),
    volume            bigint,
    -- Daily-bar snapshot — the inputs to the score, frozen so the "did the
    -- setup work?" backtest has the same view of the world the score had.
    avg_volume_20     bigint,
    sma_20            numeric(12, 4),
    sma_50            numeric(12, 4),
    sma_200           numeric(12, 4),
    high_52w          numeric(12, 4),
    atr_14            numeric(12, 4),
    in_base           boolean,
    broke_out         boolean,
    close_in_top_q    boolean,
    catalyst_score    integer,
    catalyst_type     varchar(32),
    shelf_level       varchar(16),
    created_at        timestamptz not null default current_timestamp
);
create index idx_swing_results_cycle  on swing_results (cycle_id);
create index idx_swing_results_ticker on swing_results (ticker);
create index idx_swing_results_score  on swing_results (swing_score desc);

-- migrate:down
drop table if exists swing_results;

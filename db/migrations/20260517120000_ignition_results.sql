-- migrate:up

-- One row per Ignition-screener candidate per poll cycle. Kept separate from
-- screener_results so the volume-led Ignition screen never collides with the
-- Momentum queries. runner_score + score_breakdown are recorded as-of the
-- cycle so the score weights can be tuned/backtested against real outcomes.
create table ignition_results (
    id              uuid primary key default extensions.uuid_generate_v4(),
    cycle_id        uuid not null references screener_cycles(id) on delete cascade,
    ticker          varchar(16) not null,
    runner_score    numeric(5, 2) not null,
    score_breakdown jsonb not null,
    price           numeric(12, 4),
    change_pct      numeric(8, 4),
    float_m         numeric(12, 4),
    rel_volume      numeric(12, 4),
    rel_vol_5min    numeric(12, 4),
    catalyst_score  integer,
    news_source     varchar(16),
    created_at      timestamptz not null default current_timestamp
);
create index idx_ignition_results_cycle on ignition_results (cycle_id);
create index idx_ignition_results_ticker on ignition_results (ticker);
create index idx_ignition_results_score on ignition_results (runner_score desc);

-- migrate:down
drop table if exists ignition_results;

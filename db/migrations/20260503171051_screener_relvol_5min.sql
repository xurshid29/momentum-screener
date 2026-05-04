-- migrate:up
alter table screener_results
    add column vol_5min bigint,
    add column rel_vol_5min numeric(12, 2);

-- migrate:down
alter table screener_results
    drop column if exists rel_vol_5min,
    drop column if exists vol_5min;

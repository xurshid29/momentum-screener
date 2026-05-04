-- migrate:up
alter table screener_results
    add column avg_volume bigint,
    add column rel_volume numeric(10, 2);

-- migrate:down
alter table screener_results
    drop column if exists rel_volume,
    drop column if exists avg_volume;

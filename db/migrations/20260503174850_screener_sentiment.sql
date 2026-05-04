-- migrate:up
alter table screener_results
    add column short_float_pct numeric(8, 4),
    add column short_ratio numeric(8, 2),
    add column insider_own_pct numeric(10, 4),
    add column insider_trans_pct numeric(10, 4),
    add column inst_own_pct numeric(10, 4),
    add column inst_trans_pct numeric(10, 4),
    add column shares_out_m numeric(14, 4);

-- migrate:down
alter table screener_results
    drop column if exists shares_out_m,
    drop column if exists inst_trans_pct,
    drop column if exists inst_own_pct,
    drop column if exists insider_trans_pct,
    drop column if exists insider_own_pct,
    drop column if exists short_ratio,
    drop column if exists short_float_pct;

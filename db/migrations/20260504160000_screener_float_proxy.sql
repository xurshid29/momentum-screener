-- migrate:up

-- True when float_m was filled in from shares_outstanding because Finviz
-- returned no Float value. Lets the UI render a small marker so the user
-- knows the displayed Float is a best-effort estimate, not the real number.
alter table screener_results
    add column float_is_proxy boolean not null default false;

-- migrate:down
alter table screener_results drop column if exists float_is_proxy;

-- migrate:up
alter table screener_results
    add column company text,
    add column sector varchar(64),
    add column industry varchar(96);

-- migrate:down
alter table screener_results
    drop column if exists industry,
    drop column if exists sector,
    drop column if exists company;

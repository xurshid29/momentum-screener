-- migrate:up
alter table user_chart_prefs
    add column studies jsonb not null default '[]'::jsonb;

-- migrate:down
alter table user_chart_prefs
    drop column if exists studies;

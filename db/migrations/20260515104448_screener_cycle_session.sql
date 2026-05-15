-- migrate:up
-- Which ET trading session a cycle was polled in. The poller screens and
-- displays after-hours change/price during 'afterhours'; the other sessions
-- use the regular Finviz change. Existing rows predate the feature → 'regular'.
alter table screener_cycles
    add column session text not null default 'regular'
        check (session in ('premarket', 'regular', 'afterhours', 'closed'));

-- migrate:down
alter table screener_cycles drop column session;

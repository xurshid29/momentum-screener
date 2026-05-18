-- migrate:up

-- The dilution kill-switch as-of ignition time. An effective shelf (S-3/F-3/
-- S-1) lets the company sell stock into a spike; recording the level per
-- ignition row makes it backtestable — "did loaded-shelf ignitions fade?".
-- Values: 'shelf' | 'effective' | 'active' | null. See services/shelf.ts.
alter table ignition_results add column shelf_level varchar(16);

-- migrate:down
alter table ignition_results drop column shelf_level;

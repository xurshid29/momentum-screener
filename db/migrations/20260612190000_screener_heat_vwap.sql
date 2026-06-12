-- migrate:up

-- Persist the Heat composite + the VWAP side per momentum row. Heat was
-- broadcast-only and vwap/above_vwap/vwap_reclaim were computed from
-- in-memory state — unrecoverable offline, which made outcome-grading the
-- heat weights (freshness / accel / VWAP / RVol) impossible. From this date
-- "did heat predict the move?" is a join against screener_outcomes, same as
-- runner_score. Values carry the 2026-06-12 semantics (exact 5-min RVol
-- window, re-anchored tiers + 1m/5m burst bonus, restart-seeded VWAP).
alter table screener_results add column heat smallint;
alter table screener_results add column vwap numeric;
alter table screener_results add column above_vwap boolean;
alter table screener_results add column vwap_reclaim boolean;

-- migrate:down

alter table screener_results drop column heat;
alter table screener_results drop column vwap;
alter table screener_results drop column above_vwap;
alter table screener_results drop column vwap_reclaim;

-- migrate:up

-- 1-min relative volume: % of a typical 1-minute slice of avg daily volume
-- (avg_volume / 390), computed from a 60s cumulative-volume window. The fast
-- "is the burst live right now" companion to rel_vol_5min.
--
-- NOTE — rel_vol_5min scale break on 2026-06-12: rows written before this
-- migration carry a buggy 5-min metric whose window silently drifted to
-- ~10 min for any name tracked >5 min (median ~2.04x inflated). Rows written
-- after are exact 5-min. Segment any cross-date tuning queries accordingly.
alter table screener_results add column rel_vol_1min numeric;
alter table ignition_results add column rel_vol_1min numeric;

-- migrate:down

alter table screener_results drop column rel_vol_1min;
alter table ignition_results drop column rel_vol_1min;

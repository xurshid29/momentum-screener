-- ↗ EMA 10/65 price-reclaim — reproducible grading queries
-- ============================================================================
-- Companion to docs/reclaim-strategy-investigation-2026-07-30.md. Committed so
-- each checkpoint runs the SAME cuts instead of ad-hoc SQL (the EMAMACD2
-- lesson: durable scripts or the numbers aren't comparable across reviews).
--
--   source .env && psql "$DATABASE_URL" -f scripts/research/reclaim-grading.sql
--   # prod: docker compose -f docker-compose.prod.yml exec -T postgres \
--   #         psql -U pnldash -d pnldash -f - < this file
--
-- ⚠️ SEGMENT BOUNDARIES — semantics changed on these dates, so never pool
-- across them:
--   2026-07-28  staged arming shipped + three warmup holes closed (FIEE)
--   2026-07-29  11:16 ET  exceptional-volume escape (additive: it only ADDS
--                         confirms below the $10k floor, so earlier confirms
--                         stay comparable, but the escape cohort itself starts
--                         here — NOT at 04:00)
--   2026-07-30  bars_5m gained open/high/low; retention 6d → 45d. Rows before
--                         this have NULL extremes, so target-before-stop is
--                         only computable from here forward.
\set seg_start '2026-07-29 04:00:00-04'

-- ── 1. Funnel volume by timeframe ───────────────────────────────────────────
-- Raw transitions, NOT matched observations. HTF expiry counts stay near zero
-- because a 4h observation spans ~24h — do not read that as precision.
SELECT meta->>'tf' tf,
       count(*) FILTER (WHERE event='nominate') noms,
       count(*) FILTER (WHERE event='confirm')  confirms,
       count(*) FILTER (WHERE event='expire')   expires,
       count(DISTINCT ticker) FILTER (WHERE event='confirm') distinct_confirmed
FROM tier_events
WHERE tier='cross' AND meta->>'signal'='reclaim' AND at >= :'seg_start'
GROUP BY 1 ORDER BY 1;

-- ── 2. Extension already paid between reclaim and confirm ───────────────────
-- How much of the move the confirmation wait consumes. Read against the
-- post-confirm MFE in query 4: if they are comparable, the alert arrives after
-- half the median move.
SELECT meta->>'tf' tf, count(*) n,
       round(percentile_cont(0.5) WITHIN GROUP (
         ORDER BY 100*((meta->>'price')::numeric/nullif((meta->>'cross_price')::numeric,0)-1))::numeric,2) med_pct,
       round(percentile_cont(0.9) WITHIN GROUP (
         ORDER BY 100*((meta->>'price')::numeric/nullif((meta->>'cross_price')::numeric,0)-1))::numeric,2) p90_pct
FROM tier_events
WHERE tier='cross' AND event='confirm' AND meta->>'signal'='reclaim' AND at >= :'seg_start'
GROUP BY 1 ORDER BY 1;

-- ── 3. 5m funnel by arming shape / evidence path / baseline ──────────────────
-- ⚠️ "confirm % of terminal" is OPTIMISTIC: unresolved observations are not
-- random (sparse names advance on bars, not wall clock) and skew toward expiry.
WITH n AS (
  SELECT ticker, at, meta,
         CASE WHEN coalesce(meta->>'staged_bars','0') <> '0' THEN 'staged' ELSE 'same-bar' END arming,
         CASE WHEN meta->>'pending_min' IS NOT NULL THEN 'pending' ELSE 'direct' END path,
         CASE WHEN (meta->>'sib_median')::numeric * (meta->>'cross_price')::numeric < 2000
              THEN 'dead <$2k' ELSE 'baseline >=$2k' END baseline,
         lead(at) OVER (PARTITION BY ticker ORDER BY at) next_nom
  FROM tier_events
  WHERE tier='cross' AND event='nominate' AND meta->>'signal'='reclaim'
    AND meta->>'tf'='5m' AND at >= :'seg_start' AND at < now() - interval '40 minutes'
), term AS (
  SELECT n.*, (
    SELECT t.event FROM tier_events t
    WHERE t.ticker=n.ticker AND t.tier='cross' AND t.meta->>'tf'='5m'
      AND t.event IN ('confirm','expire') AND t.at >= n.at
      AND (n.next_nom IS NULL OR t.at < n.next_nom)
    ORDER BY t.at LIMIT 1) outcome
  FROM n
)
SELECT arming, path, baseline, count(*) noms,
       count(*) FILTER (WHERE outcome='confirm') confirms,
       count(*) FILTER (WHERE outcome='expire')  expires,
       count(*) FILTER (WHERE outcome IS NULL)   unresolved,
       round(100.0*count(*) FILTER (WHERE outcome='confirm')
             / nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) confirm_pct_of_terminal
FROM term GROUP BY 1,2,3 ORDER BY noms DESC;

-- ── 4. Post-confirm follow-through vs a SESSION-MATCHED random control ───────
-- THE headline test. An unmatched control inflates the lift badly: drawing
-- controls across 04:00-19:00 ET compares regular-hours confirms against quiet
-- premarket/AH bars, which put the mean-MFE lift at 2.9× when the matched
-- figure is ~1.2×. Always restrict BOTH cohorts to the same session.
-- Re-run with several `salt` values — the control is stable to ~±0.1pp.
\set salt 'a'
\set win '60 minutes'
WITH b AS (
  SELECT ticker, bar_ts, close FROM bars_5m
  WHERE bar_ts >= :'seg_start' AND bar_ts < :'seg_start'::timestamptz + interval '20 hours'
), rh AS (
  SELECT * FROM b
  WHERE (bar_ts AT TIME ZONE 'America/New_York')::time BETWEEN '09:30' AND '16:00'
), conf AS (
  SELECT ticker, at, (meta->>'price')::numeric px FROM tier_events
  WHERE tier='cross' AND event='confirm' AND meta->>'signal'='reclaim' AND meta->>'tf'='5m'
    AND at >= :'seg_start' AND (at AT TIME ZONE 'America/New_York')::time BETWEEN '09:30' AND '16:00'
), co AS (
  SELECT 'A confirm' k, 100*(max(f.close)/c.px-1) mfe, 100*(min(f.close)/c.px-1) mae
  FROM conf c JOIN b f ON f.ticker=c.ticker AND f.bar_ts>c.at AND f.bar_ts<=c.at+ :'win'::interval
  GROUP BY 1,c.ticker,c.at,c.px HAVING count(*)>=4
), ctl AS (
  SELECT * FROM rh ORDER BY md5(:'salt' || ticker || bar_ts::text) LIMIT 2500
), cto AS (
  SELECT 'B control (session-matched)' k, 100*(max(f.close)/s.close-1) mfe, 100*(min(f.close)/s.close-1) mae
  FROM ctl s JOIN b f ON f.ticker=s.ticker AND f.bar_ts>s.bar_ts AND f.bar_ts<=s.bar_ts+ :'win'::interval
  GROUP BY 1,s.ticker,s.bar_ts,s.close HAVING count(*)>=4
)
SELECT k, count(*) n,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY mfe)::numeric,2) med_mfe,
       round(avg(mfe)::numeric,2) avg_mfe,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY mae)::numeric,2) med_mae,
       round(100.0*count(*) FILTER (WHERE mfe>=5)/count(*),1) pct_ge_plus5,
       round(100.0*count(*) FILTER (WHERE mae<=-3)/count(*),1) pct_le_minus3
FROM (SELECT * FROM co UNION ALL SELECT * FROM cto) x GROUP BY k ORDER BY k;

-- ── 5. Standard vs exceptional-escape confirms ──────────────────────────────
-- The escape is exactly the confirms under the normal dollar floor. Telegram
-- promotion depends on query 6, not on this count.
SELECT CASE WHEN (meta->>'notional')::numeric < 10000 THEN 'exceptional <$10k'
            WHEN (meta->>'notional')::numeric < 25000 THEN 'standard $10-25k'
            ELSE 'standard $25k+' END band,
       count(*) n,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (meta->>'vol_ratio')::numeric)::numeric,1) med_ratio
FROM tier_events
WHERE tier='cross' AND event='confirm' AND meta->>'signal'='reclaim' AND meta->>'tf'='5m'
  AND at >= timestamptz '2026-07-29 11:16:00-04'   -- escape exposure starts here
GROUP BY 1 ORDER BY 1;

-- ── 6. Target-before-stop  ⚠️ REQUIRES OHLC (rows from 2026-07-30 onward) ────
-- The decisive test. Median MFE/MAE hide ORDER OF ARRIVAL, and the session-
-- matched control showed confirms carry ~2.0× the +5% moves but ~2.3× the -3%
-- moves — so whether the layer is tradeable rests entirely on whether a tight
-- invalidation triggers before the favourable excursion. Close-only bars
-- cannot answer that; these columns exist for this query.
-- Returns, per confirm, which came first: target or stop.
WITH conf AS (
  SELECT ticker, at, (meta->>'price')::numeric px FROM tier_events
  WHERE tier='cross' AND event='confirm' AND meta->>'signal'='reclaim' AND meta->>'tf'='5m'
    AND at >= timestamptz '2026-07-30 00:00:00-04'
), seq AS (
  SELECT c.ticker, c.at, c.px, f.bar_ts, f.high, f.low,
         row_number() OVER (PARTITION BY c.ticker, c.at ORDER BY f.bar_ts) rn
  FROM conf c JOIN bars_5m f
    ON f.ticker=c.ticker AND f.bar_ts>c.at AND f.bar_ts<=c.at+interval '60 minutes'
  WHERE f.high IS NOT NULL
), firsts AS (
  SELECT ticker, at, px,
         min(rn) FILTER (WHERE high >= px*1.05) first_target,   -- +5%
         min(rn) FILTER (WHERE low  <= px*0.97) first_stop      -- -3%
  FROM seq GROUP BY 1,2,3
)
SELECT count(*) n,
       count(*) FILTER (WHERE first_target IS NOT NULL
                          AND (first_stop IS NULL OR first_target < first_stop)) target_first,
       count(*) FILTER (WHERE first_stop IS NOT NULL
                          AND (first_target IS NULL OR first_stop <= first_target)) stop_first,
       count(*) FILTER (WHERE first_target IS NULL AND first_stop IS NULL) neither
FROM firsts;

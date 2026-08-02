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

-- ── 7. A+/A/B attention tiers (2026-08-01 — the list optimization) ──────────
-- Definitions MUST match the display exactly (poller.ts CROSS_CO_CONFIRM_MS,
-- EmaReclaimPanel.isNotableB): A+ = an HTF reclaim confirm within ±2 min AND
-- vol_ratio ≥20; A = co-confirm alone; B-notable = 5m-only but ratio ≥30 or
-- price <$2 (the NCRA/WETO band, kept visible); B-rest = collapsed by default.
-- 3-session baseline at ship time: A+ 32.3% reach +20% same-day, A 10.0%,
-- B(all) 3.6% ≈ the random-bar null. Checkpoint question: does B-rest stay at
-- the null while A+ holds, and how many winners land in the collapsed band?
WITH c AS (
  SELECT DISTINCT ON (ticker, (at AT TIME ZONE 'America/New_York')::date)
         ticker, at, (meta->>'price')::numeric px, (meta->>'vol_ratio')::numeric ratio,
         (at AT TIME ZONE 'America/New_York')::date d
  FROM tier_events WHERE tier='cross' AND event='confirm' AND meta->>'signal'='reclaim'
    AND meta->>'tf'='5m' AND at >= :'seg_start' AND at < now() - interval '4 hours'
  ORDER BY ticker, (at AT TIME ZONE 'America/New_York')::date, at),
co AS (
  SELECT c.*, EXISTS (
    SELECT 1 FROM tier_events h
    WHERE h.ticker=c.ticker AND h.tier='cross' AND h.event='confirm'
      AND h.meta->>'signal'='reclaim' AND h.meta->>'tf'<>'5m'
      AND h.at BETWEEN c.at - interval '2 minutes' AND c.at + interval '2 minutes') htf
  FROM c),
o AS (
  SELECT co.*, 100*(max(coalesce(f.high, f.close))/co.px - 1) mfe
  FROM co JOIN bars_5m f ON f.ticker=co.ticker AND f.bar_ts > co.at
      AND (f.bar_ts AT TIME ZONE 'America/New_York')::date = co.d
  GROUP BY co.ticker,co.at,co.px,co.ratio,co.d,co.htf HAVING count(*) >= 4)
SELECT CASE WHEN htf AND ratio >= 20 THEN 'A+'
            WHEN htf THEN 'A'
            WHEN ratio >= 30 OR px < 2 THEN 'B-notable (visible)'
            ELSE 'B-rest (collapsed)' END tier,
       count(*) n,
       count(*) FILTER (WHERE mfe >= 20) ge20,
       round(100.0*count(*) FILTER (WHERE mfe >= 20)/count(*),1) tail_pct,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY mfe)::numeric,1) med_mfe
FROM o GROUP BY 1 ORDER BY 1;

-- ── 8. Entry mechanics: confirm-print vs pullback-hold (2026-08-02) ─────────
-- Requires OHLC (2026-07-30+). Pullback rule: first bar retracing to
-- ≤confirm×0.995 while CLOSING ≥ the reclaim price; entry = stop-buy at that
-- bar's high; setup dead on any close < reclaim before trigger; stop = the
-- pullback bar's low; same-bar target+stop counts as stop (no tick order).
-- 2-session baseline (A+/A, 48 graded): pullback available 81%, runaways
-- only 2/48 (avg +21.6% missed) — never chase the print; win-rate at +20%
-- 20.7% (pullback) vs 8.3% (confirm); BOTH ~breakeven as fixed-target
-- systems — the edge stays in selection + the discretionary exit.
WITH conf AS (
  SELECT DISTINCT ON (t.ticker, (t.at AT TIME ZONE 'America/New_York')::date)
    t.ticker, t.at,
    (t.meta->>'price')::numeric px, (t.meta->>'cross_price')::numeric cx,
    (t.at AT TIME ZONE 'America/New_York')::date d,
    EXISTS (SELECT 1 FROM tier_events h WHERE h.ticker=t.ticker AND h.tier='cross'
      AND h.event='confirm' AND h.meta->>'signal'='reclaim' AND h.meta->>'tf'<>'5m'
      AND h.at BETWEEN t.at - interval '2 minutes' AND t.at + interval '2 minutes') htf
  FROM tier_events t
  WHERE t.tier='cross' AND t.event='confirm' AND t.meta->>'signal'='reclaim'
    AND t.meta->>'tf'='5m' AND t.at >= timestamptz '2026-07-30 04:00:00-04'
  ORDER BY t.ticker, (t.at AT TIME ZONE 'America/New_York')::date, t.at),
bars AS (
  SELECT c.ticker, c.at, coalesce(b.high,b.close) hi, coalesce(b.low,b.close) lo, b.close cl,
         row_number() OVER (PARTITION BY c.ticker, c.at ORDER BY b.bar_ts) rn
  FROM conf c JOIN bars_5m b ON b.ticker=c.ticker AND b.bar_ts > c.at
    AND (b.bar_ts AT TIME ZONE 'America/New_York')::date = c.d),
pc AS (
  SELECT c.*,
    (SELECT count(*) FROM bars b WHERE b.ticker=c.ticker AND b.at=c.at) nbars,
    (SELECT max(b.hi) FROM bars b WHERE b.ticker=c.ticker AND b.at=c.at) day_hi,
    (SELECT min(b.rn) FROM bars b WHERE b.ticker=c.ticker AND b.at=c.at AND b.hi >= c.px*1.20) tgt_c,
    (SELECT min(b.rn) FROM bars b WHERE b.ticker=c.ticker AND b.at=c.at AND b.lo <= c.cx) stp_c,
    (SELECT min(b.rn) FROM bars b WHERE b.ticker=c.ticker AND b.at=c.at AND b.lo <= c.px*0.995 AND b.cl >= c.cx) b1,
    (SELECT min(b.rn) FROM bars b WHERE b.ticker=c.ticker AND b.at=c.at AND b.cl < c.cx) dead
  FROM conf c),
pb AS (
  SELECT pc.*, b1r.hi b1hi, b1r.lo b1lo,
    (SELECT min(b.rn) FROM bars b WHERE b.ticker=pc.ticker AND b.at=pc.at AND b.rn > pc.b1 AND b.hi > b1r.hi) e1
  FROM pc LEFT JOIN bars b1r ON b1r.ticker=pc.ticker AND b1r.at=pc.at AND b1r.rn=pc.b1),
res AS (
  SELECT pb.*,
    (pb.b1 IS NOT NULL AND (pb.dead IS NULL OR pb.b1 < pb.dead)) pb_avail,
    (pb.e1 IS NOT NULL AND (pb.dead IS NULL OR pb.e1 <= pb.dead)) pb_in,
    (SELECT min(b.rn) FROM bars b WHERE b.ticker=pb.ticker AND b.at=pb.at AND b.rn >= pb.e1 AND b.hi >= pb.b1hi*1.20) tgt_p,
    (SELECT min(b.rn) FROM bars b WHERE b.ticker=pb.ticker AND b.at=pb.at AND b.rn >= pb.e1 AND b.lo <= pb.b1lo) stp_p
  FROM pb)
SELECT CASE WHEN htf THEN 'A+/A (selected)' ELSE 'B (rest)' END cohort,
  count(*) FILTER (WHERE nbars>=4) graded,
  count(*) FILTER (WHERE nbars>=4 AND tgt_c IS NOT NULL AND (stp_c IS NULL OR tgt_c < stp_c)) c_target_first,
  count(*) FILTER (WHERE nbars>=4 AND stp_c IS NOT NULL AND (tgt_c IS NULL OR stp_c <= tgt_c)) c_stop_first,
  count(*) FILTER (WHERE nbars>=4 AND pb_avail) pb_setup,
  count(*) FILTER (WHERE nbars>=4 AND pb_in) pb_in,
  count(*) FILTER (WHERE nbars>=4 AND pb_in AND tgt_p IS NOT NULL AND (stp_p IS NULL OR tgt_p < stp_p)) p_target_first,
  count(*) FILTER (WHERE nbars>=4 AND pb_in AND stp_p IS NOT NULL AND (tgt_p IS NULL OR stp_p <= tgt_p)) p_stop_first,
  count(*) FILTER (WHERE nbars>=4 AND NOT pb_avail AND dead IS NULL) never_pulled_back,
  round(avg(100*(day_hi/px-1)) FILTER (WHERE nbars>=4 AND NOT pb_avail AND dead IS NULL)::numeric,1) missed_mfe_pct
FROM res GROUP BY 1 ORDER BY 1;

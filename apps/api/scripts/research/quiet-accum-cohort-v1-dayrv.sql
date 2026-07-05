-- Quiet-accumulation cohort study: first momentum appearance per (ticker, ET-day),
-- bucketed by entry state (chg vs 10%, day-relvol vs 5x), forward same-day peak
-- from our own stored cycles (same anchor class: PM+REG only).
WITH firsts AS (
  SELECT DISTINCT ON (r.ticker, (c.polled_at AT TIME ZONE 'America/New_York')::date)
    r.ticker,
    (c.polled_at AT TIME ZONE 'America/New_York')::date AS et_date,
    c.polled_at AS t0, c.session,
    r.change_pct AS chg0, r.rel_volume AS rv0
  FROM screener_results r JOIN screener_cycles c ON c.id = r.cycle_id
  WHERE c.polled_at > now() - interval '55 days'
  ORDER BY r.ticker, (c.polled_at AT TIME ZONE 'America/New_York')::date, c.polled_at
),
base AS (
  SELECT f.*,
    EXISTS (
      SELECT 1 FROM firsts p
      WHERE p.ticker = f.ticker AND p.et_date >= f.et_date - 3 AND p.et_date < f.et_date
    ) AS seen_recently
  FROM firsts f
  WHERE f.session IN ('premarket','regular')
    AND f.chg0 IS NOT NULL AND f.rv0 IS NOT NULL
),
fwd AS (
  SELECT b.ticker, b.et_date, b.t0, b.chg0, b.rv0, b.seen_recently,
    coalesce(max(r2.change_pct), b.chg0) AS peak_chg,
    min(c2.polled_at) FILTER (WHERE r2.change_pct >= 10) AS t10
  FROM base b
  LEFT JOIN screener_results r2 ON r2.ticker = b.ticker
  LEFT JOIN screener_cycles c2 ON c2.id = r2.cycle_id
    AND c2.polled_at > b.t0
    AND (c2.polled_at AT TIME ZONE 'America/New_York')::date = b.et_date
    AND c2.session IN ('premarket','regular')
  WHERE r2.cycle_id IS NULL OR c2.id IS NOT NULL
  GROUP BY 1,2,3,4,5,6
)
SELECT
  CASE WHEN chg0 < 10 AND rv0 > 5  THEN '1: QUIET+VOL (chg<10, rv>5)'
       WHEN chg0 < 10              THEN '2: quiet, low vol (chg<10, rv<=5)'
       WHEN rv0 > 5                THEN '3: hot + vol (chg>=10, rv>5)'
       ELSE                             '4: hot, low vol (chg>=10, rv<=5)' END AS bucket,
  seen_recently,
  count(*) AS n,
  round(avg(chg0)::numeric, 1) AS avg_entry_chg,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (peak_chg - chg0))::numeric, 1) AS med_fwd_pts,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY (peak_chg - chg0))::numeric, 1) AS p75_fwd_pts,
  round(100.0 * count(*) FILTER (WHERE peak_chg - chg0 >= 10) / count(*), 0) AS "pct>=+10",
  round(100.0 * count(*) FILTER (WHERE peak_chg - chg0 >= 20) / count(*), 0) AS "pct>=+20",
  round(100.0 * count(*) FILTER (WHERE peak_chg - chg0 >= 40) / count(*), 0) AS "pct>=+40",
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t10 - t0)) / 60)::numeric, 0) AS med_min_to_chg10
FROM fwd
GROUP BY 1, 2
ORDER BY 1, 2;

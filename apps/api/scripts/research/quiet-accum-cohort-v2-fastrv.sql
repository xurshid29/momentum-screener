-- v2: entry volume state from OUR fast RVol (max rel_vol_5min/rel_vol_1min over
-- the first 5 minutes — session-independent), split by session class.
WITH firsts AS (
  SELECT DISTINCT ON (r.ticker, (c.polled_at AT TIME ZONE 'America/New_York')::date)
    r.ticker,
    (c.polled_at AT TIME ZONE 'America/New_York')::date AS et_date,
    c.polled_at AS t0, c.session AS sess0,
    r.change_pct AS chg0
  FROM screener_results r JOIN screener_cycles c ON c.id = r.cycle_id
  WHERE c.polled_at > now() - interval '55 days'
  ORDER BY r.ticker, (c.polled_at AT TIME ZONE 'America/New_York')::date, c.polled_at
),
base AS (
  SELECT f.*,
    CASE WHEN f.sess0 = 'afterhours' THEN 'AH' ELSE 'PMREG' END AS sclass,
    EXISTS (
      SELECT 1 FROM firsts p
      WHERE p.ticker = f.ticker AND p.et_date >= f.et_date - 3 AND p.et_date < f.et_date
    ) AS seen_recently
  FROM firsts f
  WHERE f.sess0 IN ('premarket','regular','afterhours') AND f.chg0 IS NOT NULL
),
vol5 AS (
  SELECT b.ticker, b.et_date,
    max(greatest(coalesce(r2.rel_vol_5min, 0), coalesce(r2.rel_vol_1min, 0))) AS fast_rv
  FROM base b
  JOIN screener_results r2 ON r2.ticker = b.ticker
  JOIN screener_cycles c2 ON c2.id = r2.cycle_id
    AND c2.polled_at >= b.t0 AND c2.polled_at < b.t0 + interval '5 minutes'
  GROUP BY 1, 2
),
fwd AS (
  SELECT b.ticker, b.et_date, b.t0, b.chg0, b.sclass, b.seen_recently,
    coalesce(v.fast_rv, 0) AS fast_rv,
    coalesce(max(r2.change_pct) FILTER (
      WHERE c2.polled_at > b.t0
        AND (c2.polled_at AT TIME ZONE 'America/New_York')::date = b.et_date
        AND CASE WHEN b.sclass = 'AH' THEN c2.session = 'afterhours'
                 ELSE c2.session IN ('premarket','regular') END
    ), b.chg0) AS peak_chg
  FROM base b
  LEFT JOIN vol5 v USING (ticker, et_date)
  LEFT JOIN screener_results r2 ON r2.ticker = b.ticker
  LEFT JOIN screener_cycles c2 ON c2.id = r2.cycle_id
  GROUP BY 1, 2, 3, 4, 5, 6, 7
)
SELECT
  sclass,
  CASE WHEN chg0 < 10 AND fast_rv >= 1000 THEN '1: QUIET + strong vol (chg<10, fastRV>=10x)'
       WHEN chg0 < 10 AND fast_rv >= 300  THEN '2: quiet + mild vol (chg<10, fastRV 3-10x)'
       WHEN chg0 < 10                     THEN '3: quiet, no vol (chg<10, fastRV<3x)'
       ELSE                                    '4: hot (chg>=10)' END AS bucket,
  seen_recently,
  count(*) AS n,
  round(avg(chg0)::numeric, 1) AS avg_entry,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (peak_chg - chg0))::numeric, 1) AS med_pts,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY (peak_chg - chg0))::numeric, 1) AS p75_pts,
  round(100.0 * count(*) FILTER (WHERE peak_chg - chg0 >= 10) / count(*), 0) AS "pct>=+10",
  round(100.0 * count(*) FILTER (WHERE peak_chg - chg0 >= 20) / count(*), 0) AS "pct>=+20",
  round(100.0 * count(*) FILTER (WHERE peak_chg - chg0 >= 40) / count(*), 0) AS "pct>=+40"
FROM fwd
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

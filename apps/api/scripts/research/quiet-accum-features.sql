-- Which flag-time features separate quiet-accumulation winners from fizzles?
-- Cohort = shipped ACCUM definition over 55d; outcome = crossed +10% same
-- session-class day (promotion) and gained ≥+20pts (the money moves).
WITH firsts AS (
  SELECT DISTINCT ON (r.ticker, (c.polled_at AT TIME ZONE 'America/New_York')::date)
    r.ticker, (c.polled_at AT TIME ZONE 'America/New_York')::date AS et_date,
    c.polled_at AS t0, c.session AS sess0,
    r.change_pct AS chg0, r.float_m, r.price AS price0,
    r.rel_volume AS dayrv0, r.above_vwap
  FROM screener_results r JOIN screener_cycles c ON c.id = r.cycle_id
  WHERE c.polled_at > now() - interval '55 days'
  ORDER BY r.ticker, (c.polled_at AT TIME ZONE 'America/New_York')::date, c.polled_at
),
base AS (
  SELECT f.*, CASE WHEN f.sess0 = 'afterhours' THEN 'AH' ELSE 'PMREG' END AS sclass,
    EXISTS (SELECT 1 FROM firsts p
            WHERE p.ticker = f.ticker AND p.et_date >= f.et_date - 3 AND p.et_date < f.et_date) AS seen_recently
  FROM firsts f
  WHERE f.sess0 IN ('premarket','regular','afterhours') AND f.chg0 >= 0 AND f.chg0 < 10
),
vol5 AS (
  SELECT b.ticker, b.et_date,
    max(coalesce(r2.rel_vol_5min, 0)) AS rv5,
    max(coalesce(r2.rel_vol_1min, 0)) AS rv1,
    count(*) FILTER (WHERE greatest(coalesce(r2.rel_vol_5min,0), coalesce(r2.rel_vol_1min,0)) >= 1000) AS hot_cycles
  FROM base b
  JOIN screener_results r2 ON r2.ticker = b.ticker
  JOIN screener_cycles c2 ON c2.id = r2.cycle_id
    AND c2.polled_at >= b.t0 AND c2.polled_at < b.t0 + interval '5 minutes'
  GROUP BY 1, 2
),
cohort AS (
  SELECT b.*, v.rv5, v.rv1, v.hot_cycles
  FROM base b JOIN vol5 v USING (ticker, et_date)
  WHERE greatest(v.rv5, v.rv1) >= 1000
),
newsflag AS (
  SELECT DISTINCT co.ticker, co.et_date
  FROM cohort co
  JOIN news_ticker_links l ON l.ticker = co.ticker
  JOIN news_articles a ON a.id = l.article_id
  JOIN news_classifications nc ON nc.article_id = a.id
  WHERE nc.direction = 'bullish'
    AND a.published_at > co.t0 - interval '24 hours' AND a.published_at <= co.t0
),
outc AS (
  SELECT co.ticker, co.et_date, co.sclass, co.chg0, co.float_m, co.price0,
         co.dayrv0, co.above_vwap, co.seen_recently, co.rv5, co.rv1, co.hot_cycles,
         (nf.ticker IS NOT NULL) AS has_news,
         coalesce(max(r2.change_pct) FILTER (
           WHERE c2.polled_at > co.t0
             AND (c2.polled_at AT TIME ZONE 'America/New_York')::date = co.et_date
             AND CASE WHEN co.sclass = 'AH' THEN c2.session = 'afterhours'
                      ELSE c2.session IN ('premarket','regular') END
         ), co.chg0) AS peak
  FROM cohort co
  LEFT JOIN newsflag nf ON nf.ticker = co.ticker AND nf.et_date = co.et_date
  LEFT JOIN screener_results r2 ON r2.ticker = co.ticker
  LEFT JOIN screener_cycles c2 ON c2.id = r2.cycle_id
  GROUP BY co.ticker, co.et_date, co.sclass, co.chg0, co.float_m, co.price0,
           co.dayrv0, co.above_vwap, co.seen_recently, co.rv5, co.rv1, co.hot_cycles, nf.ticker
)
SELECT label,
  count(*) AS n,
  round(100.0 * avg((peak >= 10)::int), 0) AS pct_promote,
  round(100.0 * avg(((peak - chg0) >= 20)::int), 0) AS pct_ge20pts
FROM (
  SELECT 'BASELINE: all quiet+vol'                      AS label, * FROM outc
  UNION ALL SELECT '5min-sustained (rv5m>=1000)',          * FROM outc WHERE rv5 >= 1000
  UNION ALL SELECT '1min-spike only (rv5m<1000)',          * FROM outc WHERE rv5 < 1000
  UNION ALL SELECT 'persistent (hot in >=3 cycles/5min)',  * FROM outc WHERE hot_cycles >= 3
  UNION ALL SELECT 'transient (hot in <3 cycles)',         * FROM outc WHERE hot_cycles < 3
  UNION ALL SELECT 'float < 5M',                           * FROM outc WHERE float_m < 5
  UNION ALL SELECT 'float 5-25M',                          * FROM outc WHERE float_m >= 5 AND float_m < 25
  UNION ALL SELECT 'float >= 25M / null',                  * FROM outc WHERE float_m >= 25 OR float_m IS NULL
  UNION ALL SELECT 'price < $1',                           * FROM outc WHERE price0 < 1
  UNION ALL SELECT 'price $1-5',                           * FROM outc WHERE price0 >= 1 AND price0 < 5
  UNION ALL SELECT 'price >= $5',                          * FROM outc WHERE price0 >= 5
  UNION ALL SELECT 'day-RVol >= 2x at flag',               * FROM outc WHERE dayrv0 >= 2
  UNION ALL SELECT 'day-RVol < 2x at flag',                * FROM outc WHERE dayrv0 < 2 OR dayrv0 IS NULL
  UNION ALL SELECT 'bullish news <=24h before',            * FROM outc WHERE has_news
  UNION ALL SELECT 'no bullish news',                      * FROM outc WHERE NOT has_news
  UNION ALL SELECT 'above VWAP at flag',                   * FROM outc WHERE above_vwap IS TRUE
  UNION ALL SELECT 'below VWAP at flag',                   * FROM outc WHERE above_vwap IS FALSE
  UNION ALL SELECT 'entry chg 5-10%',                      * FROM outc WHERE chg0 >= 5
  UNION ALL SELECT 'entry chg 0-5%',                       * FROM outc WHERE chg0 < 5
  UNION ALL SELECT 'seen on screens last 3d',              * FROM outc WHERE seen_recently
  UNION ALL SELECT 'fresh (not seen 3d)',                  * FROM outc WHERE NOT seen_recently
  UNION ALL SELECT 'COMBO: sustained + news',              * FROM outc WHERE rv5 >= 1000 AND has_news
  UNION ALL SELECT 'COMBO: sustained + dayRV>=2',          * FROM outc WHERE rv5 >= 1000 AND dayrv0 >= 2
  UNION ALL SELECT 'COMBO: sustained + chg5-10 + <25M',    * FROM outc WHERE rv5 >= 1000 AND chg0 >= 5 AND float_m < 25
) t
GROUP BY label
ORDER BY pct_ge20pts DESC, n DESC;

-- Conditional EMA/MACD study: detections (momentum ∪ ignition, first per ticker/ET-day)
-- with the best bullish pre-detection article (≤24h before) left-joined.
WITH det AS (
  SELECT ticker, et_date, min(first_det) AS first_det
  FROM (
    SELECT r.ticker,
           (c.polled_at AT TIME ZONE 'America/New_York')::date AS et_date,
           min(c.polled_at) AS first_det
    FROM screener_results r JOIN screener_cycles c ON c.id = r.cycle_id
    WHERE c.polled_at > now() - interval '55 days'
    GROUP BY 1, 2
    UNION ALL
    SELECT i.ticker,
           (c.polled_at AT TIME ZONE 'America/New_York')::date,
           min(c.polled_at)
    FROM ignition_results i JOIN screener_cycles c ON c.id = i.cycle_id
    WHERE c.polled_at > now() - interval '55 days'
    GROUP BY 1, 2
  ) u
  GROUP BY 1, 2
),
cat AS (
  SELECT DISTINCT ON (d.ticker, d.et_date)
    d.ticker, d.et_date,
    a.published_at,
    nc.impact_score, nc.hype_score, nc.urgency, nc.catalyst_type,
    a.source
  FROM det d
  JOIN news_ticker_links l ON l.ticker = d.ticker
  JOIN news_articles a ON a.id = l.article_id
  JOIN news_classifications nc ON nc.article_id = a.id
  WHERE nc.direction = 'bullish'
    AND a.published_at >  d.first_det - interval '24 hours'
    AND a.published_at <= d.first_det
  ORDER BY d.ticker, d.et_date, nc.impact_score DESC NULLS LAST, a.published_at DESC
)
SELECT d.ticker,
       d.et_date,
       extract(epoch FROM d.first_det)::bigint  AS det_ts,
       extract(epoch FROM c2.published_at)::bigint AS news_ts,
       c2.impact_score, c2.hype_score, c2.urgency, c2.catalyst_type, c2.source
FROM det d
LEFT JOIN cat c2 USING (ticker, et_date)
ORDER BY d.et_date, d.ticker;

import { Router } from 'express';
import { sql } from 'kysely';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { universe } from '../services/universe.js';
import { getOrClassifyArticle } from '../services/classify-article.js';

const router = Router();

// Shared shape for the per-article catalyst column that comes back with
// each news row. `null` when nothing has classified the article yet.
const CLASSIFICATION_COLUMNS = [
  'c.impact_score',
  'c.urgency',
  'c.direction',
  'c.catalyst_type',
  'c.materiality',
  'c.confidence',
  'c.reason',
  'c.risk_flags',
  'c.classifier',
] as const;

// Subquery that aggregates the article's ticker links into a sorted array.
// When a filter is given, the array is intersected with the filter — so a
// Benzinga article tagged to AAPL + a universe ticker only surfaces the
// universe ticker, not the AAPL noise.
function tickersAggExpr(filter: string[] | null) {
  if (!filter) {
    return sql<string[]>`COALESCE((SELECT array_agg(ticker ORDER BY ticker) FROM news_ticker_links WHERE article_id = a.id), '{}'::text[])`.as('tickers');
  }
  return sql<string[]>`COALESCE((SELECT array_agg(ticker ORDER BY ticker) FROM news_ticker_links WHERE article_id = a.id AND ticker = ANY(${filter}::text[])), '{}'::text[])`.as('tickers');
}

// GET /api/news?ticker=X&limit=N — per-ticker news for today (ET).
// Restricted to the current America/New_York date so the Quote Details panel
// doesn't surface stale prior-day headlines on intraday-momentum tickers.
router.get('/', authMiddleware, async (req, res) => {
  const ticker = typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : null;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const db = getDb();
  const tickerFilter = ticker ? [ticker] : null;
  let q = db
    .selectFrom('news_articles as a')
    .leftJoin('news_classifications as c', 'c.article_id', 'a.id')
    .select([
      'a.id', 'a.source', 'a.url', 'a.title', 'a.published_at', 'a.fetched_at',
      tickersAggExpr(tickerFilter),
      ...CLASSIFICATION_COLUMNS,
    ])
    .where(sql<boolean>`(a.published_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`)
    .orderBy('a.published_at', 'desc')
    .limit(limit);
  if (ticker) {
    q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM news_ticker_links WHERE article_id = a.id AND ticker = ${ticker})`);
  }
  const rows = await q.execute();
  res.json({ data: rows.map(shapeNewsRow) });
});

// GET /api/news/feed?tickers=A,B,C&universe=true&hours=N&limit=N — latest news.
// Filtering is intersected:
//   - tickers (comma-separated) → restrict to articles linked to any of these
//   - universe=true             → restrict to UniverseService.getUniverse()
//                                 (structural filter without momentum gates)
// Both can be combined; both omitted → unfiltered feed. `hours` defaults to 24
// to keep the universe payload bounded since the universe set is ~2k tickers.
router.get('/feed', authMiddleware, async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const tickersParam = typeof req.query.tickers === 'string' ? req.query.tickers : '';
  const tickerList = tickersParam
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  const useUniverse = req.query.universe === 'true' || req.query.universe === '1';
  const hours = Math.min(Math.max(parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 168);

  // Intersect ticker filters: explicit list AND universe set, when both given.
  let effectiveTickers: string[] | null = null;
  if (useUniverse) {
    const uni = universe.getUniverse();
    if (tickerList.length > 0) {
      effectiveTickers = tickerList.filter((t) => uni.has(t));
    } else {
      effectiveTickers = Array.from(uni);
    }
    // Universe not yet loaded → return empty rather than the full firehose.
    if (effectiveTickers.length === 0) {
      res.json({ data: [] });
      return;
    }
  } else if (tickerList.length > 0) {
    effectiveTickers = tickerList;
  }

  const db = getDb();
  let q = db
    .selectFrom('news_articles as a')
    .leftJoin('news_classifications as c', 'c.article_id', 'a.id')
    .select([
      'a.id', 'a.source', 'a.url', 'a.title', 'a.published_at', 'a.fetched_at',
      tickersAggExpr(effectiveTickers),
      ...CLASSIFICATION_COLUMNS,
    ])
    .orderBy('a.published_at', 'desc')
    .limit(limit);

  if (effectiveTickers) {
    const tickerArr = effectiveTickers;
    q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM news_ticker_links WHERE article_id = a.id AND ticker = ANY(${tickerArr}::text[]))`);
  }

  if (useUniverse) {
    // Bound the scan when the ticker set is large (~2k); otherwise the orderBy
    // limit query may walk the full news_articles index.
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    q = q.where('a.published_at', '>=', cutoff);
  }

  const rows = await q.execute();
  res.json({ data: rows.map(shapeNewsRow) });
});

// POST /api/news/:articleId/classify — synchronous on-demand classifier.
// If the article is already classified, returns the cached result with
// `cached: true`. Otherwise spends an OpenAI call (or falls back to rules
// if OpenAI is unavailable) and persists the result before returning.
router.post('/:articleId/classify', authMiddleware, async (req, res) => {
  const articleId = req.params.articleId;
  if (!articleId || typeof articleId !== 'string') {
    res.status(400).json({ error: 'invalid article id' });
    return;
  }
  try {
    const result = await getOrClassifyArticle(articleId);
    if (!result) {
      res.status(404).json({ error: 'article not found' });
      return;
    }
    res.json({ data: result });
  } catch (err) {
    console.error('[news/classify] failed:', err);
    res.status(500).json({ error: 'classification failed' });
  }
});

interface NewsRowDbShape {
  id: string;
  source: string;
  url: string;
  title: string;
  published_at: Date | string | null;
  fetched_at: Date | string;
  tickers: string[] | null;
  impact_score: number | null;
  urgency: string | null;
  direction: string | null;
  catalyst_type: string | null;
  materiality: string | null;
  confidence: string | number | null; // pg numeric returns as string sometimes
  reason: string | null;
  risk_flags: unknown;
  classifier: string | null;
}

function shapeNewsRow(r: NewsRowDbShape) {
  const hasClassification = r.impact_score != null && r.classifier != null;
  return {
    id: r.id,
    source: r.source,
    url: r.url,
    title: r.title,
    published_at: r.published_at,
    fetched_at: r.fetched_at,
    tickers: Array.isArray(r.tickers) ? r.tickers : [],
    classification: hasClassification
      ? {
          impact_score: r.impact_score,
          urgency: r.urgency,
          direction: r.direction,
          catalyst_type: r.catalyst_type,
          materiality: r.materiality,
          confidence: r.confidence != null ? Number(r.confidence) : null,
          reason: r.reason,
          risk_flags: Array.isArray(r.risk_flags) ? r.risk_flags : [],
          classifier: r.classifier,
        }
      : null,
  };
}

export default router;

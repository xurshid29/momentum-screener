import { Router } from 'express';
import { sql } from 'kysely';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { universe } from '../services/universe.js';
import { getOrClassifyArticle } from '../services/classify-article.js';
import { fetchAndStoreTickerNews } from '../services/ticker-news.js';

const router = Router();

// Shared shape for the per-article catalyst column that comes back with
// each news row. `null` when nothing has classified the article yet.
const CLASSIFICATION_COLUMNS = [
  'c.impact_score',
  'c.hype_score',
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

// GET /api/news?ticker=X&limit=N&days=D — per-ticker news.
// `days` is the ET-calendar-day lookback: days=1 (default) is today only —
// the intraday-momentum behavior, so a fast mover's panel doesn't surface
// stale prior-day headlines. Multi-day callers (the Continuation / Swing
// context, where a 2–3-day-old catalyst still drives the move) pass a larger
// window: days=4 shows today plus the previous 3 ET calendar days, so a
// Friday headline is still visible the following Monday.
router.get('/', authMiddleware, async (req, res) => {
  const ticker = typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : null;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  // Clamp days to [1, 30] — a calendar-day count, not an interval; 1 = today.
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '1'), 10) || 1, 1), 30);
  const db = getDb();
  // On-demand top-up: the poller only ingests news for tickers currently in
  // the screener universe, so a ticker that has dropped off (or any watchlist
  // name) goes stale in our DB while Finviz/Yahoo still carry fresh items.
  // Pull this ticker's recent multi-day news live (rate-bounded per ticker)
  // before reading, so clicking any ticker surfaces the last few days. Best-
  // effort — a failure just falls back to whatever's already stored.
  if (ticker) {
    try {
      await fetchAndStoreTickerNews(ticker);
    } catch {
      // ignore — read what we have
    }
  }
  const tickerFilter = ticker ? [ticker] : null;
  let q = db
    .selectFrom('news_articles as a')
    .leftJoin('news_classifications as c', 'c.article_id', 'a.id')
    .select([
      'a.id', 'a.source', 'a.url', 'a.title', 'a.published_at', 'a.fetched_at',
      tickersAggExpr(tickerFilter),
      ...CLASSIFICATION_COLUMNS,
    ])
    // ≥ midnight ET of the first included day (today_ET − (days−1)). days=1
    // collapses to "on or after today's ET midnight" = today only. The `::int`
    // cast is load-bearing: Kysely binds ${days-1} as an untyped parameter, and
    // `date - unknown` has no operator (Postgres 42883) — without the cast every
    // per-ticker news call 500s.
    .where(sql<boolean>`(a.published_at AT TIME ZONE 'America/New_York')::date >= ((now() AT TIME ZONE 'America/New_York')::date - ${days - 1}::int)`)
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
  hype_score: number | null;
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
          hype_score: r.hype_score,
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

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { universe } from '../services/universe.js';

const router = Router();

// GET /api/news?ticker=X&limit=N — per-ticker news history.
router.get('/', authMiddleware, async (req, res) => {
  const ticker = typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : null;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const db = getDb();
  let q = db
    .selectFrom('news_articles as a')
    .innerJoin('news_ticker_links as l', 'l.article_id', 'a.id')
    .select(['a.id', 'a.source', 'a.url', 'a.title', 'a.published_at', 'a.fetched_at', 'l.ticker'])
    .orderBy('a.published_at', 'desc')
    .limit(limit);
  if (ticker) q = q.where('l.ticker', '=', ticker);
  const rows = await q.execute();
  res.json({ data: rows });
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
    .innerJoin('news_ticker_links as l', 'l.article_id', 'a.id')
    .select(['a.id', 'a.source', 'a.url', 'a.title', 'a.published_at', 'a.fetched_at', 'l.ticker'])
    .orderBy('a.published_at', 'desc')
    .limit(limit);

  if (effectiveTickers) {
    q = q.where('l.ticker', 'in', effectiveTickers);
  }

  if (useUniverse) {
    // Bound the scan when the ticker set is large (~2k); otherwise the orderBy
    // limit query may walk the full news_articles index.
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    q = q.where('a.published_at', '>=', cutoff);
  }

  const rows = await q.execute();
  res.json({ data: rows });
});

export default router;

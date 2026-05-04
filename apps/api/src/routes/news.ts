import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';

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

// GET /api/news/feed?tickers=A,B,C&limit=N — latest news.
// When `tickers` is supplied (comma-separated), the result is filtered to
// articles linked to any of those tickers. Empty/missing → unfiltered feed.
router.get('/feed', authMiddleware, async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const tickersParam = typeof req.query.tickers === 'string' ? req.query.tickers : '';
  const tickerList = tickersParam
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  const db = getDb();
  let q = db
    .selectFrom('news_articles as a')
    .innerJoin('news_ticker_links as l', 'l.article_id', 'a.id')
    .select(['a.id', 'a.source', 'a.url', 'a.title', 'a.published_at', 'a.fetched_at', 'l.ticker'])
    .orderBy('a.published_at', 'desc')
    .limit(limit);

  if (tickerList.length > 0) {
    q = q.where('l.ticker', 'in', tickerList);
  }

  const rows = await q.execute();
  res.json({ data: rows });
});

export default router;

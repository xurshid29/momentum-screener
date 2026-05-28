import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { authService } from '../services/auth.js';
import { poller } from '../services/poller.js';
import { dailyBars, getRecentBars } from '../services/daily-bars.js';
import { addClient } from '../services/sse.js';
import { getDb } from '../db/index.js';

const router = Router();

// GET /api/screener/latest — last cycle's payload from memory.
router.get('/latest', authMiddleware, (_req, res) => {
  const p = poller.getLastPayload();
  if (!p) {
    return res.json({ data: { rows: [], polled_at: null, config: poller.getConfig(), banners: { new_with_catalyst: [], fresh_news: [] }, fresh_news: [] } });
  }
  res.json({ data: p });
});

// GET /api/screener/cycles — paginated history.
router.get('/cycles', authMiddleware, async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const before = typeof req.query.before === 'string' ? req.query.before : null;
  const db = getDb();
  let q = db
    .selectFrom('screener_cycles')
    .select(['id', 'polled_at', 'row_count', 'filter_snapshot'])
    .orderBy('polled_at', 'desc')
    .limit(limit);
  if (before) q = q.where('polled_at', '<', new Date(before));
  const cycles = await q.execute();
  res.json({ data: cycles });
});

// GET /api/screener/history?ticker=X&limit=N
// Per-ticker historical appearances joined with cycle timestamps.
router.get('/history', authMiddleware, async (req, res) => {
  const ticker = typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : null;
  if (!ticker) return res.status(400).json({ error: 'ticker query param required' });
  const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
  const db = getDb();
  const rows = await db
    .selectFrom('screener_results as r')
    .innerJoin('screener_cycles as c', 'c.id', 'r.cycle_id')
    .select([
      'r.id', 'r.ticker', 'r.change_pct', 'r.float_m', 'r.float_is_proxy', 'r.price', 'r.volume',
      'r.avg_volume', 'r.rel_volume', 'r.vol_5min', 'r.rel_vol_5min',
      'r.mcap_m', 'r.country', 'r.company', 'r.sector', 'r.industry',
      'r.short_float_pct', 'r.short_ratio',
      'r.insider_own_pct', 'r.insider_trans_pct',
      'r.inst_own_pct', 'r.inst_trans_pct',
      'r.shares_out_m',
      'r.status', 'r.prev_change_pct', 'r.accel_delta',
      'c.polled_at', 'c.id as cycle_id',
    ])
    .where('r.ticker', '=', ticker)
    .orderBy('c.polled_at', 'desc')
    .limit(limit)
    .execute();
  res.json({ data: rows });
});

// GET /api/screener/ignition-history?ticker=X&limit=N
// Per-ticker history from the Ignition screener. Same access pattern as
// /history above, but reads ignition_results — so it covers volume-led
// sub-$1 names that never met the Momentum filter. Useful for inspecting
// how runner_score evolved cycle-by-cycle around a move.
router.get('/ignition-history', authMiddleware, async (req, res) => {
  const ticker = typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : null;
  if (!ticker) return res.status(400).json({ error: 'ticker query param required' });
  const limit = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1000);
  const db = getDb();
  const rows = await db
    .selectFrom('ignition_results as i')
    .innerJoin('screener_cycles as c', 'c.id', 'i.cycle_id')
    .select([
      'i.id', 'i.ticker', 'i.runner_score', 'i.score_breakdown',
      'i.price', 'i.change_pct', 'i.float_m',
      'i.rel_volume', 'i.rel_vol_5min',
      'i.catalyst_score', 'i.news_source', 'i.shelf_level',
      'c.polled_at', 'c.session', 'c.id as cycle_id',
    ])
    .where('i.ticker', '=', ticker)
    .orderBy('c.polled_at', 'desc')
    .limit(limit)
    .execute();
  res.json({ data: rows });
});

// POST /api/screener/swing/backfill
// Enqueue tickers for daily-bar backfill in the DailyBarsService. Either an
// explicit list (`{ tickers: ['AAPL', ...] }`) or no body to seed from the
// current Momentum + Ignition payloads. Returns service status immediately —
// fetches drain on the service's own ~1s timer, max ~250 bars per ticker per
// fetch. Used to bootstrap before the periodic Swing-universe scan lands.
const backfillSchema = z.object({
  tickers: z.array(z.string().min(1).max(16)).max(500).optional(),
});
router.post('/swing/backfill', authMiddleware, (req, res) => {
  const parsed = backfillSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  let tickers = parsed.data.tickers ?? [];
  if (tickers.length === 0) {
    const p = poller.getLastPayload();
    const seen = new Set<string>();
    for (const r of p?.rows ?? []) seen.add(r.ticker);
    for (const r of p?.ignition ?? []) seen.add(r.ticker);
    tickers = [...seen];
  }
  dailyBars.trackUniverse(tickers);
  res.json({ data: { enqueued: tickers.length, status: dailyBars.status() } });
});

// GET /api/screener/swing/bars?ticker=X&days=N
// Read back the persisted daily bars for one ticker. Useful for verifying a
// backfill landed and for ad-hoc inspection. Returns bars in ascending date
// order, which is what the (forthcoming) swing-score expects.
router.get('/swing/bars', authMiddleware, async (req, res) => {
  const ticker = typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase() : null;
  if (!ticker) return res.status(400).json({ error: 'ticker query param required' });
  const days = Math.min(parseInt(String(req.query.days ?? '250'), 10) || 250, 1000);
  const bars = await getRecentBars(ticker, days);
  res.json({ data: bars });
});

// GET /api/screener/cycles/:id/results
router.get('/cycles/:id/results', authMiddleware, async (req, res) => {
  const db = getDb();
  const rows = await db
    .selectFrom('screener_results')
    .selectAll()
    .where('cycle_id', '=', req.params.id)
    .execute();
  res.json({ data: rows });
});

// PATCH /api/screener/config — adjust filter live.
const configSchema = z.object({
  filter: z.string().optional(),
  float_max_m: z.number().positive().optional(),
  top_n: z.number().int().positive().max(200).optional(),
  accel_threshold: z.number().nonnegative().optional(),
  interval_sec: z.number().int().min(5).max(300).optional(),
});
router.patch('/config', authMiddleware, (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  poller.setConfig(parsed.data);
  res.json({ data: poller.getConfig() });
});

// GET /api/screener/stream — SSE.
// Token must be passed as ?token=... since EventSource can't set headers.
router.get('/stream', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    authService.verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  const cleanup = addClient(res);
  // Push the most recent payload immediately so a fresh subscriber doesn't
  // wait up to 20s for first paint.
  const last = poller.getLastPayload();
  if (last) {
    res.write(`event: cycle\ndata: ${JSON.stringify(last)}\n\n`);
  }
  req.on('close', cleanup);
});

export default router;

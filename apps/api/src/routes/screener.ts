import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { authService } from '../services/auth.js';
import { poller } from '../services/poller.js';
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
      'r.id', 'r.ticker', 'r.change_pct', 'r.float_m', 'r.price', 'r.volume',
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

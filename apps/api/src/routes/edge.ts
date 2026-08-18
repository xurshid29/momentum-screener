import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { edge } from '../services/edge.js';
import { tickfeed } from '../services/tickfeed.js';

const router = Router();

const tickerSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9.-]{1,12}$/);
const presetSchema = z.object({
  ema_fast: z.number().int().min(2).max(499),
  ema_slow: z.number().int().min(3).max(500),
  proximity_pct: z.number().min(0.05).max(10).default(0.75),
  stop_buffer_pct: z.number().min(0).max(10).default(0.5),
  alert_armed: z.boolean().default(true),
  alert_entry: z.boolean().default(true),
  alert_bailout: z.boolean().default(true),
  telegram_enabled: z.boolean().default(true),
  active: z.boolean().default(true),
}).refine((v) => v.ema_fast < v.ema_slow, {
  message: 'ema_fast must be lower than ema_slow', path: ['ema_fast'],
});

// A separate authenticated REST surface is deliberate: Edge presets are
// per-user and must not be broadcast through the dashboard's shared SSE.
router.get('/', authMiddleware, (req, res) => {
  const userId = req.user!.userId;
  res.json({ data: {
    rows: edge.getSnapshots(userId),
    events: edge.getRecentEvents(userId),
    server_time: new Date().toISOString(),
  } });
});

router.get('/events', authMiddleware, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
  const rows = await getDb()
    .selectFrom('edge_events')
    .selectAll()
    .where('user_id', '=', req.user!.userId)
    .orderBy('at', 'desc')
    .limit(limit)
    .execute();
  res.json({ data: rows });
});

router.put('/:ticker', authMiddleware, async (req, res) => {
  const parsedTicker = tickerSchema.safeParse(req.params.ticker);
  const parsed = presetSchema.safeParse(req.body);
  if (!parsedTicker.success || !parsed.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: !parsedTicker.success ? parsedTicker.error.errors : parsed.success ? [] : parsed.error.errors,
    });
  }
  const ticker = parsedTicker.data;
  const p = parsed.data;
  await getDb()
    .insertInto('user_edge_presets')
    .values({ user_id: req.user!.userId, ticker, ...p })
    .onConflict((oc) => oc.columns(['user_id', 'ticker']).doUpdateSet({
      ...p,
      updated_at: sql`current_timestamp` as unknown as Date,
    }))
    .execute();
  await edge.reloadPreset(req.user!.userId, ticker);
  if (p.active) tickfeed.ensureSubscribed(ticker);
  const row = edge.getSnapshots(req.user!.userId).find((x) => x.ticker === ticker) ?? null;
  res.json({ data: row });
});

router.post('/:ticker/reset', authMiddleware, (req, res) => {
  const parsed = tickerSchema.safeParse(req.params.ticker);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid ticker' });
  if (!edge.reset(req.user!.userId, parsed.data)) return res.status(404).json({ error: 'Edge preset not found' });
  res.json({ data: { ok: true } });
});

router.delete('/:ticker', authMiddleware, async (req, res) => {
  const parsed = tickerSchema.safeParse(req.params.ticker);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid ticker' });
  await getDb()
    .deleteFrom('user_edge_presets')
    .where('user_id', '=', req.user!.userId)
    .where('ticker', '=', parsed.data)
    .execute();
  await edge.reloadPreset(req.user!.userId, parsed.data);
  res.json({ data: { ok: true } });
});

export default router;

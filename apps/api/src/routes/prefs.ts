import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { sql } from 'kysely';

const router = Router();

// ─── filter presets ────────────────────────────────────────────────────────
const filterSchema = z.object({
  filter: z.string(),
  float_max_m: z.number().positive(),
  top_n: z.number().int().positive().max(200),
  accel_threshold: z.number().nonnegative(),
  interval_sec: z.number().int().min(5).max(300),
});
const presetSchema = z.object({
  name: z.string().min(1).max(64),
  filter: filterSchema,
  is_default: z.boolean().optional(),
});

router.get('/filters', authMiddleware, async (req, res) => {
  const db = getDb();
  const rows = await db
    .selectFrom('user_filter_presets')
    .selectAll()
    .where('user_id', '=', req.user!.userId)
    .orderBy('created_at', 'desc')
    .execute();
  res.json({ data: rows });
});

router.post('/filters', authMiddleware, async (req, res) => {
  const parsed = presetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  const db = getDb();
  await db.transaction().execute(async (trx) => {
    if (parsed.data.is_default) {
      await trx
        .updateTable('user_filter_presets')
        .set({ is_default: false })
        .where('user_id', '=', req.user!.userId)
        .execute();
    }
    await trx
      .insertInto('user_filter_presets')
      .values({
        user_id: req.user!.userId,
        name: parsed.data.name,
        filter: JSON.stringify(parsed.data.filter),
        is_default: parsed.data.is_default ?? false,
      })
      .execute();
  });
  res.status(201).json({ data: { ok: true } });
});

router.delete('/filters/:id', authMiddleware, async (req, res) => {
  const db = getDb();
  await db
    .deleteFrom('user_filter_presets')
    .where('user_id', '=', req.user!.userId)
    .where('id', '=', req.params.id)
    .execute();
  res.json({ data: { ok: true } });
});

// ─── chart slot prefs ──────────────────────────────────────────────────────
const chartPrefSchema = z.object({
  slot: z.number().int().min(1).max(4),
  ticker: z.string().nullable(),
  interval: z.string().min(1).max(8),
  follow_selection: z.boolean(),
});

router.get('/charts', authMiddleware, async (req, res) => {
  const db = getDb();
  const rows = await db
    .selectFrom('user_chart_prefs')
    .selectAll()
    .where('user_id', '=', req.user!.userId)
    .orderBy('slot', 'asc')
    .execute();
  res.json({ data: rows });
});

router.put('/charts', authMiddleware, async (req, res) => {
  const arr = z.array(chartPrefSchema).safeParse(req.body);
  if (!arr.success) return res.status(400).json({ error: 'Validation failed', details: arr.error.errors });
  const db = getDb();
  await db.transaction().execute(async (trx) => {
    for (const p of arr.data) {
      await trx
        .insertInto('user_chart_prefs')
        .values({
          user_id: req.user!.userId,
          slot: p.slot,
          ticker: p.ticker,
          interval: p.interval,
          follow_selection: p.follow_selection,
        })
        .onConflict((oc) =>
          oc.columns(['user_id', 'slot']).doUpdateSet({
            ticker: p.ticker,
            interval: p.interval,
            follow_selection: p.follow_selection,
          }),
        )
        .execute();
    }
  });
  res.json({ data: { ok: true } });
});

// ─── hidden tickers (per-user, ET-day) ─────────────────────────────────────
// Users can hide tickers from their screener view for the current ET day —
// e.g. tickers their broker won't let them trade. Auto-clears at midnight ET
// since the GET only returns rows with hidden_date = today, and any stale
// rows get garbage-collected by the same endpoint.
function etDateString(dt: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(dt);
}

router.get('/hidden-tickers', authMiddleware, async (req, res) => {
  const db = getDb();
  const today = etDateString(new Date());
  // Opportunistic cleanup — anything from a previous ET day is dead weight.
  await db
    .deleteFrom('user_hidden_tickers')
    .where('user_id', '=', req.user!.userId)
    .where('hidden_date', '<', today)
    .execute();
  const rows = await db
    .selectFrom('user_hidden_tickers')
    .select('ticker')
    .where('user_id', '=', req.user!.userId)
    .where('hidden_date', '=', today)
    .execute();
  res.json({ data: rows.map((r) => r.ticker) });
});

const hideSchema = z.object({ ticker: z.string().min(1).max(10) });

router.post('/hidden-tickers', authMiddleware, async (req, res) => {
  const parsed = hideSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  const ticker = parsed.data.ticker.toUpperCase();
  const today = etDateString(new Date());
  const db = getDb();
  await db
    .insertInto('user_hidden_tickers')
    .values({ user_id: req.user!.userId, ticker, hidden_date: today })
    .onConflict((oc) => oc.columns(['user_id', 'ticker', 'hidden_date']).doNothing())
    .execute();
  res.status(201).json({ data: { ticker } });
});

router.delete('/hidden-tickers/:ticker', authMiddleware, async (req, res) => {
  const ticker = String(req.params.ticker).toUpperCase();
  const today = etDateString(new Date());
  const db = getDb();
  await db
    .deleteFrom('user_hidden_tickers')
    .where('user_id', '=', req.user!.userId)
    .where('ticker', '=', ticker)
    .where('hidden_date', '=', today)
    .execute();
  res.json({ data: { ok: true } });
});

// ─── watchlist / favorites (per-user, expiring) ────────────────────────────
// The "add it while the market's closed, analyze it, act at the open" list.
// Each entry carries a free-text note + an expiry date; expired entries are
// auto-removed (ET-day cleanup on GET, same pattern as hidden-tickers above).
const watchlistSchema = z.object({
  ticker: z.string().min(1).max(10),
  note: z.string().max(500).optional(),
  // YYYY-MM-DD (an ET calendar date). The entry stays through that day.
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

router.get('/watchlist', authMiddleware, async (req, res) => {
  const db = getDb();
  const today = etDateString(new Date());
  // Opportunistic cleanup — drop anything whose expiry day has passed.
  await db
    .deleteFrom('user_watchlist')
    .where('user_id', '=', req.user!.userId)
    .where('expires_at', '<', today)
    .execute();
  const rows = await db
    .selectFrom('user_watchlist')
    .select(['ticker', 'note', 'expires_at', 'created_at'])
    .where('user_id', '=', req.user!.userId)
    .orderBy('expires_at', 'asc')   // soonest-expiring first
    .orderBy('created_at', 'desc')
    .execute();
  res.json({ data: rows });
});

router.post('/watchlist', authMiddleware, async (req, res) => {
  const parsed = watchlistSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  const ticker = parsed.data.ticker.toUpperCase();
  const today = etDateString(new Date());
  // Reject an already-past expiry outright — it'd be cleaned up immediately.
  if (parsed.data.expires_at < today) {
    return res.status(400).json({ error: 'expires_at is in the past' });
  }
  const db = getDb();
  // Upsert: re-adding a ticker updates its note/expiry rather than erroring.
  await db
    .insertInto('user_watchlist')
    .values({
      user_id: req.user!.userId,
      ticker,
      note: parsed.data.note ?? null,
      expires_at: parsed.data.expires_at,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'ticker']).doUpdateSet({
        note: parsed.data.note ?? null,
        expires_at: parsed.data.expires_at,
        updated_at: sql`current_timestamp` as unknown as Date,
      }),
    )
    .execute();
  res.status(201).json({ data: { ticker } });
});

router.delete('/watchlist/:ticker', authMiddleware, async (req, res) => {
  const ticker = String(req.params.ticker).toUpperCase();
  const db = getDb();
  await db
    .deleteFrom('user_watchlist')
    .where('user_id', '=', req.user!.userId)
    .where('ticker', '=', ticker)
    .execute();
  res.json({ data: { ok: true } });
});

// ─── panel layout (free-form jsonb) ────────────────────────────────────────
router.get('/layout', authMiddleware, async (req, res) => {
  const db = getDb();
  const row = await db
    .selectFrom('user_panel_layout')
    .selectAll()
    .where('user_id', '=', req.user!.userId)
    .executeTakeFirst();
  res.json({ data: row?.layout ?? null });
});

router.put('/layout', authMiddleware, async (req, res) => {
  const layout = req.body;
  if (typeof layout !== 'object' || layout === null) {
    return res.status(400).json({ error: 'Layout must be a JSON object' });
  }
  const db = getDb();
  await db
    .insertInto('user_panel_layout')
    .values({
      user_id: req.user!.userId,
      layout: JSON.stringify(layout),
      updated_at: sql`current_timestamp` as unknown as Date,
    })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({
        layout: JSON.stringify(layout),
        updated_at: sql`current_timestamp` as unknown as Date,
      }),
    )
    .execute();
  res.json({ data: { ok: true } });
});

export default router;

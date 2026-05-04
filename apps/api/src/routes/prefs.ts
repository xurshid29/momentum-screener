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

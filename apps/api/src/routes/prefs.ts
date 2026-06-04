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
// Tickers are added with a one-click star from any row (no form); each entry
// carries an expiry date (default +2 ET days, editable per row) and surfaces
// its most recent catalyst + a "new news" flag. Expired entries auto-remove
// (ET-day cleanup on GET, same pattern as hidden-tickers above).

// How many ET days out the default expiry sits when adding via the star.
const WATCHLIST_DEFAULT_EXPIRY_DAYS = 2;
// News lookup window — match the per-ticker news panel's multi-day window so a
// swing catalyst still shows on the watchlist row. 7 days so a Wednesday
// catalyst viewed over the following weekend isn't dropped (the AGPU case).
const WATCHLIST_NEWS_DAYS = 7;

// expires_at optional on add (defaults to +2d); note kept optional for back-
// compat but the UI no longer sends it.
const watchlistAddSchema = z.object({
  ticker: z.string().min(1).max(10),
  note: z.string().max(500).optional(),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
// PATCH just the expiry (the per-row date editor).
const watchlistExpirySchema = z.object({
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// today_ET + n days, as YYYY-MM-DD.
function etDatePlusDays(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return etDateString(d);
}

router.get('/watchlist', authMiddleware, async (req, res) => {
  const db = getDb();
  const today = etDateString(new Date());
  // Opportunistic cleanup — drop anything whose expiry day has passed.
  await db
    .deleteFrom('user_watchlist')
    .where('user_id', '=', req.user!.userId)
    .where('expires_at', '<', today)
    .execute();
  // Each entry + its most recent article within the news window (+ that
  // article's classification) and a has_new_news flag = the article landed
  // after the user last viewed this entry's news (or after adding it). Mirrors
  // the Continuation builder's recent_news join.
  const rows = await sql<{
    ticker: string;
    note: string | null;
    expires_at: string;
    created_at: string;
    news_seen_at: string | null;
    news_title: string | null;
    news_url: string | null;
    news_source: string | null;
    news_published_at: string | null;
    catalyst_score: number | null;
    catalyst_direction: string | null;
    catalyst_urgency: string | null;
    catalyst_type: string | null;
    catalyst_reason: string | null;
    has_new_news: boolean;
  }>`
    with wl as (
      select ticker, note, expires_at::text, created_at, news_seen_at
      from user_watchlist
      where user_id = ${req.user!.userId}
    ),
    recent_news as (
      select distinct on (ntl.ticker)
             ntl.ticker,
             na.title, na.url, na.source::text as source,
             na.published_at,
             nc.impact_score::int as catalyst_score,
             nc.direction::text   as catalyst_direction,
             nc.urgency::text     as catalyst_urgency,
             nc.catalyst_type     as catalyst_type,
             nc.reason            as catalyst_reason
      from news_ticker_links ntl
      join news_articles na on na.id = ntl.article_id
      left join news_classifications nc on nc.article_id = na.id
      where na.published_at > now() - (${WATCHLIST_NEWS_DAYS} || ' days')::interval
        and ntl.ticker in (select ticker from wl)
      order by ntl.ticker, na.published_at desc
    )
    select wl.ticker, wl.note, wl.expires_at, wl.created_at, wl.news_seen_at,
           rn.title           as news_title,
           rn.url             as news_url,
           rn.source          as news_source,
           rn.published_at::text as news_published_at,
           rn.catalyst_score, rn.catalyst_direction, rn.catalyst_urgency,
           rn.catalyst_type, rn.catalyst_reason,
           coalesce(rn.published_at > coalesce(wl.news_seen_at, wl.created_at), false) as has_new_news
    from wl
    left join recent_news rn on rn.ticker = wl.ticker
    order by has_new_news desc, wl.expires_at asc, wl.created_at desc
  `.execute(db);
  res.json({ data: rows.rows });
});

router.post('/watchlist', authMiddleware, async (req, res) => {
  const parsed = watchlistAddSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  const ticker = parsed.data.ticker.toUpperCase();
  const today = etDateString(new Date());
  const expires_at = parsed.data.expires_at ?? etDatePlusDays(WATCHLIST_DEFAULT_EXPIRY_DAYS);
  // Reject an already-past expiry outright — it'd be cleaned up immediately.
  if (expires_at < today) {
    return res.status(400).json({ error: 'expires_at is in the past' });
  }
  const db = getDb();
  // Upsert: re-adding a ticker refreshes its expiry rather than erroring. Note
  // is only overwritten when explicitly provided, so a re-star doesn't wipe it.
  await db
    .insertInto('user_watchlist')
    .values({
      user_id: req.user!.userId,
      ticker,
      note: parsed.data.note ?? null,
      expires_at,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'ticker']).doUpdateSet({
        expires_at,
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
        updated_at: sql`current_timestamp` as unknown as Date,
      }),
    )
    .execute();
  res.status(201).json({ data: { ticker, expires_at } });
});

// Update just the expiry for an entry (the per-row date editor).
router.patch('/watchlist/:ticker', authMiddleware, async (req, res) => {
  const parsed = watchlistExpirySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  const today = etDateString(new Date());
  if (parsed.data.expires_at < today) {
    return res.status(400).json({ error: 'expires_at is in the past' });
  }
  const ticker = String(req.params.ticker).toUpperCase();
  const db = getDb();
  await db
    .updateTable('user_watchlist')
    .set({ expires_at: parsed.data.expires_at, updated_at: sql`current_timestamp` as unknown as Date })
    .where('user_id', '=', req.user!.userId)
    .where('ticker', '=', ticker)
    .execute();
  res.json({ data: { ticker, expires_at: parsed.data.expires_at } });
});

// Mark this entry's news as seen — clears the "new news" dot.
router.post('/watchlist/:ticker/seen', authMiddleware, async (req, res) => {
  const ticker = String(req.params.ticker).toUpperCase();
  const db = getDb();
  await db
    .updateTable('user_watchlist')
    .set({ news_seen_at: sql`current_timestamp` as unknown as string })
    .where('user_id', '=', req.user!.userId)
    .where('ticker', '=', ticker)
    .execute();
  res.json({ data: { ok: true } });
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

// ─── flagged / "avoid" tickers (per-user, permanent) ───────────────────────
// Manual burned-list: a permanent ⚠ warning on tickers that pump-and-dumped on
// the operator. No expiry (structural fact). Pairs with the automatic
// burned-tickers detection off screener_outcomes (see routes/screener.ts).
const flaggedAddSchema = z.object({
  ticker: z.string().min(1).max(10),
  note: z.string().max(500).optional(),
});

router.get('/flagged', authMiddleware, async (req, res) => {
  const db = getDb();
  const rows = await db
    .selectFrom('user_flagged_tickers')
    .select(['ticker', 'note', 'created_at'])
    .where('user_id', '=', req.user!.userId)
    .orderBy('created_at', 'desc')
    .execute();
  res.json({ data: rows });
});

router.post('/flagged', authMiddleware, async (req, res) => {
  const parsed = flaggedAddSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  const ticker = parsed.data.ticker.toUpperCase();
  const db = getDb();
  await db
    .insertInto('user_flagged_tickers')
    .values({ user_id: req.user!.userId, ticker, note: parsed.data.note ?? null })
    .onConflict((oc) =>
      oc.columns(['user_id', 'ticker']).doUpdateSet({
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      }),
    )
    .execute();
  res.status(201).json({ data: { ticker } });
});

router.delete('/flagged/:ticker', authMiddleware, async (req, res) => {
  const ticker = String(req.params.ticker).toUpperCase();
  const db = getDb();
  await db
    .deleteFrom('user_flagged_tickers')
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

import { Router } from 'express';
import { sql } from 'kysely';
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
      'r.avg_volume', 'r.rel_volume', 'r.vol_5min', 'r.rel_vol_5min', 'r.rel_vol_1min',
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
      'i.rel_volume', 'i.rel_vol_5min', 'i.rel_vol_1min',
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

// GET /api/screener/history-by-day?date=YYYY-MM-DD&screen=ignition|momentum
// Per-(ticker, session) aggregation of one ET trading day's worth of either
// the Ignition screen or the Momentum screen. Catalyst column = the most-
// impactful news classification that landed for the ticker on that ET day
// (left-joined; null when no news/classification exists). Drives the
// dashboard's "History" tab.
const historyByDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  screen: z.enum(['ignition', 'momentum']).default('ignition'),
});
router.get('/history-by-day', authMiddleware, async (req, res) => {
  const parsed = historyByDaySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  }
  const { date, screen } = parsed.data;
  const db = getDb();

  // Common-shape row regardless of source. Per-ticker, per-session rollup
  // plus the day's most-impactful catalyst (if any). `peak_score` is null
  // for Momentum rows since the Momentum table doesn't carry a per-row
  // composite score the way ignition_results does — Momentum uses `status`
  // (NEW/ACC/UP/NEWS) for that role, surfaced separately.
  const result = await sql<{
    ticker: string;
    session: string;
    ticks: number;
    first_at: string;
    last_at: string;
    peak_score: number | null;
    status: string | null;
    min_chg: number | null;
    max_chg: number | null;
    min_price: number | null;
    max_price: number | null;
    catalyst_score: number | null;
    catalyst_direction: string | null;
    catalyst_urgency: string | null;
    catalyst_type: string | null;
    news_title: string | null;
    news_source: string | null;
  }>`
    ${
      screen === 'ignition'
        ? sql`
            with rows as (
              select i.ticker, c.session, c.polled_at,
                     i.runner_score, i.change_pct, i.price
              from ignition_results i
              join screener_cycles c on c.id = i.cycle_id
              where (c.polled_at at time zone 'America/New_York')::date = ${date}::date
            ),
            agg as (
              select ticker, session,
                     count(*)::int                   as ticks,
                     min(polled_at)::text            as first_at,
                     max(polled_at)::text            as last_at,
                     max(runner_score)::float        as peak_score,
                     null::text                      as status,
                     min(change_pct)::float          as min_chg,
                     max(change_pct)::float          as max_chg,
                     min(price)::float               as min_price,
                     max(price)::float               as max_price
              from rows
              group by ticker, session
            )
          `
        : sql`
            with rows as (
              select r.ticker, c.session, c.polled_at,
                     r.change_pct, r.price, r.status
              from screener_results r
              join screener_cycles c on c.id = r.cycle_id
              where (c.polled_at at time zone 'America/New_York')::date = ${date}::date
            ),
            agg as (
              select ticker, session,
                     count(*)::int                   as ticks,
                     min(polled_at)::text            as first_at,
                     max(polled_at)::text            as last_at,
                     null::float                     as peak_score,
                     -- Status precedence: NEW > ACC > UP > NEWS > —. NEW
                     -- only fires once per ticker per cycle so it's the
                     -- strongest day-level signal.
                     coalesce(
                       max(status) filter (where status = 'NEW'),
                       max(status) filter (where status = 'ACC'),
                       max(status) filter (where status = 'UP'),
                       max(status) filter (where status = 'NEWS')
                     )                               as status,
                     min(change_pct)::float          as min_chg,
                     max(change_pct)::float          as max_chg,
                     min(price)::float               as min_price,
                     max(price)::float               as max_price
              from rows
              group by ticker, session
            )
          `
    },
    day_catalyst as (
      select distinct on (ntl.ticker)
             ntl.ticker,
             nc.impact_score::int   as catalyst_score,
             nc.direction::text     as catalyst_direction,
             nc.urgency::text       as catalyst_urgency,
             nc.catalyst_type       as catalyst_type,
             na.title               as news_title,
             na.source::text        as news_source
      from news_ticker_links ntl
      join news_articles na on na.id = ntl.article_id
      left join news_classifications nc on nc.article_id = na.id
      where (na.published_at at time zone 'America/New_York')::date = ${date}::date
        and ntl.ticker in (select ticker from agg)
      -- Per-ticker, prefer the highest impact_score; tie-break on most-recent.
      order by ntl.ticker, nc.impact_score desc nulls last, na.published_at desc
    )
    select agg.ticker, agg.session, agg.ticks,
           agg.first_at, agg.last_at,
           agg.peak_score, agg.status,
           agg.min_chg, agg.max_chg,
           agg.min_price, agg.max_price,
           dc.catalyst_score, dc.catalyst_direction, dc.catalyst_urgency,
           dc.catalyst_type, dc.news_title, dc.news_source
    from agg
    left join day_catalyst dc on dc.ticker = agg.ticker
    order by
      case agg.session when 'premarket' then 1 when 'regular' then 2 when 'afterhours' then 3 else 4 end,
      agg.peak_score desc nulls last,
      agg.max_chg desc nulls last
  `.execute(db);

  res.json({ data: result.rows });
});

// GET /api/screener/outcomes-summary?group_by=...&horizon=1|3|5&screen=...
// Aggregates screener_outcomes into per-bucket stats — the interactive
// backtest view. Gates on bars_forward >= horizon so only rows whose horizon
// has actually filled are compared. Returns a coverage header (so thin
// samples are visible) + per-bucket {n, avg_chg, avg_peak, avg_drawdown,
// win_rate}. See docs "Reading the outcome data".
const outcomesSummarySchema = z.object({
  group_by: z
    .enum(['catalyst_direction', 'catalyst_urgency', 'shelf_level', 'score_bucket', 'extension_bucket', 'screen'])
    .default('catalyst_direction'),
  horizon: z.enum(['1', '3', '5']).default('5'),
  screen: z.enum(['momentum', 'ignition', 'swing', 'all']).default('all'),
});

router.get('/outcomes-summary', authMiddleware, async (req, res) => {
  const parsed = outcomesSummarySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  const { group_by, horizon, screen } = parsed.data;
  const db = getDb();

  // The horizon's return column. Validated by the enum above, so this is a
  // safe identifier (never user-interpolated raw).
  const chgCol = sql.ref(`chg_${horizon}d`);
  const minBars = Number(horizon);

  // Per-group_by bucket label expression. score/extension are bucketed; the
  // rest are the raw column coalesced to a placeholder. sql.lit keeps the
  // labels server-controlled.
  const bucketExpr =
    group_by === 'score_bucket'
      ? sql`case
              when entry_score is null then '(no score)'
              when entry_score >= 75 then '75-100'
              when entry_score >= 55 then '55-75'
              when entry_score >= 40 then '40-55'
              else '0-40'
            end`
      : group_by === 'extension_bucket'
        ? sql`case
                when first_change_pct is null then '(unknown)'
                when first_change_pct >= 40 then '>=40%'
                when first_change_pct >= 20 then '20-40%'
                when first_change_pct >= 0 then '0-20%'
                else '<0%'
              end`
        : group_by === 'catalyst_direction'
          ? sql`coalesce(catalyst_direction, '(none)')`
          : group_by === 'catalyst_urgency'
            ? sql`coalesce(catalyst_urgency, '(none)')`
            : group_by === 'shelf_level'
              ? sql`coalesce(shelf_level, '(none)')`
              : sql`screen`;

  const screenWhere = screen === 'all' ? sql`true` : sql`screen = ${screen}`;

  const result = await sql<{
    bucket: string;
    n: number;
    avg_chg: number | null;
    avg_peak: number | null;
    avg_drawdown: number | null;
    win_rate: number | null;
  }>`
    select ${bucketExpr}                                                   as bucket,
           count(*)::int                                                   as n,
           round(avg(${chgCol})::numeric, 1)                               as avg_chg,
           round(avg(peak_5d)::numeric, 1)                                 as avg_peak,
           round(avg(drawdown_5d)::numeric, 1)                             as avg_drawdown,
           round((count(*) filter (where ${chgCol} > 0)::numeric
                  / nullif(count(*), 0) * 100), 0)                         as win_rate
    from screener_outcomes
    where ${screenWhere}
      and bars_forward >= ${minBars}
      and ${chgCol} is not null
    group by 1
    order by avg_chg desc nulls last
  `.execute(db);

  // Coverage header — total rows in scope + how many are horizon-ready, so the
  // UI can warn on thin samples.
  const coverage = await sql<{ total: number; ready: number }>`
    select count(*)::int                                          as total,
           count(*) filter (where bars_forward >= ${minBars})::int as ready
    from screener_outcomes
    where ${screenWhere}
  `.execute(db);

  res.json({
    data: {
      group_by,
      horizon: minBars,
      screen,
      coverage: coverage.rows[0] ?? { total: 0, ready: 0 },
      buckets: result.rows,
    },
  });
});

// GET /api/screener/burned-tickers
// Automatic pump-and-dump offender list, computed from screener_outcomes. A
// detection "event" is a row that spiked hard then closed deeply red within the
// window (peak_5d >= PEAK_MIN AND chg_5d <= CHG_MAX) — the VIVK signature: hot
// news, rip, dump. A ticker with >= 1 such event is "burned" and gets a ⚠
// warning everywhere it appears. Global (not per-user) — it's a property of the
// ticker's behavior, not a personal preference. Cached briefly since it only
// shifts when the daily outcome job runs.
const BURNED_PEAK_MIN = 40; // intraday/5d peak at least +40%
const BURNED_CHG_MAX = -15; // ...but the 5d close ended <= -15%
const BURNED_CACHE_MS = 5 * 60 * 1000;
let burnedCache: { at: number; rows: unknown[] } | null = null;

router.get('/burned-tickers', authMiddleware, async (_req, res) => {
  if (burnedCache && Date.now() - burnedCache.at < BURNED_CACHE_MS) {
    return res.json({ data: burnedCache.rows });
  }
  const db = getDb();
  const result = await sql<{
    ticker: string;
    events: number;
    last_event: string;
    max_peak: number | null;
    worst_chg: number | null;
    avg_drawdown: number | null;
  }>`
    select ticker,
           count(*)::int                 as events,
           max(et_date)::text            as last_event,
           round(max(peak_5d)::numeric, 1)      as max_peak,
           round(min(chg_5d)::numeric, 1)       as worst_chg,
           round(avg(drawdown_5d)::numeric, 1)  as avg_drawdown
    from screener_outcomes
    where bars_forward >= 3
      and peak_5d >= ${BURNED_PEAK_MIN}
      and chg_5d <= ${BURNED_CHG_MAX}
    group by ticker
    order by events desc, worst_chg asc
  `.execute(db);
  burnedCache = { at: Date.now(), rows: result.rows };
  res.json({ data: result.rows });
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

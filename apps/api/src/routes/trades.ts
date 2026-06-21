import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { sql } from 'kysely';
import {
  parseTlg,
  matchTrades,
  aggregateByDay,
  type ParsedExecution,
  type MatchedTrade,
} from '../services/ibkr-tlg.js';

const router = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

// Reload a user's fills from the DB as ParsedExecution[] (the matcher's input).
// pg returns numeric columns as strings and `timestamp` as a tz-shifted Date, so
// we coerce numbers and pull executed_at back as the exact ET wall-clock string
// (to_char) — matchTrades only needs a monotonic per-symbol order + et_date.
async function loadExecutions(userId: string, throughDate?: string): Promise<ParsedExecution[]> {
  const db = getDb();
  let q = db
    .selectFrom('trade_executions')
    .select([
      'exec_id',
      'symbol',
      'description',
      'venue',
      'side',
      'open_close',
      'action_raw',
      'quantity',
      'multiplier',
      'price',
      'amount',
      'commission',
      'currency',
      sql<string>`to_char(executed_at, 'YYYY-MM-DD HH24:MI:SS')`.as('executed_at'),
      sql<string>`et_date::text`.as('et_date'),
    ])
    .where('user_id', '=', userId);
  if (throughDate) q = q.where('et_date', '<=', throughDate);
  const rows = await q.execute();
  return rows.map((r) => ({
    exec_id: r.exec_id,
    symbol: r.symbol,
    description: r.description,
    venue: r.venue,
    side: r.side === 'sell' ? 'sell' : 'buy',
    open_close: r.open_close,
    action_raw: r.action_raw,
    quantity: Number(r.quantity),
    multiplier: Number(r.multiplier),
    price: Number(r.price),
    amount: Number(r.amount),
    commission: Number(r.commission),
    currency: r.currency,
    executed_at: r.executed_at,
    et_date: r.et_date,
  }));
}

function summarize(trades: MatchedTrade[]) {
  const closed = trades.filter((t) => !t.is_open);
  const net = closed.reduce((s, t) => s + t.net_pnl, 0);
  const gross = closed.reduce((s, t) => s + t.gross_pnl, 0);
  const commission = closed.reduce((s, t) => s + t.commission, 0);
  const wins = closed.filter((t) => t.net_pnl > 0).length;
  return {
    net_pnl: Math.round(net * 100) / 100,
    gross_pnl: Math.round(gross * 100) / 100,
    commission: Math.round(commission * 100) / 100,
    trade_count: closed.length,
    win_count: wins,
    loss_count: closed.filter((t) => t.net_pnl < 0).length,
    win_rate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : null,
  };
}

// ─── import a broker statement ─────────────────────────────────────────────
const importSchema = z.object({
  filename: z.string().max(260).optional(),
  content: z.string().min(1).max(20_000_000),
});

router.post('/import', authMiddleware, async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });

  const tlg = parseTlg(parsed.data.content);
  if (tlg.executions.length === 0) {
    return res.status(400).json({ error: 'No stock transactions found — is this an IBKR TradeLog (.tlg) file?' });
  }
  const fileHash = createHash('sha256').update(parsed.data.content).digest('hex');
  const userId = req.user!.userId;
  const db = getDb();

  const result = await db.transaction().execute(async (trx) => {
    const imp = await trx
      .insertInto('broker_imports')
      .values({
        user_id: userId,
        broker: 'ibkr',
        filename: parsed.data.filename ?? null,
        account: tlg.account,
        file_hash: fileHash,
        period_start: tlg.period_start,
        period_end: tlg.period_end,
        executions_seen: tlg.executions.length,
        executions_imported: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Bulk insert; ON CONFLICT (user_id, exec_id) DO NOTHING makes re-importing
    // an overlapping file idempotent. RETURNING yields only the rows that were
    // actually inserted (Postgres), so its length = newly-imported count.
    const inserted = await trx
      .insertInto('trade_executions')
      .values(
        tlg.executions.map((e) => ({
          user_id: userId,
          import_id: imp.id,
          exec_id: e.exec_id,
          symbol: e.symbol,
          description: e.description,
          venue: e.venue,
          side: e.side,
          open_close: e.open_close,
          action_raw: e.action_raw,
          quantity: e.quantity,
          multiplier: e.multiplier,
          price: e.price,
          amount: e.amount,
          commission: e.commission,
          currency: e.currency,
          executed_at: e.executed_at,
          et_date: e.et_date,
        })),
      )
      .onConflict((oc) => oc.columns(['user_id', 'exec_id']).doNothing())
      .returning('id')
      .execute();

    await trx
      .updateTable('broker_imports')
      .set({ executions_imported: inserted.length })
      .where('id', '=', imp.id)
      .execute();

    return { importId: imp.id, imported: inserted.length };
  });

  res.status(201).json({
    data: {
      import_id: result.importId,
      account: tlg.account,
      account_name: tlg.account_name,
      period_start: tlg.period_start,
      period_end: tlg.period_end,
      executions_seen: tlg.executions.length,
      executions_imported: result.imported,
      duplicates: tlg.executions.length - result.imported,
      skipped: tlg.skipped,
    },
  });
});

// ─── calendar: per-ET-day P&L aggregates ───────────────────────────────────
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const calendarSchema = z.object({
  from: z.string().regex(dateRe).optional(),
  to: z.string().regex(dateRe).optional(),
});

router.get('/calendar', authMiddleware, async (req, res) => {
  const parsed = calendarSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  const { from, to } = parsed.data;

  // Load through `to` (an overnight trade that opened before `from` but closes in
  // range still has all legs ≤ to), match the full history, then window the
  // resulting trades by exit date.
  const executions = await loadExecutions(req.user!.userId, to);
  const trades = matchTrades(executions);
  const windowed = trades.filter(
    (t) => !t.is_open && (!from || t.et_date >= from) && (!to || t.et_date <= to),
  );

  res.json({
    data: {
      from: from ?? null,
      to: to ?? null,
      days: aggregateByDay(windowed),
      summary: summarize(windowed),
    },
  });
});

// ─── a single day's round-trip trades (calendar cell drill-down) ───────────
router.get('/day', authMiddleware, async (req, res) => {
  const date = z.string().regex(dateRe).safeParse(req.query.date);
  if (!date.success) return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
  const executions = await loadExecutions(req.user!.userId, date.data);
  const trades = matchTrades(executions).filter((t) => !t.is_open && t.et_date === date.data);
  res.json({ data: { date: date.data, trades, summary: summarize(trades) } });
});

// ─── overall date span of a user's fills (so the UI can land on real data) ──
router.get('/range', authMiddleware, async (req, res) => {
  const db = getDb();
  const row = await db
    .selectFrom('trade_executions')
    .select([
      sql<string | null>`min(et_date)::text`.as('min'),
      sql<string | null>`max(et_date)::text`.as('max'),
    ])
    .where('user_id', '=', req.user!.userId)
    .executeTakeFirst();
  res.json({ data: { min: row?.min ?? null, max: row?.max ?? null } });
});

// ─── import history ─────────────────────────────────────────────────────────
router.get('/imports', authMiddleware, async (req, res) => {
  const db = getDb();
  const rows = await db
    .selectFrom('broker_imports')
    .select([
      'id',
      'broker',
      'filename',
      'account',
      sql<string | null>`period_start::text`.as('period_start'),
      sql<string | null>`period_end::text`.as('period_end'),
      'executions_seen',
      'executions_imported',
      'created_at',
    ])
    .where('user_id', '=', req.user!.userId)
    .orderBy('created_at', 'desc')
    .execute();
  res.json({ data: rows });
});

// Undo an import — remove the import record AND the fills it brought in. (Fills
// that a later re-import "re-confirmed" stay, since their import_id points at the
// first import that won the ON CONFLICT; this deletes only rows tied to this id.)
router.delete('/imports/:id', authMiddleware, async (req, res) => {
  const db = getDb();
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('trade_executions')
      .where('user_id', '=', req.user!.userId)
      .where('import_id', '=', req.params.id)
      .execute();
    await trx
      .deleteFrom('broker_imports')
      .where('user_id', '=', req.user!.userId)
      .where('id', '=', req.params.id)
      .execute();
  });
  res.json({ data: { ok: true } });
});

export default router;

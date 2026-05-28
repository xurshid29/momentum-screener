// DailyBarsService — the Swing screener's daily-OHLCV reservoir.
//
// Background worker that keeps the `daily_bars` table fresh against Finviz
// `quote_export?p=d`. The Swing scan (apps/api/src/services/swing-score.ts —
// landing in a later step) reads from this table synchronously to compute
// SMAs, the 52-week high, ATR, base detection, and breakout signals.
//
// Two write modes:
//   • backfill(ticker)        — first time we see a ticker: fetch the full
//                               quote_export response (~10y of bars), upsert
//                               every row, tag the ticker as fresh.
//   • refreshRecent(ticker)   — known ticker: fetch the same export but only
//                               upsert the last ~10 bars (overlap catches
//                               late corrections to today's bar after close).
//
// Single-instance, in-memory queue, rate-limited (1 Finviz call per
// DRAIN_INTERVAL_MS). Same shape as ShelfService — see services/shelf.ts.

import { sql } from 'kysely';
import { getDb } from '../db/index.js';
import { fetchFinvizDailyBars, type DailyBar } from './finviz.js';

// Finviz Elite tolerates a few requests per second across its endpoints
// (the screener path already uses ~3/cycle). 1 req/s leaves headroom for the
// screener calls firing every 20s on a separate clock.
const DRAIN_INTERVAL_MS = 1000;

// How fresh is "fresh enough"? Bars only change once a day (after the close);
// re-fetching the same ticker inside this window is wasteful. The midnight ET
// reset block will force a refresh by clearing `freshAt` so this doesn't
// matter for the daily cadence — it only affects the live request flow.
const FRESH_MS = 6 * 60 * 60 * 1000;     // 6h
const RETRY_MS = 15 * 60 * 1000;         // failed fetch: try again in 15m
// Recent-refresh window: how many trailing bars to overwrite on a
// refresh. Long enough to catch a late close-print correction; short enough
// not to be wasteful.
const REFRESH_TAIL_DAYS = 10;

type Mode = 'backfill' | 'refresh';
interface QueueItem {
  ticker: string;
  mode: Mode;
}

interface TickerState {
  freshAt: number;     // epoch ms — when the most recent fetch landed
  failed: boolean;
  barsFetched: number; // rows in the last successful fetch (for status)
}

class DailyBarsService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private queue: QueueItem[] = [];
  private queued = new Set<string>();
  private state = new Map<string, TickerState>();
  private lastError: string | null = null;
  private totalFetches = 0;
  private totalRowsWritten = 0;

  status() {
    return {
      running: this.running,
      cached: this.state.size,
      queued: this.queue.length,
      total_fetches: this.totalFetches,
      total_rows_written: this.totalRowsWritten,
      last_error: this.lastError,
    };
  }

  // Queue a ticker for a full backfill if we've never fetched it (or its
  // last fetch is stale enough that a refresh wouldn't cover the gap).
  enqueueBackfill(ticker: string): void {
    const t = ticker.toUpperCase();
    if (this.queued.has(t)) return;
    const s = this.state.get(t);
    const now = Date.now();
    if (s && !this.isStale(s, now)) return;
    this.queue.push({ ticker: t, mode: s ? 'refresh' : 'backfill' });
    this.queued.add(t);
  }

  // Bulk version — register many tickers at once. Backfill the new ones,
  // refresh the stale ones, leave the rest alone.
  trackUniverse(tickers: string[]): void {
    for (const raw of tickers) this.enqueueBackfill(raw);
  }

  // Mark every cached ticker for a refresh — called from the poller's
  // midnight-ET reset so today's freshly-closed bar lands in the table.
  invalidateAll(): void {
    for (const s of this.state.values()) s.freshAt = 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[daily-bars] starting (1 Finviz fetch / ${DRAIN_INTERVAL_MS}ms)`);
    this.timer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  private isStale(s: TickerState, now: number): boolean {
    return now - s.freshAt > (s.failed ? RETRY_MS : FRESH_MS);
  }

  private async drain(): Promise<void> {
    if (this.inFlight) return;
    const item = this.queue.shift();
    if (!item) return;
    this.queued.delete(item.ticker);
    this.inFlight = true;
    try {
      await this.refreshOne(item);
    } finally {
      this.inFlight = false;
    }
  }

  private async refreshOne(item: QueueItem): Promise<void> {
    const { ticker, mode } = item;
    try {
      const bars = await fetchFinvizDailyBars(ticker);
      this.totalFetches += 1;
      if (bars.length === 0) {
        // Unknown ticker or Finviz transient. Mark fresh-ish so we don't
        // hammer it; the next universe scan will re-queue if needed.
        this.state.set(ticker, { freshAt: Date.now(), failed: true, barsFetched: 0 });
        return;
      }
      const toWrite = mode === 'refresh' ? bars.slice(-REFRESH_TAIL_DAYS) : bars;
      const written = await upsertBars(ticker, toWrite);
      this.totalRowsWritten += written;
      this.state.set(ticker, {
        freshAt: Date.now(),
        failed: false,
        barsFetched: bars.length,
      });
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      const prev = this.state.get(ticker);
      this.state.set(ticker, {
        freshAt: Date.now(),
        failed: true,
        barsFetched: prev?.barsFetched ?? 0,
      });
    }
  }
}

export const dailyBars = new DailyBarsService();

// Upsert via INSERT ... ON CONFLICT. Returns the row count written.
async function upsertBars(ticker: string, bars: DailyBar[]): Promise<number> {
  if (bars.length === 0) return 0;
  const db = getDb();
  // Chunk to keep parameter counts well under the libpq 32k-binding limit
  // even at very long lookbacks (current Finviz responses are ~2.5k bars,
  // 6 params each = 15k — already safe, but the chunking keeps it bounded
  // for future schema growth).
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < bars.length; i += CHUNK) {
    const chunk = bars.slice(i, i + CHUNK);
    const values = chunk.map((b) => ({
      ticker,
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      fetched_at: new Date(),
    }));
    const res = await db
      .insertInto('daily_bars')
      .values(values)
      .onConflict((oc) =>
        oc.columns(['ticker', 'date']).doUpdateSet({
          open: (eb) => eb.ref('excluded.open'),
          high: (eb) => eb.ref('excluded.high'),
          low: (eb) => eb.ref('excluded.low'),
          close: (eb) => eb.ref('excluded.close'),
          volume: (eb) => eb.ref('excluded.volume'),
          fetched_at: sql`current_timestamp`,
        }),
      )
      .executeTakeFirst();
    written += Number(res?.numInsertedOrUpdatedRows ?? 0);
  }
  return written;
}

// Read helper for callers (the Swing scan, the manual trigger endpoint).
// Returns the most-recent `days` bars in ascending date order — the shape
// the scoring code expects.
export async function getRecentBars(ticker: string, days = 250): Promise<DailyBar[]> {
  const db = getDb();
  const rows = await db
    .selectFrom('daily_bars')
    .select(['date', 'open', 'high', 'low', 'close', 'volume'])
    .where('ticker', '=', ticker.toUpperCase())
    .orderBy('date', 'desc')
    .limit(days)
    .execute();
  // Coerce numeric/date columns to the wire-friendly DailyBar shape; reverse
  // for ascending order.
  return rows
    .reverse()
    .map((r) => ({
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }))
    .filter((b) => Number.isFinite(b.open) && Number.isFinite(b.close));
}

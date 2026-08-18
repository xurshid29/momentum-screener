// EdgeService — lightweight live host for per-user/per-ticker 1-minute Edge
// trackers. It consumes the already-running Databento stream and persists only
// saved Edge tickers, so the lean dashboard does not re-enable the parked
// global EMA/MACD replay engines.

import { getDb } from '../db/index.js';
import { alertDisabled, escapeHtml, sendTelegram, telegramEnabled } from './telegram.js';
import {
  EdgeTracker,
  type EdgeBar,
  type EdgeEvent,
  type EdgePresetConfig,
  type EdgeSnapshot,
} from './edge-tracker.js';
import { adjustSplitHistory } from './ema-cross.js';

export interface EdgeTickBar {
  ts_sec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface OpenMinute {
  bucket: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const HISTORY_DAYS = 7;
const HISTORY_CAP = 6_000;
const FETCH_TIMEOUT_MS = 12_000;
const etWeekday = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short',
});

function key(userId: string, ticker: string): string {
  return `${userId}:${ticker}`;
}

function n(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function normalisePreset(row: {
  user_id: string; ticker: string; ema_fast: number; ema_slow: number;
  proximity_pct: number; stop_buffer_pct: number; alert_armed: boolean;
  alert_entry: boolean; alert_bailout: boolean; telegram_enabled: boolean;
  active: boolean;
}): EdgePresetConfig {
  return {
    ...row,
    ticker: row.ticker.toUpperCase(),
    ema_fast: n(row.ema_fast),
    ema_slow: n(row.ema_slow),
    proximity_pct: n(row.proximity_pct),
    stop_buffer_pct: n(row.stop_buffer_pct),
  };
}

function eventAlertEnabled(e: EdgeEvent): boolean {
  if (e.event === 'armed') return e.snapshot.alert_armed;
  if (e.event === 'entry') return e.snapshot.alert_entry;
  return e.snapshot.alert_bailout;
}

function setupLabel(setup: EdgeEvent['setup']): string {
  return setup?.replaceAll('_', ' ') ?? 'decision zone';
}

function formatEdgeAlert(e: EdgeEvent): string {
  const icon = e.event === 'armed' ? '🟡' : e.event === 'entry' ? '🟢' : '🔴';
  const title = e.event === 'armed' ? 'EDGE ARMED' : e.event === 'entry' ? 'EDGE ENTRY' : 'EDGE BAILOUT';
  const s = e.snapshot;
  const lines = [
    `${icon} <b>${title} — ${escapeHtml(e.ticker)}</b>`,
    `${escapeHtml(setupLabel(e.setup))} · 1m · EMA ${s.ema_fast}/${s.ema_slow} · MACD 3/15/8`,
    `Price <b>$${e.price.toFixed(4)}</b>${e.level != null ? ` · level $${e.level.toFixed(4)}` : ''}`,
  ];
  if (s.macd != null && s.macd_signal != null) {
    lines.push(`MACD ${s.macd.toFixed(4)} / ${s.macd_signal.toFixed(4)}${s.macd_rising && s.histogram_rising ? ' ↗' : ''}`);
  }
  if (e.bailout != null) lines.push(`Breakout-or-bailout: <b>$${e.bailout.toFixed(4)}</b>`);
  return lines.join('\n');
}

class EdgeService {
  private trackers = new Map<string, EdgeTracker>();
  private tickerKeys = new Map<string, Set<string>>();
  private history = new Map<string, EdgeBar[]>();
  private openMinutes = new Map<string, OpenMinute>();
  private barBuffer: EdgeBarWithTicker[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private running = false;
  private loading = false;
  private eventsSeen = 0;
  private barsPersisted = 0;
  private backfills = 0;
  private backfillErrors = 0;
  private backfillPending = new Set<string>();
  private recentEvents = new Map<string, EdgeEvent[]>();
  private lastError: string | null = null;

  status() {
    return {
      running: this.running,
      loading: this.loading,
      presets: this.trackers.size,
      tickers: this.tickerKeys.size,
      open_minutes: this.openMinutes.size,
      bars_buffered: this.barBuffer.length,
      bars_persisted: this.barsPersisted,
      backfills: this.backfills,
      backfill_errors: this.backfillErrors,
      events: this.eventsSeen,
      last_error: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loading = true;
    try {
      await this.loadAll();
      this.flushTimer = setInterval(() => void this.flushBars(), 5_000);
      console.log(`[edge] started — ${this.trackers.size} presets across ${this.tickerKeys.size} tickers`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[edge] startup failed:', this.lastError);
    } finally {
      this.loading = false;
    }
  }

  stop(): void {
    this.running = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    void this.flushBars();
  }

  activeTickers(): string[] {
    return [...this.tickerKeys.keys()];
  }

  isWatched(ticker: string): boolean {
    return this.tickerKeys.has(ticker.toUpperCase());
  }

  getSnapshots(userId: string): EdgeSnapshot[] {
    const order: Record<EdgeSnapshot['state'], number> = {
      entry: 0, armed: 1, bailout: 2, watching: 3, warming: 4,
    };
    return [...this.trackers.values()]
      .map((t) => t.snapshot())
      .filter((s) => s.user_id === userId)
      .sort((a, b) => order[a.state] - order[b.state] || a.ticker.localeCompare(b.ticker));
  }

  // Browser clients poll the state every three seconds. Keep every live
  // transition in a small per-user queue so a fast armed → entry sequence is
  // delivered in full rather than being collapsed into snapshot.last_event.
  getRecentEvents(userId: string): EdgeEvent[] {
    return this.recentEvents.get(userId) ?? [];
  }

  async reloadPreset(userId: string, tickerRaw: string): Promise<void> {
    const ticker = tickerRaw.toUpperCase();
    const row = await getDb()
      .selectFrom('user_edge_presets')
      .selectAll()
      .where('user_id', '=', userId)
      .where('ticker', '=', ticker)
      .executeTakeFirst();
    const k = key(userId, ticker);
    const existing = this.trackers.get(k);
    if (row?.active && existing) {
      const before = existing.snapshot();
      const cfg = normalisePreset(row);
      // Pure alert edits are hot-swappable. Preserve Entry/Bailout state and
      // its original risk level; changing a calculation/risk knob reseeds.
      if (
        before.ema_fast === cfg.ema_fast && before.ema_slow === cfg.ema_slow &&
        before.proximity_pct === cfg.proximity_pct && before.stop_buffer_pct === cfg.stop_buffer_pct
      ) {
        existing.updateConfig(cfg);
        return;
      }
    }
    this.removeTrackerKey(k, ticker);
    if (!row?.active) return;

    await this.ensureHistoryLoaded(ticker);
    const cfg = normalisePreset(row);
    const tracker = new EdgeTracker(cfg, (event) => this.onEvent(event));
    tracker.seed(this.history.get(ticker) ?? []);
    this.trackers.set(k, tracker);
    let keys = this.tickerKeys.get(ticker);
    if (!keys) { keys = new Set(); this.tickerKeys.set(ticker, keys); }
    keys.add(k);
    void this.ensureWarmHistory(ticker);
  }

  reset(userId: string, ticker: string): boolean {
    const tracker = this.trackers.get(key(userId, ticker.toUpperCase()));
    if (!tracker) return false;
    tracker.reset();
    return true;
  }

  onTick(tickerRaw: string, tick: EdgeTickBar): void {
    const ticker = tickerRaw.toUpperCase();
    if (!this.tickerKeys.has(ticker)) return;
    const bucket = Math.floor(tick.ts_sec / 60) * 60;
    const cur = this.openMinutes.get(ticker);
    if (!cur) {
      this.openMinutes.set(ticker, {
        bucket, open: tick.open, high: tick.high, low: tick.low,
        close: tick.close, volume: tick.volume,
      });
    } else if (bucket === cur.bucket) {
      cur.high = Math.max(cur.high, tick.high);
      cur.low = Math.min(cur.low, tick.low);
      cur.close = tick.close;
      cur.volume += Math.max(0, tick.volume);
    } else if (bucket > cur.bucket) {
      this.commitBar(ticker, {
        ts_sec: cur.bucket + 60, open: cur.open, high: cur.high,
        low: cur.low, close: cur.close, volume: cur.volume,
      });
      this.openMinutes.set(ticker, {
        bucket, open: tick.open, high: tick.high, low: tick.low,
        close: tick.close, volume: tick.volume,
      });
    } else {
      // The sidecar is normally ordered, but a late bar must not overwrite
      // the live proximity read with an older price/timestamp.
      return;
    }
    const forming = this.openMinutes.get(ticker)!;
    for (const k of this.tickerKeys.get(ticker) ?? []) {
      this.trackers.get(k)?.updateLive(tick.close, forming.low, forming.high, tick.ts_sec);
    }
  }

  private async loadAll(): Promise<void> {
    const rows = await getDb()
      .selectFrom('user_edge_presets')
      .selectAll()
      .where('active', '=', true)
      .execute();
    const tickers = [...new Set(rows.map((r) => r.ticker.toUpperCase()))];
    if (tickers.length > 0) {
      const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000);
      const bars = await getDb()
        .selectFrom('edge_bars_1m')
        .selectAll()
        .where('ticker', 'in', tickers)
        .where('bar_ts', '>', since)
        .orderBy('ticker', 'asc')
        .orderBy('bar_ts', 'asc')
        .execute();
      for (const row of bars) {
        const bar: EdgeBar = {
          ts_sec: Math.floor(new Date(row.bar_ts).getTime() / 1000),
          open: n(row.open), high: n(row.high), low: n(row.low),
          close: n(row.close), volume: n(row.volume),
        };
        const list = this.history.get(row.ticker) ?? [];
        list.push(bar);
        this.history.set(row.ticker, list);
      }
    }
    for (const row of rows) {
      const cfg = normalisePreset(row);
      const tracker = new EdgeTracker(cfg, (event) => this.onEvent(event));
      tracker.seed(this.history.get(cfg.ticker) ?? []);
      const k = key(cfg.user_id, cfg.ticker);
      this.trackers.set(k, tracker);
      let keys = this.tickerKeys.get(cfg.ticker);
      if (!keys) { keys = new Set(); this.tickerKeys.set(cfg.ticker, keys); }
      keys.add(k);
    }
    for (const ticker of tickers) void this.ensureWarmHistory(ticker);
  }

  private async ensureHistoryLoaded(ticker: string): Promise<void> {
    if (this.history.has(ticker)) return;
    const rows = await getDb()
      .selectFrom('edge_bars_1m')
      .selectAll()
      .where('ticker', '=', ticker)
      .where('bar_ts', '>', new Date(Date.now() - HISTORY_DAYS * 86_400_000))
      .orderBy('bar_ts', 'asc')
      .execute();
    this.history.set(ticker, rows.map((r) => ({
      ts_sec: Math.floor(new Date(r.bar_ts).getTime() / 1000),
      open: n(r.open), high: n(r.high), low: n(r.low), close: n(r.close), volume: n(r.volume),
    })));
  }

  private async ensureWarmHistory(ticker: string): Promise<void> {
    if (this.backfillPending.has(ticker)) return;
    // Three slow-EMA lengths gives the recursive EMA enough history to line
    // up much more closely with the operator's continuously-running chart.
    const needed = Math.max(...[...(this.tickerKeys.get(ticker) ?? [])]
      .map((k) => (this.trackers.get(k)?.snapshot().ema_slow ?? 0) * 3), 66);
    const current = this.history.get(ticker) ?? [];
    const newest = current.at(-1)?.ts_sec ?? 0;
    const freshEnough = newest >= Math.floor(Date.now() / 1000) - 15 * 60;
    if (current.length >= needed && freshEnough) return;
    this.backfillPending.add(ticker);
    try {
      const fetched = await fetchHistorical1m(ticker);
      if (fetched.length === 0) throw new Error('no historical 1m bars returned');
      await persistBars(ticker, fetched);
      // Persistence yields to the live feed. Merge again afterwards so any
      // 1m candle that closed during the write is retained in the reseed.
      const latest = mergeBars(fetched, this.history.get(ticker) ?? []).slice(-HISTORY_CAP);
      this.history.set(ticker, latest);
      for (const k of this.tickerKeys.get(ticker) ?? []) this.trackers.get(k)?.seed(latest);
      this.backfills += 1;
      console.log(`[edge] warmed ${ticker} with ${fetched.length} historical 1m bars`);
    } catch (err) {
      this.backfillErrors += 1;
      this.lastError = `${ticker}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[edge] ${ticker} warmup failed:`, this.lastError);
    } finally {
      this.backfillPending.delete(ticker);
    }
  }

  private commitBar(ticker: string, bar: EdgeBar): void {
    const list = this.history.get(ticker) ?? [];
    if (list.length === 0 || list[list.length - 1].ts_sec < bar.ts_sec) list.push(bar);
    if (list.length > HISTORY_CAP) list.splice(0, list.length - HISTORY_CAP);
    this.history.set(ticker, list);
    for (const k of this.tickerKeys.get(ticker) ?? []) this.trackers.get(k)?.addClosedBar(bar);
    this.barBuffer.push({ ticker, ...bar });
  }

  private async flushBars(): Promise<void> {
    if (this.barBuffer.length === 0) return;
    const rows = this.barBuffer.splice(0, this.barBuffer.length);
    try {
      await persistBarsWithTickers(rows);
      this.barsPersisted += rows.length;
      this.lastError = null;
    } catch (err) {
      this.barBuffer.unshift(...rows);
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[edge] 1m bar flush failed:', this.lastError);
    }
  }

  private removeTrackerKey(k: string, ticker: string): void {
    this.trackers.delete(k);
    const keys = this.tickerKeys.get(ticker);
    keys?.delete(k);
    if (keys?.size === 0) {
      this.tickerKeys.delete(ticker);
      this.openMinutes.delete(ticker);
    }
  }

  private onEvent(event: EdgeEvent): void {
    this.eventsSeen += 1;
    const recent = this.recentEvents.get(event.user_id) ?? [];
    recent.unshift(event);
    if (recent.length > 100) recent.length = 100;
    this.recentEvents.set(event.user_id, recent);
    void getDb()
      .insertInto('edge_events')
      .values({
        id: event.id,
        user_id: event.user_id,
        ticker: event.ticker,
        event: event.event,
        setup: event.setup,
        price: event.price,
        level: event.level,
        bailout: event.bailout,
        at: new Date(event.at),
        snapshot: JSON.stringify(event.snapshot),
      })
      .execute()
      .catch((err) => console.error('[edge] event persistence failed:', err));

    if (!eventAlertEnabled(event) || !event.snapshot.telegram_enabled || !telegramEnabled()) return;
    const owner = process.env.TELEGRAM_USER_ID;
    if (owner && owner !== event.user_id) return;
    const slug = event.event === 'armed' ? 'edge_armed' : event.event === 'entry' ? 'edge_entry' : 'edge_bailout';
    if (!alertDisabled(slug)) void sendTelegram(formatEdgeAlert(event));
  }
}

interface EdgeBarWithTicker extends EdgeBar { ticker: string }

function mergeBars(a: EdgeBar[], b: EdgeBar[]): EdgeBar[] {
  const map = new Map<number, EdgeBar>();
  for (const bar of [...a, ...b]) map.set(bar.ts_sec, bar);
  return [...map.values()].sort((x, y) => x.ts_sec - y.ts_sec);
}

async function persistBars(ticker: string, bars: EdgeBar[]): Promise<void> {
  await persistBarsWithTickers(bars.map((bar) => ({ ticker, ...bar })));
}

async function persistBarsWithTickers(bars: EdgeBarWithTicker[]): Promise<void> {
  if (bars.length === 0) return;
  // Keep inserts modest; historical warmups can contain several thousand rows.
  for (let i = 0; i < bars.length; i += 500) {
    const chunk = bars.slice(i, i + 500);
    await getDb()
      .insertInto('edge_bars_1m')
      .values(chunk.map((b) => ({
        ticker: b.ticker,
        bar_ts: new Date(b.ts_sec * 1000),
        open: b.open, high: b.high, low: b.low, close: b.close, volume: Math.round(b.volume),
      })))
      .onConflict((oc) => oc.columns(['ticker', 'bar_ts']).doUpdateSet({
        open: (eb) => eb.ref('excluded.open'),
        high: (eb) => eb.ref('excluded.high'),
        low: (eb) => eb.ref('excluded.low'),
        close: (eb) => eb.ref('excluded.close'),
        volume: (eb) => eb.ref('excluded.volume'),
      }))
      .execute();
  }
  // Opportunistic global prune; the indexed timestamp makes this cheap and
  // bounds the new table independently of old technical stores.
  await getDb().deleteFrom('edge_bars_1m')
    .where('bar_ts', '<', new Date(Date.now() - (HISTORY_DAYS + 1) * 86_400_000))
    .execute();
}

async function fetchHistorical1m(ticker: string): Promise<EdgeBar[]> {
  const dbBars = prepareHistorical(await fetchDatabento1m(ticker), true);
  if (dbBars.length > 0) return dbBars;
  return prepareHistorical(await fetchYahoo1m(ticker), false);
}

function prepareHistorical(raw: EdgeBar[], strictSourceGuard: boolean): EdgeBar[] {
  const sorted = raw
    .filter((b) => Number.isFinite(b.ts_sec) && b.close > 0 && etWeekday.format(new Date(b.ts_sec * 1000)) !== 'Sat' && etWeekday.format(new Date(b.ts_sec * 1000)) !== 'Sun')
    .sort((a, b) => a.ts_sec - b.ts_sec);
  if (sorted.length < 2) return sorted;

  // Databento is raw while the operator's TradingView chart is adjusted.
  // Reuse the proven reverse-split detector, then carry its factor across the
  // full candle and inverse-adjust volume.
  const adjusted = adjustSplitHistory(sorted.map((b) => ({ closeTs: b.ts_sec, close: b.close, volume: b.volume })));
  const bars = sorted.map((b, i) => {
    const factor = adjusted[i].close / b.close;
    return factor === 1 ? b : {
      ...b,
      open: b.open * factor,
      high: b.high * factor,
      low: b.low * factor,
      close: adjusted[i].close,
      volume: adjusted[i].volume,
    };
  });

  // Source poison guard: reject a series that repeatedly flips between price
  // scales, or contains a lone ≥20× off-scale print. Yahoo then becomes the
  // clean fallback instead of poisoning a custom slow EMA for hours.
  if (!strictSourceGuard) return bars;
  let wild = 0;
  for (let i = 1; i < bars.length; i++) {
    const ratio = bars[i].close / bars[i - 1].close;
    if (ratio >= 2 || ratio <= 0.5) wild += 1;
  }
  if (wild / (bars.length - 1) > 0.10) return [];
  const closes = bars.map((b) => b.close).sort((a, b) => a - b);
  const median = closes[Math.floor(closes.length / 2)];
  if (!(median > 0) || closes.at(-1)! / median >= 20 || closes[0] / median <= 1 / 20) return [];
  return bars;
}

async function fetchDatabento1m(ticker: string): Promise<EdgeBar[]> {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) return [];
  const end = new Date(Date.now() - 3 * 60_000);
  const start = new Date(end.getTime() - HISTORY_DAYS * 86_400_000);
  const params = new URLSearchParams({
    dataset: 'EQUS.MINI', schema: 'ohlcv-1m', symbols: ticker,
    stype_in: 'raw_symbol', start: start.toISOString(), end: end.toISOString(),
    encoding: 'csv', pretty_px: 'true', map_symbols: 'true',
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
    const res = await fetch(`https://hist.databento.com/v0/timeseries.get_range?${params}`, {
      headers: { Authorization: auth }, signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const lines = (await res.text()).split('\n');
    const out: EdgeBar[] = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      if (c.length < 10) continue;
      const startSec = Number(c[0].slice(0, -9));
      const bar = {
        ts_sec: startSec + 60,
        open: Number(c[4]), high: Number(c[5]), low: Number(c[6]),
        close: Number(c[7]), volume: Number(c[8]),
      };
      if (Number.isFinite(bar.ts_sec) && bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0) out.push(bar);
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYahoo1m(ticker: string): Promise<EdgeBar[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=7d&includePrePost=true`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    if (!res.ok) return [];
    const json = await res.json() as {
      chart?: { result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{
          open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>;
          close?: Array<number | null>; volume?: Array<number | null>;
        }> };
      }> };
    };
    const r = json.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0];
    if (!r?.timestamp || !q) return [];
    const out: EdgeBar[] = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (o == null || h == null || l == null || c == null || !(c > 0)) continue;
      out.push({ ts_sec: r.timestamp[i] + 60, open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export const edge = new EdgeService();

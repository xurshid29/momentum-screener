// TickFeedService — the live "first detector" that runs ahead of the 20s
// Finviz poll. Owns the Python sidecar (Databento EQUS.MINI ohlcv-1s; see
// sidecar/tickfeed.py), feeds its per-second bars to the pure TickDetector,
// and hands any ignition candidate to the poller's alert path. Single-instance,
// like the other background services. OFF unless TICKFEED_ENABLED=true.
//
// The watched symbol set is the structural universe (UniverseService) — already
// the low-float / low-price candidate list — so a detected surge is inherently
// low-float; no per-candidate float gate needed. Prior closes come from the
// same universe fetch (no extra Finviz calls). See docs + the tick-feed memory.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TickDetector, type TickBar } from './tick-detect.js';
import { EmaCrossTracker, EMA_CROSS, EMA_CROSS_4H } from './ema-cross.js';
import { universe } from './universe.js';
import { poller } from './poller.js';
import { getDb } from '../db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TICKFEED = {
  enabled: process.env.TICKFEED_ENABLED === 'true',
  python: process.env.TICKFEED_PYTHON ?? 'python3',
  // sidecar lives at apps/api/sidecar/tickfeed.py; this file is dist/services or
  // src/services, so resolve up to the api root either way.
  sidecar: resolve(__dirname, '..', '..', 'sidecar', 'tickfeed.py'),
  sync_interval_ms: 10 * 60 * 1000, // re-send universe symbols + reseed prior closes
  // Fast additive sync of the CURRENT screener rows (momentum + ignition). The
  // structural universe refreshes only every 10 min, so a name that starts
  // running before it's in the universe used to wait up to 10 min just to get
  // subscribed — by which point it had no quiet baseline ("0 quiet" gapper).
  screen_sync_interval_ms: 30_000,
  initial_delay_ms: 30_000,         // let the universe populate before first SUB
  restart_delay_ms: 5_000,
};

// Databento HISTORICAL 5m bars for a BATCH of symbols — the primary backfill
// source (2026-07-16): same EQUS.MINI feed as our live stream, so volumes are
// the same feed-visible scale (kills the Yahoo consolidated-vs-MINI sibling
// caveat), contracted API, and one request covers ~100 symbols. Metered, but
// OHLCV-1m aggregates are tiny — a full 800-symbol × 3-day backfill bills
// on the order of cents-to-dollars. Fetches ohlcv-1m (no 5m schema exists)
// and aggregates 5→1 locally; returns ascending CLOSED bars in our bar-CLOSE
// convention. Null on failure → callers fall back to Yahoo.
// Historical availability lags real-time by a few minutes — an `end` past
// the dataset's available_end 422s. Clamp via metadata.get_dataset_range,
// memoized for 10 min.
let dbHistEnd: { endMs: number; at: number } | null = null;
async function databentoAvailableEnd(authHeader: string): Promise<number | null> {
  if (dbHistEnd && Date.now() - dbHistEnd.at < 10 * 60_000) return dbHistEnd.endMs;
  try {
    const res = await fetch('https://hist.databento.com/v0/metadata.get_dataset_range?dataset=EQUS.MINI', {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return null;
    const j = await res.json() as { end?: string };
    const endMs = j?.end ? Date.parse(j.end) : NaN;
    if (!Number.isFinite(endMs)) return null;
    dbHistEnd = { endMs, at: Date.now() };
    return endMs;
  } catch {
    return null;
  }
}

// Generic Databento historical fetch + local aggregation: source schema
// (ohlcv-1m for the 5m layer, ohlcv-1h for the 4h layer) over spanDays,
// re-bucketed to bucketSec with an optional anchor offset (the 4h grid is
// ET-session-aligned). Returns ascending CLOSED bars per symbol in our
// bar-CLOSE convention. Null on failure → callers fall back to Yahoo.
async function fetchDatabentoAgg(
  symbols: string[],
  schema: 'ohlcv-1m' | 'ohlcv-1h',
  spanDays: number,
  bucketSec: number,
  offsetSec = 0,
): Promise<Map<string, Array<{ closeTs: number; close: number; volume: number }>> | null> {
  const key = process.env.DATABENTO_API_KEY;
  if (!key || symbols.length === 0) return null;
  try {
    const authHeader = 'Basic ' + Buffer.from(`${key}:`).toString('base64');
    const availEnd = await databentoAvailableEnd(authHeader);
    const endMs = Math.min(Date.now(), (availEnd ?? Date.now() - 15 * 60_000)) - 1_000;
    const end = new Date(endMs);
    const start = new Date(endMs - spanDays * 86_400_000);
    const params = new URLSearchParams({
      dataset: 'EQUS.MINI',
      schema,
      symbols: symbols.join(','),
      stype_in: 'raw_symbol',
      start: start.toISOString(),
      end: end.toISOString(),
      encoding: 'csv',
      pretty_px: 'true',
      map_symbols: 'true',
    });
    const res = await fetch(`https://hist.databento.com/v0/timeseries.get_range?${params}`, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) {
      console.error(`[ema-backfill] databento hist HTTP ${res.status} (${schema}) — falling back to Yahoo`);
      return null;
    }
    const text = await res.text();
    const lines = text.split('\n');
    // header: ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
    const nowSec = Math.floor(Date.now() / 1000);
    const buckets = new Map<string, Map<number, { close: number; volume: number }>>();
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      if (c.length < 10) continue;
      const sec = Number(c[0].slice(0, -9)); // ns → s without float precision loss
      const close = parseFloat(c[7]);
      const vol = Number(c[8]);
      const sym = c[9]?.trim();
      if (!sym || !Number.isFinite(sec) || !(close > 0)) continue;
      const bStart = Math.floor((sec - offsetSec) / bucketSec) * bucketSec + offsetSec;
      if (bStart + bucketSec > nowSec - 30) continue; // still-open bucket
      let m = buckets.get(sym);
      if (!m) { m = new Map(); buckets.set(sym, m); }
      const b = m.get(bStart);
      if (b) { b.close = close; b.volume += vol; } // rows arrive ts-ascending → last close wins
      else m.set(bStart, { close, volume: Number.isFinite(vol) ? vol : 0 });
    }
    const out = new Map<string, Array<{ closeTs: number; close: number; volume: number }>>();
    for (const [sym, m] of buckets) {
      out.set(sym, [...m.entries()].sort((a, b) => a[0] - b[0]).map(([bs, b]) => ({ closeTs: bs + bucketSec, close: b.close, volume: b.volume })));
    }
    return out;
  } catch (err) {
    console.error(`[ema-backfill] databento hist fetch failed (${schema}) — falling back to Yahoo:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// Anchor offset for the 4h bucket grid so bars land on 04:00/08:00/12:00/
// 16:00 ET like TV's ETH 4h bars. Under EDT (UTC-4) the plain UTC 4h grid
// already matches (04:00 ET = 08:00 UTC); under EST (UTC-5) shift one hour.
function etBucketOffsetSec(): number {
  const now = new Date();
  const etH = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(now));
  const diff = ((now.getUTCHours() - etH) + 24) % 24; // 4 (EDT) or 5 (EST)
  return diff === 5 ? 3600 : 0;
}

// Yahoo 5m history for one symbol — the FALLBACK backfill source (free, no
// auth; the same endpoint the research studies used). Returns ascending
// CLOSED bars; the still-open bucket is dropped, and timestamps convert from
// Yahoo's bucket-OPEN convention to our bar-CLOSE one. ⚠️ Yahoo volumes are
// consolidated-tape scale (vs our MINI-scale live bars) — the sibling-volume
// window self-heals within ~1h of live tape.
async function fetchYahoo5m(ticker: string): Promise<Array<{ closeTs: number; close: number; volume: number }> | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=5m&range=5d&includePrePost=true`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json = await res.json() as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null>; volume?: Array<number | null> }> } }> };
    };
    const r0 = json?.chart?.result?.[0];
    const ts = r0?.timestamp ?? [];
    const q = r0?.indicators?.quote?.[0];
    if (ts.length === 0 || !q) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const out: Array<{ closeTs: number; close: number; volume: number }> = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (c == null || !(c > 0)) continue;
      const closeTs = Math.floor(ts[i] / 300) * 300 + 300;
      if (closeTs > nowSec - 30) continue; // still-open bucket
      out.push({ closeTs, close: c, volume: q.volume?.[i] ?? 0 });
    }
    return out;
  } catch {
    return null;
  }
}

function etDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

class TickFeedService {
  private detector = new TickDetector();
  // 📈 EMA 6/50 cross layer on 5m bars, known runners only — see ema-cross.ts.
  // Every LIVE closed bar is buffered for persistence (bars_5m) so the
  // ~50-bar warmup survives deploys; boot replays the last 48h.
  private emaCross = new EmaCrossTracker(EMA_CROSS, (ticker, closeTs, close, volume) => {
    this.barBuffer.push({ ticker, bar_ts: new Date(closeTs * 1000), close, volume });
  });
  // 📈 4h variant (2026-07-17) — the operator's swing-timing tool: same
  // tracker at interval 14400 with ET-session-aligned buckets, warmed from
  // bars_4h + a Databento ohlcv-1h backfill. Dashboard-only.
  private emaCross4h = new EmaCrossTracker(
    { ...EMA_CROSS_4H, bucket_offset_sec: etBucketOffsetSec() },
    (ticker, closeTs, close, volume) => {
      this.bar4hBuffer.push({ ticker, bar_ts: new Date(closeTs * 1000), close, volume });
    },
  );
  private barBuffer: { ticker: string; bar_ts: Date; close: number; volume: number }[] = [];
  private bar4hBuffer: { ticker: string; bar_ts: Date; close: number; volume: number }[] = [];
  private backfillAttempted4h = new Set<string>();
  private barFlushTimer: NodeJS.Timeout | null = null;
  private barsPersisted = 0;
  private lastBarDbErrorMs = 0;
  // Historical 5m backfill for known runners still below EMA warmup —
  // Databento hist (batched) primary, Yahoo per-symbol fallback. Closes a
  // symbol's one-time cold start (new universe entrants, freshly minted
  // known runners) without waiting hours of live tape.
  private backfillTimer: NodeJS.Timeout | null = null;
  private backfillRunning = false;
  private backfillAttempted = new Set<string>();  // once per ET day per symbol
  private backfilledOk = 0;
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private screenSyncTimer: NodeJS.Timeout | null = null;
  private running = false;
  private etDate = etDate();
  private lastBarAt = 0;
  private barsSeen = 0;
  private accums = 0;
  private watches = 0;
  private candidates = 0;   // confirms (kept as `candidates` for /health continuity)
  private fades = 0;
  private lastError: string | null = null;
  // Screener-row symbols subscribed OUTSIDE the structural universe (fast-sync
  // path). Re-SUBbed alongside the universe so sidecar respawns keep them.
  private extraSubs = new Set<string>();
  // AH rows with a daily-close lookup in flight — dedupes the 30s sync ticks.
  private pendingPrior = new Set<string>();

  status() {
    return {
      enabled: TICKFEED.enabled,
      running: this.running,
      symbols_tracked: this.detector.symbolsTracked(),
      ema_cross_tracked: this.emaCross.symbolsTracked(),
      ema_cross_4h_tracked: this.emaCross4h.symbolsTracked(),
      ema_bars_persisted: this.barsPersisted,
      ema_backfilled: this.backfilledOk,
      bars_seen: this.barsSeen,
      accums: this.accums,
      watches: this.watches,
      candidates: this.candidates,
      fades: this.fades,
      extra_subs: this.extraSubs.size,
      last_bar_age_s: this.lastBarAt ? Math.round((Date.now() - this.lastBarAt) / 1000) : null,
      last_error: this.lastError,
    };
  }

  start(): void {
    if (!TICKFEED.enabled) {
      console.log('[tickfeed] disabled (set TICKFEED_ENABLED=true to enable)');
      return;
    }
    if (this.running) return;
    this.running = true;
    console.log('[tickfeed] starting');
    // Seed the EMA-cross tracker from persisted bars BEFORE the sidecar
    // starts streaming, so live ticks can't interleave with the replay.
    void this.seedEmaBars().finally(() => {
      if (!this.running) return;
      this.spawnSidecar();
      setTimeout(() => this.sync(), TICKFEED.initial_delay_ms);
      this.syncTimer = setInterval(() => this.sync(), TICKFEED.sync_interval_ms);
      this.screenSyncTimer = setInterval(() => this.syncScreenRows(), TICKFEED.screen_sync_interval_ms);
      this.barFlushTimer = setInterval(() => this.flushBars(), 5_000);
      // Backfill under-warmed known runners from Yahoo shortly after boot
      // (the DB seed above has already run, so the scan sees what's missing),
      // then re-scan periodically for symbols that entered the set mid-day.
      setTimeout(() => void this.scanBackfill(), 120_000);
      this.backfillTimer = setInterval(() => void this.scanBackfill(), 4 * 3600_000);
    });
  }

  stop(): void {
    this.running = false;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    if (this.screenSyncTimer) clearInterval(this.screenSyncTimer);
    this.screenSyncTimer = null;
    if (this.barFlushTimer) clearInterval(this.barFlushTimer);
    this.barFlushTimer = null;
    if (this.backfillTimer) clearInterval(this.backfillTimer);
    this.backfillTimer = null;
    this.flushBars();
    this.rl?.close();
    this.child?.kill();
    this.child = null;
  }

  // Replay persisted bars through the trackers so the EMA(6/50) warmups
  // survive deploys — 5m from bars_5m (48h), 4h from bars_4h (40d). Three
  // deploys on 2026-07-14 left the 5m layer silent all of 07-15 — this
  // closes that; the 4h layer can NEVER warm up live (~2-3 weeks of bars),
  // so its replay + the Databento backfill are load-bearing, not resilience.
  private async seedEmaBars(): Promise<void> {
    try {
      const rows = await getDb()
        .selectFrom('bars_5m')
        .select(['ticker', 'bar_ts', 'close', 'volume'])
        .where('bar_ts', '>', new Date(Date.now() - 48 * 3600_000))
        .orderBy('ticker', 'asc')
        .orderBy('bar_ts', 'asc')
        .execute();
      const syms = new Set<string>();
      for (const r of rows) {
        this.emaCross.seedBar(r.ticker, Math.floor(new Date(r.bar_ts).getTime() / 1000), Number(r.close), Number(r.volume));
        syms.add(r.ticker);
      }
      console.log(`[ema-cross] seeded ${rows.length} closed 5m bars for ${syms.size} symbols (48h) — warmup carried over`);
    } catch (err) {
      console.error('[ema-cross] bar seed failed (continuing unseeded):', err instanceof Error ? err.message : err);
    }
    try {
      const rows = await getDb()
        .selectFrom('bars_4h')
        .select(['ticker', 'bar_ts', 'close', 'volume'])
        .where('bar_ts', '>', new Date(Date.now() - 130 * 86_400_000))
        .orderBy('ticker', 'asc')
        .orderBy('bar_ts', 'asc')
        .execute();
      const syms = new Set<string>();
      for (const r of rows) {
        this.emaCross4h.seedBar(r.ticker, Math.floor(new Date(r.bar_ts).getTime() / 1000), Number(r.close), Number(r.volume));
        syms.add(r.ticker);
      }
      console.log(`[ema-cross] seeded ${rows.length} closed 4h bars for ${syms.size} symbols (130d)`);
    } catch (err) {
      console.error('[ema-cross] 4h bar seed failed (continuing unseeded):', err instanceof Error ? err.message : err);
    }
  }

  // Find known runners still below EMA warmup (< warmup-ish bar count in
  // bars_5m over 5 days) and backfill them, once per symbol per ET day:
  // Databento historical first (batched ~100 symbols/request, same EQUS.MINI
  // scale as the live stream — no volume-scale skew), Yahoo per-symbol as the
  // fallback for request failures and names too thin to print on MINI in 3d.
  // Fetched closes seed the tracker directly ONLY while the symbol has
  // produced no live bar (ordering safety); bars within 72h also persist so
  // the next boot's DB replay covers them. ⚠️ The Yahoo path's volumes are
  // consolidated-tape scale while live bars are MINI-feed scale — fine for
  // the EMA math (closes are closes); the sibling-volume window self-heals
  // within ~an hour of live tape (ratios read LOW until then), and the
  // confirm notional floor guards the thin-tape residual either way.
  private async scanBackfill(): Promise<void> {
    if (this.backfillRunning || !this.running) return;
    this.backfillRunning = true;
    try {
      const counts = new Map<string, number>();
      const rows = await getDb()
        .selectFrom('bars_5m')
        .select(['ticker', (eb) => eb.fn.countAll<number>().as('n')])
        .where('bar_ts', '>', new Date(Date.now() - 5 * 86_400_000))
        .groupBy('ticker')
        .execute();
      for (const r of rows) counts.set(r.ticker, Number(r.n));
      const targets: string[] = [];
      for (const tk of poller.getKnownRunners()) {
        if (this.backfillAttempted.has(tk)) continue;
        if ((counts.get(tk) ?? 0) >= 50) continue;
        targets.push(tk);
        if (targets.length >= 800) break;
      }
      if (targets.length > 0) {
        console.log(`[ema-backfill] ${targets.length} known runners below warmup — Databento hist (Yahoo fallback)`);
        let ok = 0, seeded = 0, persisted = 0, viaYahoo = 0;
        const CHUNK = 100;
        for (let i = 0; i < targets.length; i += CHUNK) {
          if (!this.running) return;
          const chunk = targets.slice(i, i + CHUNK);
          chunk.forEach((t) => this.backfillAttempted.add(t));
          const batch = await fetchDatabentoAgg(chunk, 'ohlcv-1m', 3, 300);
          for (const tk of chunk) {
            if (!this.running) return;
            let bars = batch?.get(tk) ?? null;
            if (!bars || bars.length === 0) {
              // Batch failed, or this symbol printed nothing on MINI in 3d —
              // try Yahoo (consolidated tape sees more of the thin names).
              bars = await fetchYahoo5m(tk);
              await new Promise((r) => setTimeout(r, 1_500));
              if (bars && bars.length > 0) viaYahoo++;
            }
            if (!bars || bars.length === 0) continue;
            ok++;
            const r = this.applyBackfillBars(tk, bars);
            seeded += r.seeded;
            persisted += r.persisted;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        this.backfilledOk += ok;
        console.log(`[ema-backfill] done — ${ok}/${targets.length} backfilled (${viaYahoo} via Yahoo), ${seeded} tracker-seeded, ${persisted} bars persisted`);
      }
      await this.scanBackfill4h();
    } catch (err) {
      console.error('[ema-backfill] scan failed (continuing):', err instanceof Error ? err.message : err);
    } finally {
      this.backfillRunning = false;
    }
  }

  // 4h-layer backfill: 120 days of Databento ohlcv-1h aggregated to the
  // ET-aligned 4h grid — batched 100 symbols/request. Depth matters more
  // than warmup here (the WOK lesson, 2026-07-17): a 4h EMA50 spans ~50
  // bars ≈ 5 weeks, so a 35d window made our EMA50 ≈ the recent flat
  // average (2.02) while TV's — with months of memory — was still way
  // above (2.63) after WOK's collapse, and a $2.04 uptick "crossed". ~150
  // bars of history puts the SMA seed's influence under ~2% and our EMA50
  // within pennies of TV's. Skip a symbol once it has ≥150 banked bars OR
  // its banked history already reaches back ≥100d (recently-listed names
  // can never satisfy either — the once/day attempt set bounds their cost).
  // No Yahoo fallback: a name that printed nothing on MINI has no usable
  // sibling baseline anyway. Persists to bars_4h (130d retention) so
  // subsequent boots seed from the DB.
  private async scanBackfill4h(): Promise<void> {
    const have = new Map<string, { n: number; earliestMs: number }>();
    const rows = await getDb()
      .selectFrom('bars_4h')
      .select(['ticker',
        (eb) => eb.fn.countAll<number>().as('n'),
        (eb) => eb.fn.min('bar_ts').as('earliest'),
      ])
      .where('bar_ts', '>', new Date(Date.now() - 130 * 86_400_000))
      .groupBy('ticker')
      .execute();
    for (const r of rows) have.set(r.ticker, { n: Number(r.n), earliestMs: new Date(r.earliest as Date).getTime() });
    const deepEnoughMs = Date.now() - 100 * 86_400_000;
    const targets: string[] = [];
    for (const tk of poller.getKnownRunners()) {
      if (this.backfillAttempted4h.has(tk)) continue;
      const h = have.get(tk);
      if (h && (h.n >= 150 || h.earliestMs <= deepEnoughMs)) continue;
      targets.push(tk);
      if (targets.length >= 1600) break;
    }
    if (targets.length === 0) return;
    console.log(`[ema-backfill] 4h: ${targets.length} known runners below EMA-convergence depth — Databento ohlcv-1h (120d)`);
    let ok = 0, seeded = 0, persisted = 0;
    const CHUNK = 100;
    const off = etBucketOffsetSec();
    for (let i = 0; i < targets.length; i += CHUNK) {
      if (!this.running) return;
      const chunk = targets.slice(i, i + CHUNK);
      chunk.forEach((t) => this.backfillAttempted4h.add(t));
      const batch = await fetchDatabentoAgg(chunk, 'ohlcv-1h', 120, 14_400, off);
      if (!batch) return; // hist API unavailable — retry next scan
      for (const tk of chunk) {
        const bars = batch.get(tk);
        if (!bars || bars.length === 0) continue;
        ok++;
        if (this.emaCross4h.canSeed(tk)) {
          for (const b of bars) this.emaCross4h.seedBar(tk, b.closeTs, b.close, b.volume);
          seeded++;
        }
        persisted += bars.length;
        void getDb()
          .insertInto('bars_4h')
          .values(bars.map((b) => ({ ticker: tk, bar_ts: new Date(b.closeTs * 1000), close: b.close, volume: b.volume })))
          .onConflict((oc) => oc.columns(['ticker', 'bar_ts']).doNothing())
          .execute()
          .catch(() => { /* non-critical */ });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`[ema-backfill] 4h done — ${ok}/${targets.length} backfilled, ${seeded} tracker-seeded, ${persisted} bars persisted`);
  }

  // Apply fetched history for one symbol: direct-seed the tracker only while
  // it has produced no live bar (ordering safety, re-checked here — after the
  // fetch), and persist the recent 72h slice for the next boot's replay.
  private applyBackfillBars(tk: string, bars: Array<{ closeTs: number; close: number; volume: number }>): { seeded: number; persisted: number } {
    let seeded = 0;
    if (this.emaCross.canSeed(tk)) {
      for (const b of bars.slice(-120)) this.emaCross.seedBar(tk, b.closeTs, b.close, b.volume);
      seeded = 1;
    }
    const recent = bars.filter((b) => b.closeTs * 1000 > Date.now() - 72 * 3600_000);
    if (recent.length > 0) {
      void getDb()
        .insertInto('bars_5m')
        .values(recent.map((b) => ({ ticker: tk, bar_ts: new Date(b.closeTs * 1000), close: b.close, volume: b.volume })))
        .onConflict((oc) => oc.columns(['ticker', 'bar_ts']).doNothing())
        .execute()
        .catch(() => { /* non-critical */ });
    }
    return { seeded, persisted: recent.length };
  }

  private flushBars(): void {
    if (this.barBuffer.length > 0) {
      const rows = this.barBuffer.splice(0);
      void getDb()
        .insertInto('bars_5m')
        .values(rows)
        .onConflict((oc) => oc.columns(['ticker', 'bar_ts']).doNothing())
        .execute()
        .then(() => { this.barsPersisted += rows.length; })
        .catch((err) => {
          const now = Date.now();
          if (now - this.lastBarDbErrorMs > 60_000) {
            this.lastBarDbErrorMs = now;
            console.error('[ema-cross] bar persist failed (continuing):', err instanceof Error ? err.message : err);
          }
        });
    }
    if (this.bar4hBuffer.length > 0) {
      const rows = this.bar4hBuffer.splice(0);
      void getDb()
        .insertInto('bars_4h')
        .values(rows)
        .onConflict((oc) => oc.columns(['ticker', 'bar_ts']).doNothing())
        .execute()
        .catch(() => { /* same error-throttle class as above; low volume */ });
    }
  }

  private spawnSidecar(): void {
    try {
      const child = spawn(TICKFEED.python, [TICKFEED.sidecar], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      this.child = child;
      this.rl = createInterface({ input: child.stdout });
      this.rl.on('line', (line) => this.onBar(line));
      child.stderr.on('data', (b) => {
        const s = String(b);
        process.stderr.write(`[tickfeed.py] ${s}`);
        // Surface real errors to /health so a wedged feed isn't silently shown
        // as "running" (the 2026-06-22 Databento connection-limit incident,
        // where bars_seen sat at 0 for ~21h with last_error null).
        if (/error|bentoerror|connection limit|traceback/i.test(s)) {
          this.lastError = s.replace(/\s+/g, ' ').trim().slice(0, 300);
        }
      });
      child.on('exit', (code) => {
        console.error(`[tickfeed] sidecar exited (code ${code}) — restarting`);
        this.child = null;
        if (this.running) setTimeout(() => this.spawnSidecar(), TICKFEED.restart_delay_ms);
      });
      console.log(`[tickfeed] sidecar spawned: ${TICKFEED.python} ${TICKFEED.sidecar}`);
      // Re-send the universe shortly after every spawn (incl. respawns) so a
      // restarted sidecar gets its SUB promptly instead of waiting for the
      // 10-min sync timer and tripping its own 120s no-symbols exit. On the
      // very first spawn the universe is usually still empty here — the +30s
      // initial sync covers that; this matters for respawns.
      setTimeout(() => { if (this.running && this.child === child) this.sync(); }, 3000);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[tickfeed] failed to spawn sidecar:', this.lastError);
    }
  }

  // Push the current universe symbols to the sidecar (additive subscribe) and
  // reseed prior closes. Also handles the midnight-ET session roll.
  private sync(): void {
    const today = etDate();
    if (today !== this.etDate) {
      this.etDate = today;
      this.detector.reset();
      this.emaCross.resetDaily();
      this.emaCross4h.resetDaily();
      this.emaCross4h.setBucketOffset(etBucketOffsetSec()); // DST roll-over safe
      this.extraSubs.clear();
      this.backfillAttempted.clear();
      this.backfillAttempted4h.clear();
      // Prune persisted bars beyond their seed windows (fire-and-forget).
      void getDb()
        .deleteFrom('bars_5m')
        .where('bar_ts', '<', new Date(Date.now() - 3 * 86_400_000))
        .execute()
        .catch(() => { /* retried next midnight */ });
      void getDb()
        .deleteFrom('bars_4h')
        .where('bar_ts', '<', new Date(Date.now() - 130 * 86_400_000))
        .execute()
        .catch(() => { /* retried next midnight */ });
      // Fresh Databento session for the new day.
      this.child?.kill();
      console.log('[tickfeed] midnight ET — detector reset, sidecar will respawn');
    }
    const priors = universe.getPriorCloses();
    for (const [t, c] of priors) this.detector.setPriorClose(t, c);
    const syms = Array.from(new Set([...universe.getUniverse(), ...this.extraSubs]));
    if (syms.length > 0 && this.child?.stdin.writable) {
      this.subscribe(syms);
      console.log(`[tickfeed] synced ${syms.length} symbols (${this.extraSubs.size} extra), ${priors.size} prior closes`);
    }
  }

  // Fast additive sync: subscribe the CURRENT screener rows (momentum +
  // ignition) the moment they appear, instead of waiting for the 10-min
  // universe refresh. Prior close is derived from the row itself
  // (price / (1 + change%/100)) — skipped in after-hours, where row
  // change/price are the AH overlay (anchored to today's close, not the prior
  // one) and would corrupt the detector's cum% measurement.
  // Also arms NEWS RADAR names (payload.news_radar): a fresh catalyst on a
  // known runner that isn't moving yet — subscribing NOW means the watch/
  // confirm machine is already listening when the move starts. Radar entries
  // carry a daily_bars prior close, which is session-independent.
  private syncScreenRows(): void {
    const payload = poller.getLastPayload();
    if (!payload || payload.session === 'closed') return;
    const fresh: string[] = [];
    if (payload.session !== 'afterhours') {
      for (const r of [...payload.rows, ...payload.ignition]) {
        const tk = r.ticker.toUpperCase();
        if (this.detector.hasPriorClose(tk) || this.extraSubs.has(tk)) continue;
        if (r.price == null || r.change_pct == null || r.price <= 0 || r.change_pct <= -100) continue;
        this.detector.setPriorClose(tk, r.price / (1 + r.change_pct / 100));
        this.extraSubs.add(tk);
        fresh.push(tk);
      }
    } else {
      // After-hours: row change/price are the AH overlay (anchored to TODAY's
      // close), so deriving a prior from them is wrong. Anchor on the latest
      // stored daily close instead — same as news-radar arming. Without this,
      // an AH runner outside the structural universe (whose membership is
      // frozen after 4pm) stays invisible to the detector for its entire run
      // (UPC 2026-07-02: on Momentum at 16:03 ET, first tick bar 16:33).
      for (const r of [...payload.rows, ...payload.ignition]) {
        const tk = r.ticker.toUpperCase();
        if (this.detector.hasPriorClose(tk) || this.extraSubs.has(tk) || this.pendingPrior.has(tk)) continue;
        this.pendingPrior.add(tk);
        void poller.lookupPriorClose(tk).then((pc) => {
          this.pendingPrior.delete(tk);
          if (pc == null || pc <= 0) return;
          if (this.detector.hasPriorClose(tk) || this.extraSubs.has(tk)) return;
          this.detector.setPriorClose(tk, pc);
          this.extraSubs.add(tk);
          this.subscribe([tk]);
          console.log(`[tickfeed] screen-sync (AH) — subscribed ${tk} (daily close $${pc})`);
        });
      }
    }
    for (const n of payload.news_radar ?? []) {
      const tk = n.ticker.toUpperCase();
      if (this.detector.hasPriorClose(tk) || this.extraSubs.has(tk)) continue;
      if (n.prior_close == null || n.prior_close <= 0) continue;
      this.detector.setPriorClose(tk, n.prior_close);
      this.extraSubs.add(tk);
      fresh.push(tk);
    }
    if (fresh.length > 0 && this.child?.stdin.writable) {
      this.subscribe(fresh);
      console.log(`[tickfeed] screen-sync — subscribed ${fresh.length} names: ${fresh.join(',')}`);
    }
  }

  private subscribe(syms: string[]): void {
    if (!this.child?.stdin.writable) return;
    // Chunk into modest SUB lines — a single 3000+-symbol line risked being
    // split across the sidecar's stdin reads ("unknown command: …"). Each
    // line is a complete, newline-terminated SUB it can parse independently.
    const CHUNK = 400;
    for (let i = 0; i < syms.length; i += CHUNK) {
      this.child.stdin.write(`SUB ${syms.slice(i, i + CHUNK).join(',')}\n`);
    }
  }

  private onBar(line: string): void {
    let m: { t: number; s: string; o: number; h: number; l: number; c: number; v: number };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!m || typeof m.s !== 'string' || typeof m.c !== 'number') return;
    this.barsSeen++;
    this.lastBarAt = Date.now();
    if (this.lastError) this.lastError = null; // bars flowing again — clear the stale error
    const bar: TickBar = { ts_sec: m.t, close: m.c, high: m.h, low: m.l, volume: m.v };
    const ev = this.detector.addBar(m.s, bar);
    if (ev) {
      if (ev.type === 'accum') this.accums++;
      else if (ev.type === 'watch') this.watches++;
      else if (ev.type === 'confirm') this.candidates++;
      else this.fades++;
      poller.onTickEvent(ev);
    }
    // 📈 EMA-cross layers (5m + 4h) — known runners only (the operator's
    // spec: "check our momentum tickers of our database"), everything else
    // skips the trackers.
    if (poller.isKnownRunner(m.s)) {
      const xev = this.emaCross.addBar(m.s, m.t, m.c, m.v);
      if (xev) poller.onEmaCrossEvent(xev);
      const xev4 = this.emaCross4h.addBar(m.s, m.t, m.c, m.v);
      if (xev4) poller.onEmaCrossEvent(xev4);
    }
    // Surface near-miss reasons (gapped vs which gate) so the rollout is
    // debuggable — why a moving name didn't fire.
    const diag = this.detector.drainDiagnostics();
    for (const d of diag) console.log(`[tickfeed] near-miss: ${d}`);
  }
}

export const tickfeed = new TickFeedService();

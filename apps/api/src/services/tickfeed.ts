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
import { EmaCrossTracker, EMA_CROSS, EMA_CROSS_15M, EMA_CROSS_1H, EMA_CROSS_4H, EMA_CROSS_1D, adjustSplitHistory, type SeedHistoryBar } from './ema-cross.js';
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
// Historical availability lags real-time — an `end` past the AVAILABLE end
// 422s. Crucially the bound is PER SCHEMA: get_dataset_range's top-level
// `end` is the max across schemas (mbp-1 is near-real-time) and even reads
// rounded forward, while ohlcv-1h only rolls forward once an hour — clamping
// to the top-level end 422'd every chunk of the first 4h pass
// (`data_schema_not_fully_available`, 2026-07-17). Memoized 10 min per
// schema.
const dbHistEnds = new Map<string, { endMs: number; at: number }>();
async function databentoSchemaEnd(authHeader: string, schema: string): Promise<number | null> {
  const c = dbHistEnds.get(schema);
  if (c && Date.now() - c.at < 10 * 60_000) return c.endMs;
  try {
    const res = await fetch('https://hist.databento.com/v0/metadata.get_dataset_range?dataset=EQUS.MINI', {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return null;
    const j = await res.json() as { end?: string; schema?: Record<string, { end?: string }> };
    const raw = j?.schema?.[schema]?.end ?? j?.end;
    const endMs = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(endMs)) return null;
    dbHistEnds.set(schema, { endMs, at: Date.now() });
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
    const availEnd = await databentoSchemaEnd(authHeader, schema);
    // Clamp to the schema's own availability (see databentoSchemaEnd). If
    // the metadata call fails, fall back a full hour — safe for every
    // schema we use, and backfill never needs the most recent bars.
    const endMs = Math.min(Date.now() - 60_000, availEnd ?? (Date.now() - 3600_000)) - 1_000;
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
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      console.error(`[ema-backfill] databento hist HTTP ${res.status} (${schema}): ${body}`);
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
      if (isEtWeekendSec(sec)) continue; // exchange test-session prints
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
function etUtcOffsetHours(): number {
  const now = new Date();
  const etH = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(now));
  return ((now.getUTCHours() - etH) + 24) % 24; // 4 (EDT) or 5 (EST)
}

function etBucketOffsetSec(): number {
  return etUtcOffsetHours() === 5 ? 3600 : 0;
}

// Daily buckets anchor at 04:00 ET (the ETH day open, matching the news-day
// roll): 08:00 UTC under EDT, 09:00 under EST.
function etDailyOffsetSec(): number {
  return ((4 + etUtcOffsetHours()) % 24) * 3600;
}

// ET day-of-week now (0=Sun … 6=Sat, epoch day 0 = Thursday).
function etDowNow(): number {
  return (Math.floor((Date.now() / 1000 - etUtcOffsetHours() * 3600) / 86_400) + 4) % 7;
}

// Corrupt-series guard (2026-07-27, the PFSA 4h poison): Databento's raw
// ohlcv for some symbols interleaves TWO price scales (~25× apart, months
// long — premarket/AH buckets vs regular-session buckets; publisher/
// instrument mixing in the source). No real series has a large share of
// consecutive bars moving ±100%, and the split-adjuster "correcting" the
// endless flip-flops inflated PFSA's seeded 4h EMA65 to $2,455 on a $1.70
// stock. A series that trips this is discarded so the Yahoo (consolidated,
// clean) fallback takes over.
function seriesLooksCorrupt(bars: Array<{ close: number }>): boolean {
  if (bars.length < 8) return false;
  let wild = 0;
  for (let i = 1; i < bars.length; i++) {
    const r = bars[i].close / bars[i - 1].close;
    if (r >= 2 || r <= 0.5) wild++;
  }
  if (wild / (bars.length - 1) > 0.10) return true;
  // Amplitude criterion (2026-07-27, the EDBL poison): a SINGLE wildly
  // off-scale print (EDBL's 4h series carried a bar that pushed its seeded
  // EMA65 to $4.3M) slips past the flip-flop frequency test above. Any bar
  // ≥20× or ≤1/20 of the series median is data corruption, not price
  // action — genuine 20×-range multi-month runners exist, and they simply
  // take the Yahoo fallback instead, which is accurate for them too.
  const sorted = bars.map((b) => b.close).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  if (!(med > 0)) return true;
  return sorted[sorted.length - 1] / med >= 20 || sorted[0] / med <= 1 / 20;
}

// ET-weekend check for an arbitrary epoch second. The HISTORICAL fetchers
// must drop weekend source rows too (2026-07-27, the FFAI lesson): the live
// sidecar gate can't help a backfill, and Saturday's exchange test prints
// (pre-04:00 ET) landed INSIDE Friday's still-open daily bucket — FFAI's
// Friday close banked as $6.50 (post-split test basis) instead of $0.074.
function isEtWeekendSec(sec: number): boolean {
  const dow = (Math.floor((sec - etUtcOffsetHours() * 3600) / 86_400) + 4) % 7;
  return dow === 0 || dow === 6;
}

// Epoch ms of the most recent WEEKDAY 20:00 ET — the last moment a live bar
// could have printed. The staleness reference on weekends (see below).
function lastSessionCloseMs(): number {
  const offH = etUtcOffsetHours();
  for (let i = 0; i < 7; i++) {
    const dayIdx = Math.floor((Date.now() / 1000 - offH * 3600) / 86_400) - i;
    const dow = (dayIdx + 4) % 7;
    if (dow === 0 || dow === 6) continue;
    const closeMs = (dayIdx * 86_400 + (20 + offH) * 3600) * 1000;
    if (closeMs <= Date.now()) return closeMs;
  }
  return Date.now() - 86_400_000;
}

// Epoch seconds of the most recent 04:00 ET session open — the EMA trackers'
// stale-guard anchor (see EmaCrossConfig.stale_gap_bars).
function lastSessionOpenSec(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const openMod = (((4 + etUtcOffsetHours()) % 24) * 3600); // 04:00 ET in UTC seconds-of-day
  const rem = ((nowSec % 86_400) - openMod + 86_400) % 86_400;
  return nowSec - rem;
}

// Yahoo 5m history for one symbol — the FALLBACK backfill source (free, no
// auth; the same endpoint the research studies used). Returns ascending
// CLOSED bars; the still-open bucket is dropped, and timestamps convert from
// Yahoo's bucket-OPEN convention to our bar-CLOSE one. ⚠️ Yahoo volumes are
// consolidated-tape scale (vs our MINI-scale live bars) — the sibling-volume
// window self-heals within ~1h of live tape.
async function fetchYahoo5mRange(ticker: string, range: string): Promise<Array<{ closeTs: number; close: number; volume: number }> | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=5m&range=${range}&includePrePost=true`;
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
      if (isEtWeekendSec(ts[i])) continue; // exchange test-session prints
      const closeTs = Math.floor(ts[i] / 300) * 300 + 300;
      if (closeTs > nowSec - 30) continue; // still-open bucket
      out.push({ closeTs, close: c, volume: q.volume?.[i] ?? 0 });
    }
    return out;
  } catch {
    return null;
  }
}

// Warmup is a BAR COUNT, so the fetch window has to be too (2026-07-28, the
// FIEE hole). A fixed 5-day range silently assumes ~192 buckets/day of
// prints; a name that trades in bursts returns a fraction of that and can
// NEVER reach the 65-bar warmup, however often we refetch — FIEE's whole
// consolidated week was 86 bars, so its slow EMA stayed null through a +156%
// move. Widen the calendar until the bar count is there: 5d covers dense
// names in one call (they never escalate), 1mo carries the trickle class
// (FIEE: 178), 60d is the floor for the very thinnest (FIEE: 688). Both
// callers below are thin-by-construction, so the escalation is the common
// path for them and free for everyone else.
async function fetchYahoo5m(ticker: string, minBars = 0): Promise<Array<{ closeTs: number; close: number; volume: number }> | null> {
  let bars = await fetchYahoo5mRange(ticker, '5d');
  for (const range of ['1mo', '60d']) {
    if ((bars?.length ?? 0) >= minBars) break;
    await new Promise((r) => setTimeout(r, 400));
    const deeper = await fetchYahoo5mRange(ticker, range);
    if (deeper && deeper.length > (bars?.length ?? 0)) bars = deeper;
  }
  return bars;
}

// Yahoo 1h history re-bucketed to an HTF grid — the HTF layers' consolidated
// fallback (2026-07-22, the TV-log audit): six of eleven TV-alerted 1h
// crosses were invisible because those names print (almost) nothing on MINI
// and the HTF backfill had no Yahoo path — their bars_1h series were 12-22h
// stale and the EMAs never saw the day's move. Same volume-scale caveat as
// the 5m fallback: consolidated volumes read sibling ratios LOW (misses,
// never false confirms).
async function fetchYahooHtfAgg(
  ticker: string,
  yahooInterval: string,
  yahooRange: string,
  bucketSec: number,
  offsetSec: number,
): Promise<Array<{ closeTs: number; close: number; volume: number }> | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${yahooInterval}&range=${yahooRange}&includePrePost=true`;
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
    const buckets = new Map<number, { close: number; volume: number }>();
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (c == null || !(c > 0)) continue;
      if (isEtWeekendSec(ts[i])) continue; // exchange test-session prints
      const bStart = Math.floor((ts[i] - offsetSec) / bucketSec) * bucketSec + offsetSec;
      if (bStart + bucketSec > nowSec - 30) continue; // still-open bucket
      const b = buckets.get(bStart);
      const v = q.volume?.[i] ?? 0;
      if (b) { b.close = c; b.volume += v; } // timestamps ascend → last close wins
      else buckets.set(bStart, { close: c, volume: v });
    }
    return [...buckets.entries()].sort((a, b) => a[0] - b[0])
      .map(([bs, b]) => ({ closeTs: bs + bucketSec, close: b.close, volume: b.volume }));
  } catch {
    return null;
  }
}

function etDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// One higher-timeframe (HTF) EMA-cross layer: tracker + its persistence
// table + Databento backfill parameters. Adding/removing an interval =
// one entry here + its bars_* migration; everything else (boot seed, live
// feed, persistence, retention, backfill, /health) loops this list. The 5m
// layer stays bespoke: its warmup fits inside bars_5m's replay window.
interface HtfLayer {
  cfg: import('./ema-cross.js').EmaCrossConfig;
  tracker: EmaCrossTracker;
  table: 'bars_15m' | 'bars_1h' | 'bars_4h' | 'bars_1d';
  buffer: { ticker: string; bar_ts: Date; close: number; volume: number }[];
  attempted: Map<string, number>; // last backfill attempt (ms) — retry after ATTEMPT_RETRY_MS
  spanDays: number;          // backfill fetch depth (EMA-convergence, not warmup)
  retentionDays: number;     // table retention = boot-seed window
  minBars: number;           // banked bars that count as "converged"
  deepDays: number;          // or banked history reaching this far back
  offset: () => number;      // bucket anchor (recomputed at midnight for DST)
  schema: 'ohlcv-1m' | 'ohlcv-1h';  // Databento source granularity
  yahooInterval: string;     // Yahoo fallback interval + range for this grid
  yahooRange: string;
}

// Minimum spacing between backfill attempts for one symbol on an HTF layer.
// Two hours: stale MINI-quiet names get a few consolidated top-ups per
// session without hammering Yahoo (they are the bulk of the target list).
const ATTEMPT_RETRY_MS = 2 * 3600_000;

// Warm-but-sparse floor for the 5m consolidated re-seed (2026-07-23, the
// CPHI lesson): a name past warmup can still be MINI-sparse — the median
// known runner banks ~33 five-minute bars/day vs ~192 ETH buckets, so its
// 65-bar slow EMA spans DAYS while TV's spans hours (CPHI: our EMA65 $1.88
// vs TV's $1.74 → the cross fired 15 min late at the top of the move).
// The criterion is banked bars over the LAST 24h (dense ETH day ≈ 192;
// the CPHI class banks 30–60) — a 24h window so the day-one sweep's
// persisted Yahoo bars stop distorting the read by the next day, and
// Monday-morning full sweeps stay bounded by the per-scan cap.
const SPARSE_5M_MIN_BARS_24H = 120;
// Per-scan bound on the sparse sweep — Yahoo is per-symbol at ~2s each, so
// one scan covers the most-recently-active names and the hourly rescans
// work through the rest (deferrals are logged, not silent). Retries per
// symbol every ATTEMPT_RETRY_MS (2h), NOT once/day: the RELL/LFMD lesson
// (2026-07-23 afternoon) — divergence vs the consolidated tape
// re-accumulates within hours on MINI-quiet names (RELL re-fired a
// morning TV cross as "fresh" at 12:50; LFMD crossed while TV's fast sat
// 3% below its slow), so the re-anchor must repeat intraday.
const SPARSE_5M_MAX_PER_SCAN = 400;

function makeHtfLayer(
  cfg: import('./ema-cross.js').EmaCrossConfig,
  table: HtfLayer['table'],
  opts: {
    spanDays: number; retentionDays: number; deepDays: number; offset: () => number;
    schema: HtfLayer['schema']; yahooInterval: string; yahooRange: string;
  },
): HtfLayer {
  const layer: HtfLayer = {
    cfg, table, buffer: [], attempted: new Map(),
    spanDays: opts.spanDays, retentionDays: opts.retentionDays,
    // EMA(65) needs ~190 banked bars for the SMA seed's influence to drop
    // under ~2% (was 150 for EMA50) — round up for margin.
    minBars: 200, deepDays: opts.deepDays, offset: opts.offset,
    schema: opts.schema, yahooInterval: opts.yahooInterval, yahooRange: opts.yahooRange,
    tracker: null as unknown as EmaCrossTracker,
  };
  layer.tracker = new EmaCrossTracker(
    { ...cfg, bucket_offset_sec: opts.offset() },
    (ticker, closeTs, close, volume) => {
      layer.buffer.push({ ticker, bar_ts: new Date(closeTs * 1000), close, volume });
    },
  );
  return layer;
}

class TickFeedService {
  private detector = new TickDetector();
  // 📈 EMA cross layer (10/65) on 5m bars, known runners only — see
  // ema-cross.ts. Every LIVE closed bar is buffered for persistence
  // (bars_5m) so the warmup survives deploys; boot replays the last 5 days
  // (48h originally — too short for ultra-thin tapes, the LICN case).
  private emaCross = new EmaCrossTracker(EMA_CROSS, (ticker, closeTs, close, volume) => {
    // Attach the closing bucket's OPEN/HIGH/LOW (2026-07-30). Ordering is the
    // whole trick: onBar feeds addBar FIRST and only then folds the tick into
    // `bucketOhl`, so while this callback runs the accumulator still holds the
    // bucket being closed — no previous-bucket bookkeeping, and ema-cross.ts
    // is untouched (threading h/l through addBar would change the signature
    // every seed path and the entire verify suite depends on).
    const acc = this.bucketOhl.get(ticker);
    const ohl = acc && acc.bucket === closeTs - EMA_CROSS.interval_sec ? acc : null;
    this.barBuffer.push({
      ticker, bar_ts: new Date(closeTs * 1000), close, volume,
      open: ohl?.o ?? null, high: ohl?.h ?? null, low: ohl?.l ?? null,
    });
  });
  // 📈 higher-timeframe layers (1h 2026-07-21, 4h 2026-07-17): the
  // operator's swing-timing tools. Dashboard-only; nomination is the
  // product. 1h buckets are hour-aligned everywhere (offset 0); 4h anchors
  // to the ET session grid.
  private htfLayers: HtfLayer[] = [
    makeHtfLayer(EMA_CROSS_15M, 'bars_15m', { spanDays: 10, retentionDays: 12, deepDays: 7, offset: () => 0, schema: 'ohlcv-1m', yahooInterval: '15m', yahooRange: '60d' }),
    makeHtfLayer(EMA_CROSS_1H, 'bars_1h', { spanDays: 30, retentionDays: 35, deepDays: 25, offset: () => 0, schema: 'ohlcv-1h', yahooInterval: '1h', yahooRange: '60d' }),
    makeHtfLayer(EMA_CROSS_4H, 'bars_4h', { spanDays: 120, retentionDays: 130, deepDays: 100, offset: etBucketOffsetSec, schema: 'ohlcv-1h', yahooInterval: '1h', yahooRange: '60d' }),
    // 1d (2026-07-26): the swing layer. 240d of ohlcv-1h re-bucketed to the
    // 04:00-ET day grid; deepDays (not minBars=200 ≈ 10 months) is the
    // realistic convergence skip; Yahoo daily as fallback.
    makeHtfLayer(EMA_CROSS_1D, 'bars_1d', { spanDays: 240, retentionDays: 260, deepDays: 160, offset: etDailyOffsetSec, schema: 'ohlcv-1h', yahooInterval: '1d', yahooRange: '1y' }),
  ];
  private barBuffer: {
    ticker: string; bar_ts: Date; close: number; volume: number;
    open: number | null; high: number | null; low: number | null;
  }[] = [];
  // Per-symbol 5m bucket extremes, folded from the per-second feed (which
  // already carries o/h/l/c/v — they were being discarded one line after
  // parsing). Live bars only; historical backfills leave these null.
  private bucketOhl = new Map<string, { bucket: number; o: number; h: number; l: number }>();
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
  // Sparse-sweep attempts retry every ATTEMPT_RETRY_MS (intraday re-anchor,
  // unlike the once/day cold backfill above) — the RELL/LFMD lesson.
  private sparseAttempted = new Map<string, number>();
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
  // One log per process when weekend test-session bars start flowing.
  private weekendDropLogged = false;

  status() {
    return {
      enabled: TICKFEED.enabled,
      running: this.running,
      symbols_tracked: this.detector.symbolsTracked(),
      ema_cross_tracked: this.emaCross.symbolsTracked(),
      ...Object.fromEntries(this.htfLayers.map((l) => [`ema_cross_${l.cfg.tf}_tracked`, l.tracker.symbolsTracked()])),
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
    // Let the poller refresh in-flight observation rows from tracker state
    // (live price / % since the reclaim / the 'building' promotion). Passed
    // as a callback because tickfeed imports poller, not the reverse.
    poller.setReclaimProgressSource((ticker, tf, xp) => this.reclaimProgress(ticker, tf, xp));
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
      // Hourly since 2026-07-22 (was 4h): the staleness criterion needs a
      // tight loop — MINI-quiet names are often still seedable mid-session
      // (they haven't printed since boot), so an hourly Yahoo top-up gets
      // their consolidated bars into the tracker the same day, not tomorrow.
      // Per-symbol retry windows (ATTEMPT_RETRY_MS) bound the fetch volume.
      this.backfillTimer = setInterval(() => void this.scanBackfill(), 3600_000);
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

  // Replay persisted bars through the trackers so the EMA-cross warmups
  // survive deploys — 5m from bars_5m (5d), HTF from their tables. Three
  // deploys on 2026-07-14 left the 5m layer silent all of 07-15 — this
  // closes that; the 4h layer can NEVER warm up live (~2-3 weeks of bars),
  // so its replay + the Databento backfill are load-bearing, not resilience.
  private async seedEmaBars(): Promise<void> {
    // The gap-decay's session clock must be right BEFORE the replay — the
    // sync() push only happens after the sidecar starts.
    const etOff = etUtcOffsetHours();
    this.emaCross.setEtOffset(etOff);
    for (const l of this.htfLayers) l.tracker.setEtOffset(etOff);
    await this.seedTrackerFromTable('bars_5m', 5 * 86_400_000, this.emaCross, '5m');
    for (const l of this.htfLayers) {
      await this.seedTrackerFromTable(l.table, l.retentionDays * 86_400_000, l.tracker, l.cfg.tf);
    }
  }

  // Live progress of an in-flight reclaim observation on one timeframe —
  // lets the poller refresh observing rows each cycle instead of leaving
  // them frozen at their nomination (see EmaCrossTracker.reclaimProgress).
  reclaimProgress(ticker: string, tf: string, fallbackCrossPrice?: number):
    (NonNullable<ReturnType<EmaCrossTracker['reclaimProgress']>> & { chg_pct: number | null }) | null {
    const p = tf === '5m'
      ? this.emaCross.reclaimProgress(ticker, fallbackCrossPrice)
      : (this.htfLayers.find((l) => l.cfg.tf === tf)?.tracker.reclaimProgress(ticker, fallbackCrossPrice) ?? null);
    if (!p) return null;
    // Day change% (2026-07-31, operator's ask): a reclaim on a name already
    // +150% is a different proposition from one on a name flat for the day,
    // and the row could not tell them apart. Cross tickers are mostly
    // off-screen so the screener rows never carry them — but the tick feed
    // already holds a prior close for every subscribed symbol (it derives the
    // detector's baselines from the same map), so this is a lookup, not a
    // fetch. Null when the prior close is unknown.
    const prior = universe.getPriorCloses().get(ticker);
    return {
      ...p,
      chg_pct: prior && prior > 0 ? +(((p.cur_price / prior) - 1) * 100).toFixed(2) : null,
    };
  }

  // Live EMA state per timeframe for one symbol — the /ema-debug endpoint's
  // backing data (compare against the TV chart when a detection looks off).
  emaSnapshot(ticker: string): Array<NonNullable<ReturnType<EmaCrossTracker['snapshot']>>> {
    const out = [];
    const s5 = this.emaCross.snapshot(ticker);
    if (s5) out.push(s5);
    for (const l of this.htfLayers) {
      const s = l.tracker.snapshot(ticker);
      if (s) out.push(s);
    }
    return out;
  }

  // Replay one table's bars through a tracker, per-symbol and split-adjusted
  // (DB keeps raw truth; the adjustment is read-side — see
  // adjustSplitHistory for why raw seed history breaks the EMA scale).
  private async seedTrackerFromTable(
    table: 'bars_5m' | 'bars_15m' | 'bars_1h' | 'bars_4h' | 'bars_1d',
    windowMs: number,
    tracker: EmaCrossTracker,
    label: string,
  ): Promise<void> {
    try {
      const rows = await getDb()
        .selectFrom(table)
        .select(['ticker', 'bar_ts', 'close', 'volume'])
        .where('bar_ts', '>', new Date(Date.now() - windowMs))
        .orderBy('ticker', 'asc')
        .orderBy('bar_ts', 'asc')
        .execute();
      let syms = 0;
      let curTk = '';
      let buf: SeedHistoryBar[] = [];
      const flush = () => {
        if (!curTk || buf.length === 0) return;
        for (const b of adjustSplitHistory(buf)) tracker.seedBar(curTk, b.closeTs, b.close, b.volume);
        syms++;
        buf = [];
      };
      for (const r of rows) {
        if (r.ticker !== curTk) { flush(); curTk = r.ticker; }
        buf.push({ closeTs: Math.floor(new Date(r.bar_ts).getTime() / 1000), close: Number(r.close), volume: Number(r.volume) });
      }
      flush();
      console.log(`[ema-cross] seeded ${rows.length} closed ${label} bars for ${syms} symbols — warmup carried over`);
    } catch (err) {
      console.error(`[ema-cross] ${label} bar seed failed (continuing unseeded):`, err instanceof Error ? err.message : err);
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
      const stats = new Map<string, { n: number; n24: number; latestMs: number }>();
      const rows = await getDb()
        .selectFrom('bars_5m')
        .select(['ticker',
          (eb) => eb.fn.countAll<number>().as('n'),
          (eb) => eb.fn.countAll<number>().filterWhere('bar_ts', '>', new Date(Date.now() - 86_400_000)).as('n24'),
          (eb) => eb.fn.max('bar_ts').as('latest'),
        ])
        .where('bar_ts', '>', new Date(Date.now() - 5 * 86_400_000))
        .groupBy('ticker')
        .execute();
      for (const r of rows) {
        stats.set(r.ticker, { n: Number(r.n), n24: Number(r.n24), latestMs: new Date(r.latest as Date).getTime() });
      }
      const targets: string[] = [];
      for (const tk of poller.getKnownRunners()) {
        if (this.backfillAttempted.has(tk)) continue;
        if ((stats.get(tk)?.n ?? 0) >= EMA_CROSS.warmup_bars) continue;
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
            let fromYahoo = false;
            if (bars && seriesLooksCorrupt(bars)) {
              console.log(`[ema-backfill] 5m ${tk}: Databento series looks corrupt (mixed scales) — using Yahoo`);
              bars = null;
            }
            if (!bars || bars.length < EMA_CROSS.warmup_bars) {
              // MINI history too sparse to warm the EMAs — not just empty.
              // The LICN lesson (2026-07-22): 16 five-minute bars in 3 days
              // on MINI while Yahoo's consolidated tape had 167 over 5d; the
              // slow EMA never seeded and a textbook 5m cross at +40% was
              // structurally invisible. Take whichever series is longer.
              // Consolidated volumes skew the sibling window (ratios read
              // LOW — misses, never false confirms) and self-heal live.
              // Ask for enough bars to actually clear warmup with margin —
              // the range escalates until the count is there (see fetchYahoo5m).
              const yahoo = await fetchYahoo5m(tk, EMA_CROSS.warmup_bars * 2);
              await new Promise((r) => setTimeout(r, 1_500));
              if (yahoo && yahoo.length > (bars?.length ?? 0)) {
                bars = yahoo;
                fromYahoo = true;
                viaYahoo++;
              }
            }
            if (!bars || bars.length === 0) continue;
            ok++;
            const r = this.applyBackfillBars(tk, bars, fromYahoo);
            seeded += r.seeded;
            persisted += r.persisted;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        this.backfilledOk += ok;
        console.log(`[ema-backfill] done — ${ok}/${targets.length} backfilled (${viaYahoo} via Yahoo), ${seeded} tracker-seeded, ${persisted} bars persisted`);
      }
      for (const l of this.htfLayers) await this.scanBackfillHtf(l);
      await this.scanSparse5m(stats);
    } catch (err) {
      console.error('[ema-backfill] scan failed (continuing):', err instanceof Error ? err.message : err);
    } finally {
      this.backfillRunning = false;
    }
  }

  // Warm-but-sparse consolidated re-seed for the 5m layer (2026-07-23, the
  // CPHI lesson — see SPARSE_5M_MIN_BARS_24H). Names past warmup whose
  // last-24h banked density is under the floor get their EMA state rebuilt
  // from Yahoo's consolidated 5m tape, stalest-banked-tape first (the OMH
  // lesson — see the sort below), retried
  // every 2h (the RELL/LFMD lesson — see SPARSE_5M_MAX_PER_SCAN). The
  // fetched bars deliberately do NOT persist to bars_5m: persisted Yahoo
  // bars made a swept name read "dense" and excluded it from every later
  // sweep, defeating the intraday re-anchor (boot replay + gap-decay are
  // already TV-close without them). Gap-decay carries the state between
  // re-seeds; the sibling ring keeps feed-scale volumes (see
  // EmaCrossTracker.reseedFromHistory). Runs LAST in the scan — the proven
  // below-warmup and HTF passes must never wait behind this sweep.
  private async scanSparse5m(stats: Map<string, { n: number; n24: number; latestMs: number }>): Promise<void> {
    // No live tape exists on ET weekends (test-session bars are dropped at
    // the gate), so there is nothing to re-anchor against — and the last-24h
    // density criterion reads 0 for everything, which would churn the whole
    // sparse set through Yahoo every 2h all weekend.
    if (etDowNow() === 0 || etDowNow() === 6) return;
    const cand: Array<{ tk: string; n: number; n24: number; latestMs: number }> = [];
    for (const tk of poller.getKnownRunners()) {
      const lastTry = this.sparseAttempted.get(tk) ?? 0;
      if (Date.now() - lastTry < ATTEMPT_RETRY_MS) continue;
      const s = stats.get(tk);
      // No past-warmup floor since 2026-07-28 (the FIEE hole): below-warmup
      // names are the MOST divergent, and the once-per-ET-day below-warmup
      // pass is too slow a re-anchor for a name whose whole tape is a
      // trickle. Both passes now converge them; this one repeats every 2h.
      if (!s || s.n24 >= SPARSE_5M_MIN_BARS_24H) continue;
      cand.push({ tk, n: s.n, n24: s.n24, latestMs: s.latestMs });
    }
    if (cand.length === 0) return;
    // SPARSEST 24h tape first, stalest as the tie-break (2026-07-28, the
    // FIEE lesson — refines 07-24's pure stalest-first). Blindness is a
    // DENSITY property, not a recency one: pure stalest-first assumed a
    // fresh newest bar means the live tape is correcting the EMAs, but a
    // trickle name prints a bar every 20 minutes — always "fresh", never
    // dense, and it sat permanently behind ~800 staler names (FIEE: 15
    // bars on the day of a +156% burst, never once swept). Sorting on
    // last-24h bar count preserves the OMH lesson for free — a name silent
    // for hours has n24 ≈ 0 and still sorts first — while lifting the
    // trickle class off the floor of the queue. Deploy resets of the retry
    // map stay harmless for the same reason as before.
    cand.sort((a, b) => (a.n24 - b.n24) || (a.latestMs - b.latestMs));
    const batch = cand.slice(0, SPARSE_5M_MAX_PER_SCAN);
    if (cand.length > batch.length) {
      console.log(`[ema-backfill] sparse: ${cand.length - batch.length} names deferred to the next scan`);
    }
    console.log(`[ema-backfill] sparse: ${batch.length} warm-but-sparse known runners — Yahoo consolidated re-seed`);
    let reseeded = 0, inFlight = 0;
    for (const { tk, n } of batch) {
      if (!this.running) return;
      this.sparseAttempted.set(tk, Date.now());
      const yahoo = await fetchYahoo5m(tk, EMA_CROSS.warmup_bars * 2);
      await new Promise((r) => setTimeout(r, 1_500));
      if (!yahoo || yahoo.length <= n) continue; // consolidated adds nothing over the banked series
      const adj = adjustSplitHistory(yahoo).slice(-200);
      if (this.emaCross.canSeed(tk)) {
        for (const b of adj) this.emaCross.seedBar(tk, b.closeTs, b.close, b.volume, true);
        reseeded++;
      } else if (this.emaCross.reseedFromHistory(tk, adj, true)) {
        reseeded++;
      } else {
        inFlight++; // an observation/pending is live — never disturb it
      }
    }
    console.log(`[ema-backfill] sparse done — ${reseeded}/${batch.length} re-seeded (${inFlight} in-flight skipped)`);
  }

  // HTF-layer backfill: `spanDays` of Databento ohlcv-1h re-bucketed to the
  // layer's grid — batched 100 symbols/request. Depth matters more than
  // warmup here (the WOK lesson, 2026-07-17): an EMA50 needs ~150 banked
  // bars for the SMA seed's influence to drop under ~2% and match TV within
  // pennies; a window ≈1× the EMA span leaves it at the recent average and
  // any poke "crosses". Skip a symbol once it has ≥minBars banked OR its
  // banked history reaches back ≥deepDays (recently-listed names can never
  // satisfy either — the per-symbol retry window bounds their cost). Yahoo
  // (consolidated) fallback since 2026-07-22 for sparse/stale MINI series —
  // the TV-log audit: six of eleven TV 1h crosses were on names whose MINI
  // tape had been silent 12-22h. Persists to the layer's table so boots
  // seed from DB.
  private async scanBackfillHtf(l: HtfLayer): Promise<void> {
    const have = new Map<string, { n: number; earliestMs: number; latestMs: number }>();
    const rows = await getDb()
      .selectFrom(l.table)
      .select(['ticker',
        (eb) => eb.fn.countAll<number>().as('n'),
        (eb) => eb.fn.min('bar_ts').as('earliest'),
        (eb) => eb.fn.max('bar_ts').as('latest'),
      ])
      .where('bar_ts', '>', new Date(Date.now() - l.retentionDays * 86_400_000))
      .groupBy('ticker')
      .execute();
    for (const r of rows) {
      have.set(r.ticker, {
        n: Number(r.n),
        earliestMs: new Date(r.earliest as Date).getTime(),
        latestMs: new Date(r.latest as Date).getTime(),
      });
    }
    const deepEnoughMs = Date.now() - l.deepDays * 86_400_000;
    // Staleness criterion (2026-07-22, the TV-log audit): TMDE had 98 banked
    // bars (past warmup) but its NEWEST bar was 22h old — depth-only skip
    // rules never re-fetched it, and its TV crosses were invisible. A banked
    // series counts as healthy only if it is also fresh. On WEEKENDS the
    // wall-clock rule degenerates (2026-07-26, a Saturday: every series read
    // "stale" and 1,533 pointless 1h re-fetches queued, retrying every 2h)
    // — fresh then means "has Friday's close".
    // Freshness has to scale with the layer's BAR INTERVAL (2026-07-28 —
    // found while chasing a swap-thrashing droplet). A flat 12h threshold is
    // right for 15m/1h but nonsense for the coarse grids: a 1d bucket only
    // closes once per ET day and not at all across a weekend, so the newest
    // legitimately-banked daily bar is ALWAYS >12h old — measured, all 1,507
    // daily series read "stale", minimum age 71h. The 1d pass therefore
    // re-fetched every known runner's 240 days of ohlcv-1h on EVERY sweep
    // (~40 min, ~350k row upserts, metered Databento), and 4h misfired the
    // same way overnight. 4× the interval clears the weekend gap for 1d
    // (96h) and the overnight gap for 4h (16h), while leaving 15m/1h at the
    // original 12h. Depth (minBars/deepDays) still governs under-converged
    // series — this only stops re-fetching series that are already as fresh
    // as they can possibly be.
    const staleAfterMs = Math.max(12 * 3600_000, 4 * l.cfg.interval_sec * 1000);
    const freshEnoughMs = etDowNow() === 0 || etDowNow() === 6
      ? Math.min(lastSessionCloseMs() - 3600_000, Date.now() - staleAfterMs)
      : Date.now() - staleAfterMs;
    const targets: string[] = [];
    for (const tk of poller.getKnownRunners()) {
      const lastTry = l.attempted.get(tk) ?? 0;
      if (Date.now() - lastTry < ATTEMPT_RETRY_MS) continue;
      const h = have.get(tk);
      // Convergence needs DENSITY, not just reach (2026-07-28, the FIEE
      // hole). The `earliestMs` branch exists so a recently-listed name
      // isn't refetched forever chasing minBars it can never have — but on
      // a trickle tape it read a nearly-empty series as converged: FIEE's
      // 15m table held 38 bars inside the 12-day window, reaching back past
      // deepDays (7), so the layer skipped it on every scan while its
      // EMA65 sat null and the layer could not fire. A series below the
      // layer's own warmup bar count is never converged, whatever its span
      // — and the Yahoo consolidated fallback below is exactly what fixes
      // such names, so the retry is productive rather than a spin.
      const converged = h != null
        && h.n >= l.cfg.warmup_bars
        && (h.n >= l.minBars || h.earliestMs <= deepEnoughMs);
      if (converged && h!.latestMs >= freshEnoughMs) continue;
      targets.push(tk);
      if (targets.length >= 1600) break;
    }
    if (targets.length === 0) return;
    console.log(`[ema-backfill] ${l.cfg.tf}: ${targets.length} known runners below convergence depth or stale — Databento ${l.schema} (${l.spanDays}d), Yahoo fallback`);
    let ok = 0, seeded = 0, persisted = 0, viaYahoo = 0;
    const CHUNK = 100;
    const off = l.offset();
    for (let i = 0; i < targets.length; i += CHUNK) {
      if (!this.running) return;
      const chunk = targets.slice(i, i + CHUNK);
      chunk.forEach((t) => l.attempted.set(t, Date.now()));
      const batch = await fetchDatabentoAgg(chunk, l.schema, l.spanDays, l.cfg.interval_sec, off);
      if (!batch) {
        // One failed chunk must not starve the rest of the fleet (the first
        // live pass aborted entirely on a transient 422). These symbols
        // retry on the next rescan.
        chunk.forEach((t) => l.attempted.delete(t));
        console.error(`[ema-backfill] ${l.cfg.tf} chunk failed (${chunk[0]}…${chunk[chunk.length - 1]}) — will retry next scan`);
        continue;
      }
      for (const tk of chunk) {
        if (!this.running) return;
        let bars = batch.get(tk) ?? null;
        if (bars && seriesLooksCorrupt(bars)) {
          console.log(`[ema-backfill] ${l.cfg.tf} ${tk}: Databento series looks corrupt (mixed scales) — using Yahoo`);
          bars = null;
        }
        // Consolidated fallback: MINI-quiet names (sparse OR stale series)
        // get Yahoo's tape — the ELPW/CRIS/MASK/TMDE class, where the MINI
        // series lagged the day's move so far behind that the EMAs never
        // crossed. Take whichever series is longer/fresher.
        const dbLatest = bars?.length ? bars[bars.length - 1].closeTs * 1000 : 0;
        let fromYahoo = false;
        if (!bars || bars.length < l.cfg.warmup_bars || dbLatest < freshEnoughMs) {
          const y = await fetchYahooHtfAgg(tk, l.yahooInterval, l.yahooRange, l.cfg.interval_sec, off);
          await new Promise((r) => setTimeout(r, 1_500));
          const yLatest = y?.length ? y[y.length - 1].closeTs * 1000 : 0;
          if (y && y.length > 0 && (y.length > (bars?.length ?? 0) || yLatest > dbLatest)) {
            bars = y;
            fromYahoo = true;
            viaYahoo++;
          }
        }
        if (!bars || bars.length === 0) continue;
        ok++;
        const adj = adjustSplitHistory(bars);
        if (l.tracker.canSeed(tk)) {
          for (const b of adj) l.tracker.seedBar(tk, b.closeTs, b.close, b.volume, fromYahoo);
          seeded++;
        } else if (l.tracker.reseedFromHistory(tk, adj, fromYahoo)) {
          // Warm but sparse/stale (the CPHI 1h class: EMA65 2.73 vs fast
          // 1.92 off a weeks-deep MINI horizon) — the denser consolidated
          // series replaces the EMA state; in-flight observations refuse.
          seeded++;
        }
        persisted += bars.length;
        void getDb()
          .insertInto(l.table)
          .values(bars.map((b) => ({ ticker: tk, bar_ts: new Date(b.closeTs * 1000), close: b.close, volume: b.volume })))
          .onConflict((oc) => oc.columns(['ticker', 'bar_ts']).doNothing())
          .execute()
          .catch(() => { /* non-critical */ });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`[ema-backfill] ${l.cfg.tf} done — ${ok}/${targets.length} backfilled (${viaYahoo} via Yahoo), ${seeded} tracker-seeded, ${persisted} bars persisted`);
  }

  // Apply fetched history for one symbol: direct-seed the tracker while it
  // has produced no live bar (ordering safety, re-checked here — after the
  // fetch), otherwise REPLACE its state with the fetched history, and
  // persist the recent 72h slice for the next boot's replay.
  //
  // The reseed branch is load-bearing (2026-07-28, the FIEE hole): this path
  // targets names BELOW warmup, and `canSeed` is false the moment a symbol
  // has produced one live bar — so a trickle-tape name that streams a
  // handful of bars a day fetched its history here and then THREW IT AWAY,
  // every scan, forever. FIEE banked 38 five-minute bars in five days: never
  // seedable (live bars exist), never swept (the sparse pass required
  // past-warmup), so its EMA65 was permanently null and the 5m layer was
  // structurally incapable of firing on it — the burst to $10 was invisible
  // to the operator's primary timeframe. reseedFromHistory refuses while an
  // observation or pending is in flight, so live detection state is safe.
  private applyBackfillBars(tk: string, bars: Array<{ closeTs: number; close: number; volume: number }>, consolidated = false): { seeded: number; persisted: number } {
    let seeded = 0;
    const recentFirst = bars.slice(-200);
    if (this.emaCross.canSeed(tk)) {
      for (const b of recentFirst) this.emaCross.seedBar(tk, b.closeTs, b.close, b.volume, consolidated);
      seeded = 1;
    } else if (this.emaCross.reseedFromHistory(tk, recentFirst, consolidated)) {
      seeded = 1;
    }
    const recent = bars.filter((b) => b.closeTs * 1000 > Date.now() - 5 * 86_400_000);
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
    for (const l of this.htfLayers) {
      if (l.buffer.length === 0) continue;
      const rows = l.buffer.splice(0);
      void getDb()
        .insertInto(l.table)
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
      this.extraSubs.clear();
      this.backfillAttempted.clear();
      this.sparseAttempted.clear();
      // Prune persisted bars beyond their seed windows (fire-and-forget).
      void getDb()
        .deleteFrom('bars_5m')
        // 45 days, raised from 6 (2026-07-30). The reclaim review needs ~10
        // sessions of post-confirm bars and 6-day retention pruned the early
        // ones before they could be graded — the evidence was expiring faster
        // than it accumulated. Measured cost: bars_5m is 50 MB per 6 days
        // (~8 MB/day, ~12 with OHLC), so 45 days is well under a gigabyte
        // against 95 GB free. Keeping RAW bars rather than pre-computing an
        // outcome table deliberately: it lets later questions be asked with
        // metrics nobody has thought of yet. Boot replay is a SEPARATE 5-day
        // window, so this does not slow startup.
        .where('bar_ts', '<', new Date(Date.now() - 45 * 86_400_000))
        .execute()
        .catch(() => { /* retried next midnight */ });
      for (const l of this.htfLayers) {
        l.tracker.resetDaily();
        l.tracker.setBucketOffset(l.offset()); // DST roll-over safe
        l.attempted.clear();
        void getDb()
          .deleteFrom(l.table)
          .where('bar_ts', '<', new Date(Date.now() - l.retentionDays * 86_400_000))
          .execute()
          .catch(() => { /* retried next midnight */ });
      }
      // Fresh Databento session for the new day.
      this.child?.kill();
      console.log('[tickfeed] midnight ET — detector reset, sidecar will respawn');
    }
    // Refresh the EMA trackers' stale-guard anchor (most recent 04:00 ET)
    // and the gap-decay's session clock (EDT/EST offset).
    const sessionOpen = lastSessionOpenSec();
    const etOff = etUtcOffsetHours();
    this.emaCross.setSessionOpen(sessionOpen);
    this.emaCross.setEtOffset(etOff);
    for (const l of this.htfLayers) {
      l.tracker.setSessionOpen(sessionOpen);
      l.tracker.setEtOffset(etOff);
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
    // Weekend bars are exchange TEST-session prints, not trades (2026-07-25,
    // a Saturday: 132k bars streamed with plausible-but-fake prices — ROLR
    // "printed" +9% and fired a phantom 4h reclaim; the US market was
    // closed). Exchanges run production tests on scheduled Saturdays and
    // the raw prop feeds behind EQUS.MINI carry them. Drop them before ANY
    // consumer — detector, EMA layers, and bar persistence (they would
    // poison Monday's seed replays). bars_seen above still counts them so
    // /health shows the pipe itself is alive.
    const etDay = (Math.floor((m.t - etUtcOffsetHours() * 3600) / 86_400) + 4) % 7;
    if (etDay === 6 || etDay === 0) {
      if (!this.weekendDropLogged) {
        this.weekendDropLogged = true;
        console.log('[tickfeed] weekend (test-session) bars detected — dropping all bars until the next trading day');
      }
      return;
    }
    const bar: TickBar = { ts_sec: m.t, close: m.c, high: m.h, low: m.l, volume: m.v };
    const ev = this.detector.addBar(m.s, bar);
    if (ev) {
      if (ev.type === 'accum') this.accums++;
      else if (ev.type === 'watch') this.watches++;
      else if (ev.type === 'confirm') this.candidates++;
      else this.fades++;
      poller.onTickEvent(ev);
    }
    // 📈 EMA-cross layers (5m + HTF) — known runners only (the operator's
    // spec: "check our momentum tickers of our database"), everything else
    // skips the trackers.
    if (poller.isKnownRunner(m.s)) {
      const xev = this.emaCross.addBar(m.s, m.t, m.c, m.v);
      if (xev) poller.onEmaCrossEvent(xev);
      // The reclaim channel's events arrive via the queue (never the return
      // value — that stays the cross channel's contract).
      for (const q of this.emaCross.drainEvents()) poller.onEmaCrossEvent(q);
      for (const l of this.htfLayers) {
        const hev = l.tracker.addBar(m.s, m.t, m.c, m.v);
        if (hev) poller.onEmaCrossEvent(hev);
        for (const q of l.tracker.drainEvents()) poller.onEmaCrossEvent(q);
      }
    }
    // Fold this tick into its 5m bucket extremes — AFTER the trackers, so a
    // bar-close callback above still sees the bucket it is closing.
    if (poller.isKnownRunner(m.s)) {
      const bucket = Math.floor(m.t / EMA_CROSS.interval_sec) * EMA_CROSS.interval_sec;
      const acc = this.bucketOhl.get(m.s);
      if (!acc || acc.bucket !== bucket) {
        this.bucketOhl.set(m.s, { bucket, o: m.o, h: m.h, l: m.l });
      } else {
        if (m.h > acc.h) acc.h = m.h;
        if (m.l < acc.l) acc.l = m.l;
      }
    }
    // Surface near-miss reasons (gapped vs which gate) so the rollout is
    // debuggable — why a moving name didn't fire.
    const diag = this.detector.drainDiagnostics();
    for (const d of diag) console.log(`[tickfeed] near-miss: ${d}`);
  }
}

export const tickfeed = new TickFeedService();

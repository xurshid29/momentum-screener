// Replay a symbol's real CONSOLIDATED 5m tape (Yahoo — the same series the
// sparse re-seed feeds the tracker) through the price-reclaim channel under
// the OLD one-bar arming vs the NEW staged arming (2026-07-28, the FIEE
// staircase). Answers "would the 5m layer have caught this?" for any name,
// and is the measurement behind the staged_arm_bars calibration.
//
//   npx tsx scripts/research/reclaim-staged-arming-replay.ts FIEE [STAGED]
//
// Note this replays the CONSOLIDATED tape, so it also shows what the layer
// sees once a MINI-sparse name has been re-anchored — the two fixes that
// shipped together.
import { EmaCrossTracker, EMA_CROSS, type EmaCrossConfig, type EmaCrossEvent } from '../../src/services/ema-cross.js';

const TICKER = (process.argv[2] ?? 'FIEE').toUpperCase();
const STAGED = Number(process.argv[3] ?? EMA_CROSS.staged_arm_bars);

type Bar = { closeTs: number; close: number; volume: number };

async function fetchRange(ticker: string, range: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=${range}&includePrePost=true`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const json = await res.json() as {
    chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null>; volume?: Array<number | null> }> } }> };
  };
  const r0 = json?.chart?.result?.[0];
  const ts = r0?.timestamp ?? [];
  const q = r0?.indicators?.quote?.[0];
  const out: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q?.close?.[i];
    if (c == null || !(c > 0)) continue;
    out.push({ closeTs: Math.floor(ts[i] / 300) * 300 + 300, close: c, volume: Number(q?.volume?.[i] ?? 0) });
  }
  return out;
}

// Mirrors the production escalation (see fetchYahoo5m in tickfeed.ts): widen
// the calendar until the BAR COUNT clears warmup, because that is what the
// EMA actually needs.
async function fetchYahoo5m(ticker: string, minBars: number): Promise<Bar[]> {
  let bars = await fetchRange(ticker, '5d');
  for (const range of ['1mo', '60d']) {
    if (bars.length >= minBars) break;
    const deeper = await fetchRange(ticker, range);
    if (deeper.length > bars.length) bars = deeper;
  }
  return bars;
}

const et = (s: number) => new Date(s * 1000).toLocaleString('en-US', {
  timeZone: 'America/New_York', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

// Reproduce the production shape: everything before `cutTs` arrives as
// CONSOLIDATED seed history (what the sparse re-seed installs — no gap-decay,
// silent), everything after arrives as LIVE bars through addBar (gap-decay
// on, events emitted). Seeding the whole series would emit nothing at all;
// replaying the whole series live would gap-decay history that TV never
// decayed. Only this split matches what the service actually does.
function run(label: string, cfg: EmaCrossConfig, bars: Bar[], cutTs: number) {
  const events: EmaCrossEvent[] = [];
  const tr = new EmaCrossTracker(cfg, () => { /* no persistence in replay */ });
  tr.setEtOffset(-4);
  const hist = bars.filter((b) => b.closeTs <= cutTs);
  const live = bars.filter((b) => b.closeTs > cutTs);
  for (const b of hist) tr.seedBar(TICKER, b.closeTs, b.close, b.volume, true);
  const seeded = tr.snapshot(TICKER);
  for (const b of live) {
    tr.setSessionOpen(b.closeTs - 3600);
    const ev = tr.addBar(TICKER, b.closeTs - cfg.interval_sec, b.close, b.volume);
    if (ev) events.push(ev);
    events.push(...tr.drainEvents());
  }
  console.log(`\n=== ${label} ===`);
  console.log(`  seeded ${hist.length} bars → EMA10=${seeded?.ema_fast?.toFixed(3)} EMA65=${seeded?.ema_slow?.toFixed(3)} armed=${seeded?.armed}; then ${live.length} live bars`);
  const rec = events.filter((e) => e.signal === 'reclaim');
  if (rec.length === 0) { console.log('  NO RECLAIM EVENTS'); return; }
  for (const e of rec) {
    console.log(`  ${et(e.ts_sec)} ET  ${e.type.padEnd(9)} $${e.price.toFixed(2)}  ${String(e.vol_ratio).padStart(7)}x  staged=${e.staged_bars ?? '-'}  ${e.intrabar ? 'intrabar' : 'closed'}`);
  }
}

const bars = await fetchYahoo5m(TICKER, EMA_CROSS.warmup_bars * 2);
console.log(`${TICKER}: ${bars.length} consolidated 5m bars, ${et(bars[0].closeTs)} → ${et(bars[bars.length - 1].closeTs)} ET`);
// Cut at the start of the last session in the series — history seeds, the
// session itself plays live.
const lastDay = et(bars[bars.length - 1].closeTs).slice(0, 5);
const cutTs = bars.find((b) => et(b.closeTs).startsWith(lastDay))!.closeTs - 300;
console.log(`seed/live cut: ${et(cutTs)} ET`);
run('OLD — one-bar arming (staged_arm_bars: 0)', { ...EMA_CROSS, staged_arm_bars: 0 }, bars, cutTs);
run(`NEW — staged arming (staged_arm_bars: ${STAGED})`, { ...EMA_CROSS, staged_arm_bars: STAGED }, bars, cutTs);

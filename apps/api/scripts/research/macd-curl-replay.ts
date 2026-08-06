// Replay banked 5m closes through the MACD curl detector (macd-curl.ts) and
// print every event with forward outcomes — the validation harness for the
// ⤴ second-leg layer. Feed it a CSV pulled from prod:
//
//   ssh root@<droplet> '... psql ... "COPY (SELECT ticker,
//     extract(epoch from bar_ts)::bigint AS close_ts, close, volume
//     FROM bars_5m WHERE ... ORDER BY ticker, bar_ts) TO STDOUT WITH CSV HEADER"' > bars.csv
//   npx tsx scripts/research/macd-curl-replay.ts bars.csv [TICKER ...]
//
// Times print in ET (the app's anchor) and UTC+5 (the operator's wall
// clock, matching their TV screenshots). Forward stats look ahead over the
// banked bars: max close +30m/+60m and min close +30m after each event.

import { readFileSync } from 'node:fs';
import { MacdCurlTracker, MACD_CURL } from '../../src/services/macd-curl.js';

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('usage: npx tsx scripts/research/macd-curl-replay.ts bars.csv [TICKER ...]');
  process.exit(1);
}
const only = new Set(process.argv.slice(3).map((s) => s.toUpperCase()));

interface Bar { ts: number; close: number; volume: number }
const bySym = new Map<string, Bar[]>();
const lines = readFileSync(csvPath, 'utf8').trim().split('\n');
for (const ln of lines.slice(1)) {
  const [ticker, ts, close, volume] = ln.split(',');
  if (only.size > 0 && !only.has(ticker)) continue;
  let arr = bySym.get(ticker);
  if (!arr) bySym.set(ticker, (arr = []));
  arr.push({ ts: +ts, close: +close, volume: +volume });
}

const ET_OFF = -4 * 3600;   // EDT
const LOC_OFF = 5 * 3600;   // operator wall clock (UTC+5)
function hhmm(tsSec: number, off: number): string {
  const d = new Date((tsSec + off) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function day(tsSec: number, off: number): string {
  const d = new Date((tsSec + off) * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function fwd(bars: Bar[], i: number, n: number): { max: number; min: number } {
  const base = bars[i].close;
  let max = base, min = base;
  for (let j = i + 1; j <= Math.min(i + n, bars.length - 1); j++) {
    if (bars[j].close > max) max = bars[j].close;
    if (bars[j].close < min) min = bars[j].close;
  }
  return { max: (max / base - 1) * 100, min: (min / base - 1) * 100 };
}

console.log(`config: ${JSON.stringify(MACD_CURL)}\n`);
const counts = { setup: 0, cross: 0, fade: 0 };
for (const [ticker, bars] of [...bySym.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  bars.sort((a, b) => a.ts - b.ts);
  const tracker = new MacdCurlTracker();
  console.log(`── ${ticker} (${bars.length} bars, ${day(bars[0].ts, ET_OFF)} ${hhmm(bars[0].ts, ET_OFF)} → ${day(bars[bars.length - 1].ts, ET_OFF)} ${hhmm(bars[bars.length - 1].ts, ET_OFF)} ET)`);
  bars.forEach((b, i) => {
    const ev = tracker.addClosedBar(ticker, b.ts, b.close);
    if (!ev) return;
    counts[ev.type]++;
    if (ev.type === 'fade') return; // episode bookkeeping — noise in this report
    const f6 = fwd(bars, i, 6);
    const f12 = fwd(bars, i, 12);
    const tag = ev.type === 'setup' ? '⤴ SETUP' : '✚ CROSS';
    console.log(
      `  ${tag}  ${day(ev.ts_sec, ET_OFF)} ${hhmm(ev.ts_sec, ET_OFF)} ET (${hhmm(ev.ts_sec, LOC_OFF)} loc)` +
      `  $${ev.price.toFixed(3)}  line ${ev.line.toFixed(4)} sig ${ev.signal_val.toFixed(4)}` +
      `  gap ${(ev.gap / ev.price * 100).toFixed(2)}% (max ${(ev.max_gap / ev.price * 100).toFixed(2)}%)` +
      `${ev.below_zero ? '  <0' : '     '}  +30m ${f6.max >= 0 ? '+' : ''}${f6.max.toFixed(1)}%/${f6.min.toFixed(1)}%  +60m ${f12.max >= 0 ? '+' : ''}${f12.max.toFixed(1)}%`,
    );
  });
}
console.log(`\ntotals: ${counts.setup} setups, ${counts.cross} crosses, ${counts.fade} fades`);

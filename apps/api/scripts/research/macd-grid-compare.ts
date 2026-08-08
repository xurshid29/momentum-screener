// Head-to-head comparison of ONE MACD parameter set across bar grids
// (2026-08-08, operator's ask: "2m vs 5m vs 15m, all 3/15/8 — which gives
// easier setups, better and safer trades?"). Method notes that make the
// comparison fair:
//
//   • Signals come from each grid's own bars, but OUTCOMES are measured on
//     a shared FINE series (the finest CSV given) — otherwise the coarse
//     grid under-reports drawdown purely because its closes hide it.
//   • Horizons are WALL-CLOCK (30m / 1h / 2h), not bars-ahead.
//
// Usage:
//   npx tsx scripts/research/macd-grid-compare.ts \
//     --bars2 y2.csv --bars5 y5.csv --bars15 y15.csv \
//     [--fast 3 --slow 15 --signal 8]
// Any subset of the --bars* flags works; the finest provided is the
// outcome series. CSVs: ticker,close_ts,close[,volume] with header.

import { readFileSync } from 'node:fs';
import { MacdCurlTracker, MACD_CURL, type MacdCurlConfig, type MacdCurlEvent } from '../../src/services/macd-curl.js';

interface Bar { ts: number; close: number }

function loadCsv(path: string): Map<string, Bar[]> {
  const by = new Map<string, Bar[]>();
  for (const ln of readFileSync(path, 'utf8').trim().split('\n').slice(1)) {
    const [t, ts, close] = ln.split(',');
    let arr = by.get(t);
    if (!arr) by.set(t, (arr = []));
    arr.push({ ts: +ts, close: +close });
  }
  for (const arr of by.values()) arr.sort((a, b) => a.ts - b.ts);
  return by;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const GRIDS: { label: string; interval: number; path: string }[] = [];
if (flag('bars2')) GRIDS.push({ label: '2m', interval: 120, path: flag('bars2')! });
if (flag('bars5')) GRIDS.push({ label: '5m', interval: 300, path: flag('bars5')! });
if (flag('bars15')) GRIDS.push({ label: '15m', interval: 900, path: flag('bars15')! });
if (GRIDS.length === 0) {
  console.error('need at least one of --bars2/--bars5/--bars15');
  process.exit(1);
}
const FAST = +(flag('fast') ?? 3);
const SLOW = +(flag('slow') ?? 15);
const SIG = +(flag('signal') ?? 8);

const gridBars = GRIDS.map((g) => ({ ...g, bars: loadCsv(g.path) }));
// Finest provided grid = the shared outcome series.
const fine = gridBars.reduce((a, b) => (a.interval <= b.interval ? a : b));

function outcome(ticker: string, fromTs: number, entry: number, horizonSec: number):
  { up: number; dn: number } | null {
  const bars = fine.bars.get(ticker);
  if (!bars) return null;
  let up = 0, dn = 0, seen = 0;
  for (const b of bars) {
    if (b.ts <= fromTs) continue;
    if (b.ts > fromTs + horizonSec) break;
    seen++;
    const pct = (b.close / entry - 1) * 100;
    if (pct > up) up = pct;
    if (pct < dn) dn = pct;
  }
  return seen > 0 ? { up, dn } : null;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

console.log(`3/${SLOW}/${SIG} (fast=${FAST}) · outcomes on the ${fine.label} series · horizons 30m/1h/2h\n`);
const H = { h30: 1800, h60: 3600, h120: 7200 };
const rows: string[] = [];
for (const g of gridBars) {
  const cfg: MacdCurlConfig = {
    ...MACD_CURL, variant: g.label, interval_sec: g.interval,
    fast: FAST, slow: SLOW, signal: SIG,
  };
  const setups: { t: string; ts: number; price: number; bz: boolean }[] = [];
  let crosses = 0, crossAfterSetup = 0, lastSetupByTicker = new Map<string, number>();
  const daysByName = new Map<string, Set<string>>();
  for (const [t, bars] of g.bars) {
    const tracker = new MacdCurlTracker(cfg);
    for (const b of bars) {
      const day = new Date((b.ts - 4 * 3600) * 1000).toISOString().slice(0, 10);
      let ds = daysByName.get(t);
      if (!ds) daysByName.set(t, (ds = new Set()));
      ds.add(day);
      const ev: MacdCurlEvent | null = tracker.addClosedBar(t, b.ts, b.close);
      if (!ev) continue;
      if (ev.type === 'setup') {
        setups.push({ t, ts: ev.ts_sec, price: ev.price, bz: ev.below_zero });
        lastSetupByTicker.set(t, ev.ts_sec);
      } else if (ev.type === 'cross') {
        crosses++;
        const ls = lastSetupByTicker.get(t);
        // A cross "resolving" its setup: within 45 min wall-clock.
        if (ls != null && ev.ts_sec - ls <= 2700) { crossAfterSetup++; lastSetupByTicker.delete(t); }
      }
    }
  }
  const nameSessions = [...daysByName.values()].reduce((a, s) => a + s.size, 0);
  const o30 = setups.map((s) => outcome(s.t, s.ts, s.price, H.h30)).filter((x): x is { up: number; dn: number } => !!x);
  const o60 = setups.map((s) => outcome(s.t, s.ts, s.price, H.h60)).filter((x): x is { up: number; dn: number } => !!x);
  const o120 = setups.map((s) => outcome(s.t, s.ts, s.price, H.h120)).filter((x): x is { up: number; dn: number } => !!x);
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
  const n = setups.length;
  rows.push([
    g.label.padEnd(4),
    String(n).padStart(6),
    `${(n / Math.max(1, nameSessions)).toFixed(1)}/nm-day`.padStart(10),
    `${pct(setups.filter((s) => s.bz).length, n)}%`.padStart(5),
    `${pct(crossAfterSetup, n)}%`.padStart(8),
    `${median(o30.map((x) => x.up)).toFixed(1)}%`.padStart(8),
    `${median(o30.map((x) => x.dn)).toFixed(1)}%`.padStart(8),
    `${pct(o60.filter((x) => x.up >= 10).length, o60.length)}%`.padStart(8),
    `${pct(o60.filter((x) => x.dn <= -5).length, o60.length)}%`.padStart(8),
    `${median(o120.map((x) => x.up)).toFixed(1)}%`.padStart(8),
    `${pct(o120.filter((x) => x.up >= 20).length, o120.length)}%`.padStart(8),
    `${pct(o120.filter((x) => x.dn <= -10).length, o120.length)}%`.padStart(9),
  ].join(' '));
}
console.log(['grid', 'setups', 'rate', '<0', 'resolve', 'up30m', 'dn30m', '≥10@1h', '≤-5@1h', 'up2h', '≥20@2h', '≤-10@2h'].map((h, i) =>
  h.padStart([4, 6, 10, 5, 8, 8, 8, 8, 8, 8, 8, 9][i])).join(' '));
for (const r of rows) console.log(r);
console.log(`
legend: rate = setups per name-session · <0 = below-zero share ·
resolve = setups followed by a cross ≤45min (the curl "worked") ·
up/dn = median max-gain / max-drawdown on ${fine.label} closes within the horizon ·
tails = share reaching the threshold`);

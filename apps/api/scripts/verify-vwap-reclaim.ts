// Synthetic regression for the ↑ VWAP reclaim tracker (services/vwap-reclaim.ts).
// Run:  npx tsx scripts/verify-vwap-reclaim.ts
// Pins the state-machine contract: reclaim needs a real stay below VWAP, a
// junk floor and tape history; confirm via hold or extend; lost/expire close
// the episode with telemetry; partial anchors are labelled; sessions roll.

import {
  VwapReclaimTracker, VWAP_RECLAIM, vwapSessionOpenSec, type VwapEvent, type VwapBar,
} from '../src/services/vwap-reclaim.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 2026-08-20 is a Thursday. Anchor every scenario at 09:30 ET that day so the
// session key is stable and the tracker's "booted mid-session" rule is under
// our control via the constructor's nowSec.
const T_0930 = Date.UTC(2026, 7, 20, 13, 30, 0) / 1000; // 09:30 EDT = 13:30 UTC
const OPEN = vwapSessionOpenSec(T_0930);
check('session open resolves to 04:00 ET', T_0930 - OPEN === 5.5 * 3600, `got ${(T_0930 - OPEN) / 3600}h`);

// A "minute" of tape: N one-second bars at a price, each with `sh` shares.
function minute(ts: number, price: number, sh = 50, prints = 10, hi = price, lo = price): VwapBar[] {
  const out: VwapBar[] = [];
  for (let i = 0; i < prints; i++) {
    out.push({ ts_sec: ts + i * Math.floor(60 / prints), open: price, high: hi, low: lo, close: price, volume: sh });
  }
  return out;
}

function feed(tracker: VwapReclaimTracker, bars: VwapBar[], ticker = 'TEST'): VwapEvent[] {
  const out: VwapEvent[] = [];
  for (const b of bars) out.push(...tracker.addBar(ticker, b));
  return out;
}

// Build a price path: minutes at `below` (under VWAP), then a cross. We hold
// VWAP ≈ 10.00 by front-loading heavy volume at 10.00.
function tape(start: number, path: number[], sh = 50): VwapBar[] {
  const bars: VwapBar[] = [];
  path.forEach((p, i) => bars.push(...minute(start + i * 60, p, sh)));
  bars.push(...minute(start + path.length * 60, path[path.length - 1], sh)); // closes the last candle
  return bars;
}

function freshTracker(): VwapReclaimTracker {
  // "booted" at 03:00 ET — before the session open → session anchors.
  return new VwapReclaimTracker(OPEN - 3600);
}

console.log('S1 — clean reclaim, then hold-confirm, then lost');
{
  const tr = freshTracker();
  const start = OPEN + 3600; // 05:00 ET — 20+ min history accrues before the cross
  // 30 min anchoring at 10.00 (heavy volume pins VWAP), 6 min under, cross, hold, hold, drop.
  // VWAP ≈ 9.967 after the dip: 10.0 is +0.33% (clears the 0.2% buffer,
  // under the 1% extend line), 10.02 holds higher → confirm via hold.
  const path = [...Array(30).fill(10.0), ...Array(6).fill(9.8), 10.0, 10.02, 10.03, 9.9];
  const ev = feed(tr, tape(start, path, 200));
  const types = ev.map((e) => e.type);
  check('reclaim fired', types.includes('reclaim'), JSON.stringify(types));
  check('confirm via hold fired after the reclaim', ev.some((e) => e.type === 'confirm' && e.via === 'hold'), JSON.stringify(ev.map((e) => `${e.type}:${e.via ?? ''}`)));
  check('lost fired on the close under VWAP', types[types.length - 1] === 'lost', JSON.stringify(types));
  const r = ev.find((e) => e.type === 'reclaim')!;
  check('reclaim carries below_bars = 6 (flat-at-VWAP bars do not count)', r.below_bars === 6, `below_bars=${r.below_bars}`);
  check('reclaim anchor is session', r.anchor === 'session', r.anchor);
  const l = ev.find((e) => e.type === 'lost')!;
  check('lost carries minutes + peak_pct', (l.minutes ?? -1) >= 2 && (l.peak_pct ?? -1) > 0, `minutes=${l.minutes} peak=${l.peak_pct}`);
  check('episode numbering starts at 1', r.episode === 1, `episode=${r.episode}`);
}

console.log('S2 — vertical cross confirms on the reclaim bar (extend)');
{
  const tr = freshTracker();
  const start = OPEN + 3600;
  const path = [...Array(30).fill(10.0), ...Array(6).fill(9.8), 10.3];
  const ev = feed(tr, tape(start, path, 200));
  check('reclaim + confirm(extend) on the same candle', ev.length === 2 && ev[0].type === 'reclaim' && ev[1].type === 'confirm' && ev[1].via === 'extend', JSON.stringify(ev.map((e) => `${e.type}:${e.via ?? ''}`)));
}

console.log('S3 — chop around VWAP never reclaims (not enough bars below)');
{
  const tr = freshTracker();
  const start = OPEN + 3600;
  const path = [...Array(30).fill(10.0), 9.9, 10.05, 9.9, 10.05, 9.9, 10.05, 9.9, 10.05];
  const ev = feed(tr, tape(start, path, 200));
  check('no events from 1-bar dips', ev.length === 0, JSON.stringify(ev.map((e) => e.type)));
}

console.log('S4 — junk floor rejects a reclaim on a couple of odd lots');
{
  const tr = freshTracker();
  const start = OPEN + 3600;
  const bars: VwapBar[] = [];
  for (let i = 0; i < 30; i++) bars.push(...minute(start + i * 60, 10.0, 200));
  for (let i = 30; i < 36; i++) bars.push(...minute(start + i * 60, 9.8, 200));
  bars.push(...minute(start + 36 * 60, 10.1, 1, 2)); // 2 prints × 1 share ≈ $20
  bars.push(...minute(start + 37 * 60, 10.1, 1, 2));
  const ev = feed(tr, bars);
  check('no reclaim on a junk candle', !ev.some((e) => e.type === 'reclaim'), JSON.stringify(ev.map((e) => e.type)));
}

console.log('S5 — too little tape behind the VWAP → no reclaim yet');
{
  const tr = freshTracker();
  const start = OPEN + 3600;
  // Only 5 min anchoring + 6 below = 11 min of history at the cross (< 20).
  const path = [...Array(5).fill(10.0), ...Array(6).fill(9.8), 10.1, 10.12];
  const ev = feed(tr, tape(start, path, 200));
  check('min_history gate holds', ev.length === 0, JSON.stringify(ev.map((e) => e.type)));
}

console.log('S6 — unconfirmed reclaim expires after the TTL');
{
  const tr = freshTracker();
  const start = OPEN + 3600;
  // Cross at 10.05 (above buffer 0.2% of ~9.97 VWAP), then drift just under
  // the reclaim close without losing VWAP for 11 minutes.
  const path = [...Array(30).fill(10.0), ...Array(6).fill(9.8), 10.05, ...Array(11).fill(10.0)];
  const ev = feed(tr, tape(start, path, 200));
  const types = ev.map((e) => e.type);
  check('reclaim then expire, no confirm', types[0] === 'reclaim' && types.includes('expire') && !types.includes('confirm'), JSON.stringify(types));
}

console.log('S7 — late subscription → partial anchor');
{
  const tr = freshTracker();
  tr.markLate('LATE', OPEN + 3 * 3600);
  const start = OPEN + 3 * 3600; // 07:00 ET
  const path = [...Array(30).fill(10.0), ...Array(6).fill(9.8), 10.1, 10.12];
  const ev = feed(tr, tape(start, path, 200), 'LATE');
  const r = ev.find((e) => e.type === 'reclaim');
  check('reclaim fires with anchor=partial', r?.anchor === 'partial', r ? r.anchor : 'no reclaim');
}

console.log('S8 — service booted mid-session → partial anchor for everyone');
{
  const tr = new VwapReclaimTracker(OPEN + 2 * 3600); // booted 06:00 ET
  const start = OPEN + 2 * 3600;
  const path = [...Array(30).fill(10.0), ...Array(6).fill(9.8), 10.1, 10.12];
  const ev = feed(tr, tape(start, path, 200));
  const r = ev.find((e) => e.type === 'reclaim');
  check('reclaim fires with anchor=partial', r?.anchor === 'partial', r ? r.anchor : 'no reclaim');
}

console.log('S9 — session roll resets VWAP and the episode');
{
  const tr = freshTracker();
  const start = OPEN + 3600;
  const path = [...Array(30).fill(10.0), ...Array(6).fill(9.8), 10.1, 10.12];
  feed(tr, tape(start, path, 200));
  // Next session: 04:05 ET tomorrow at a totally different level.
  const start2 = OPEN + 86_400 + 300;
  const path2 = [...Array(30).fill(20.0), ...Array(6).fill(19.6), 20.2, 20.25];
  const ev2 = feed(tr, tape(start2, path2, 200));
  const r2 = ev2.find((e) => e.type === 'reclaim');
  check('new session reclaims again as episode 1', r2?.episode === 1, r2 ? `episode=${r2.episode}` : 'no reclaim');
  check('new session VWAP is near 20, not 10-ish', r2 != null && r2.vwap > 19 && r2.vwap < 21, r2 ? `vwap=${r2.vwap}` : '');
  check('new session anchor is session (late flag did not leak)', r2?.anchor === 'session', r2?.anchor ?? '');
}

console.log('S10 — snapshot reads live price vs VWAP');
{
  const tr = freshTracker();
  const start = OPEN + 3600;
  feed(tr, tape(start, [...Array(10).fill(10.0)], 200));
  const s = tr.snapshot('TEST');
  check('snapshot present and coherent', s != null && Math.abs(s.vwap - 10) < 0.01 && Math.abs(s.pct_vs_vwap) < 0.1, JSON.stringify(s));
  check('unknown symbol → null', tr.snapshot('NOPE') === null);
}

console.log('S11 — episode cap');
{
  const tr = freshTracker();
  const start = OPEN + 3600;
  const path: number[] = [...Array(30).fill(10.0)];
  for (let i = 0; i < VWAP_RECLAIM.max_episodes_day + 2; i++) {
    path.push(...Array(6).fill(9.7), 10.2, 9.6); // reclaim, then lost
  }
  const ev = feed(tr, tape(start, path, 200));
  const reclaims = ev.filter((e) => e.type === 'reclaim').length;
  check(`at most ${VWAP_RECLAIM.max_episodes_day} reclaims per session`, reclaims === VWAP_RECLAIM.max_episodes_day, `reclaims=${reclaims}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');

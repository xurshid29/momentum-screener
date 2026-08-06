// Synthetic regression for the ⤴ MACD curl detector (services/macd-curl.ts)
// — the second-leg layer behind the top-gainers MOMO tab. Run:
//   npx tsx scripts/verify-macd-curl.ts
// Real-tape validation lives in scripts/research/macd-curl-replay.ts (the
// 2026-08-05 leaders); this file pins the state-machine contract.

import { MacdCurlTracker, MACD_CURL, type MacdCurlEvent } from '../src/services/macd-curl.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const IV = MACD_CURL.interval_sec;
const T0 = 1_754_000_000 - (1_754_000_000 % IV); // deterministic epoch anchor

function run(closes: number[], tracker = new MacdCurlTracker()): MacdCurlEvent[] {
  const out: MacdCurlEvent[] = [];
  closes.forEach((c, i) => {
    const ev = tracker.addClosedBar('TEST', T0 + (i + 1) * IV, c);
    if (ev) out.push(ev);
  });
  return out;
}

// A second-leg shaped tape: base → leg 1 up → DECELERATING pullback with a
// rounded bottom (MACD resets below zero) → gentle curl → leg 2 up. The
// rounding matters: on a sharp linear V the signal is still collapsing when
// the line turns, so the cross lands one bar after the turn and legitimately
// preempts the setup (a vertical V has no curl phase — the detector goes
// straight to 'cross', by design). Real second legs base like INLF's
// ~50-min 08-05 bottom, which is what this shape mimics.
function secondLegTape(): number[] {
  const p: number[] = [];
  for (let i = 0; i < 25; i++) p.push(100);                    // warmup base
  for (let i = 0; i < 8; i++) p.push(100 + (i + 1) * 3);      // leg 1 → 124
  for (let i = 0; i < 5; i++) p.push(124 - (i + 1) * 2.5);    // fast drop → 111.5
  for (let i = 0; i < 4; i++) p.push(111.5 - (i + 1) * 1);    // slowing → 107.5
  for (let i = 0; i < 4; i++) p.push(107.5 - (i + 1) * 0.2);  // rounding → 106.7
  p.push(106.8, 107.0, 107.4, 108.0, 108.8, 110.0, 111.5);    // gentle curl
  for (let i = 0; i < 6; i++) p.push(112 + (i + 1) * 3);      // leg 2 → 130
  return p;
}

console.log('S1 warmup silence — no events before the 18th closed bar');
{
  const evs = run(Array.from({ length: 17 }, (_, i) => 100 + Math.sin(i) * 5));
  check('no events during warmup', evs.length === 0, `got ${evs.map((e) => e.type).join(',')}`);
}

console.log('S2 second-leg tape — fade at the pullback, setup then cross on the recovery');
{
  const evs = run(secondLegTape());
  const types = evs.map((e) => e.type);
  const fadeIdx = types.indexOf('fade');
  const setupIdx = types.indexOf('setup');
  const crossIdx = types.indexOf('cross', setupIdx);
  check('pullback fades', fadeIdx >= 0);
  check('recovery announces a setup', setupIdx > fadeIdx, `types: ${types.join(',')}`);
  check('cross follows the setup', setupIdx >= 0 && crossIdx > setupIdx, `types: ${types.join(',')}`);
  const setup = setupIdx >= 0 ? evs[setupIdx] : null;
  check('setup fired below the signal', setup != null && setup.gap > 0);
  check('setup honored the proximity gate',
    setup != null && setup.gap <= MACD_CURL.curl_max_gap_frac * setup.max_gap);
  check('setup line still below zero (deep reset)', setup != null && setup.below_zero);
  check('setup required consecutive rising bars',
    setup != null && setup.rising_bars >= MACD_CURL.curl_rising_bars);
}

console.log('S3 dead-chop floor — flat tape jitter never announces');
{
  const closes = Array.from({ length: 80 }, (_, i) => 100 + (i % 2 === 0 ? 0.03 : -0.03));
  const evs = run(closes);
  check('no setups on dead chop', evs.every((e) => e.type !== 'setup'),
    `got ${evs.filter((e) => e.type === 'setup').length} setups`);
}

console.log('S4 re-arm on failure — a broken curl re-announces on the next genuine turn');
{
  const p: number[] = [];
  for (let i = 0; i < 25; i++) p.push(100);
  for (let i = 0; i < 8; i++) p.push(100 + (i + 1) * 3);      // leg 1 → 124
  for (let i = 0; i < 5; i++) p.push(124 - (i + 1) * 2.5);    // fast drop → 111.5
  for (let i = 0; i < 4; i++) p.push(111.5 - (i + 1) * 1);    // slowing → 107.5
  for (let i = 0; i < 4; i++) p.push(107.5 - (i + 1) * 0.2);  // rounding → 106.7
  p.push(106.8, 107.0, 107.4);                                 // first curl → setup
  for (let i = 0; i < 6; i++) p.push(107 - (i + 1) * 1.6);    // curl FAILS → 97.4
  for (let i = 0; i < 3; i++) p.push(97.4 - (i + 1) * 0.2);   // rounding again
  p.push(96.9, 97.1, 97.5, 98.2, 99.3, 101, 104);             // second genuine curl
  const evs = run(p);
  const setups = evs.filter((e) => e.type === 'setup');
  check('two setups across the failed curl', setups.length >= 2, `got ${setups.length}`);
}

console.log('S5 duplicate/stale bars are ignored');
{
  const tracker = new MacdCurlTracker();
  const evs: MacdCurlEvent[] = [];
  secondLegTape().forEach((c, i) => {
    const ts = T0 + (i + 1) * IV;
    const ev = tracker.addClosedBar('TEST', ts, c);
    if (ev) evs.push(ev);
    const dup = tracker.addClosedBar('TEST', ts, c * 1.5); // replayed bar — must be dropped
    if (dup) evs.push(dup);
  });
  const clean = run(secondLegTape());
  check('duplicate feed produced the same event sequence',
    evs.map((e) => `${e.type}@${e.ts_sec}`).join('|') === clean.map((e) => `${e.type}@${e.ts_sec}`).join('|'));
}

console.log('S6 one setup per episode — no re-announce while the curl holds');
{
  const evs = run(secondLegTape());
  // Between the first fade and the first cross there must be exactly ONE setup
  // (the recovery curls monotonically — nothing breaks the announce level).
  const fadeIdx = evs.findIndex((e) => e.type === 'fade');
  const crossIdx = evs.findIndex((e, i) => e.type === 'cross' && i > fadeIdx);
  const between = evs.slice(fadeIdx + 1, crossIdx).filter((e) => e.type === 'setup');
  check('exactly one setup in the episode', between.length === 1, `got ${between.length}`);
}

console.log('S7 silent seed builds state without events, live continues seamlessly');
{
  const tracker = new MacdCurlTracker();
  const tape = secondLegTape();
  const seedN = 30; // through warmup + into leg 1
  tape.slice(0, seedN).forEach((c, i) => {
    const ev = tracker.addClosedBar('TEST', T0 + (i + 1) * IV, c, true);
    check('seed emits nothing', ev == null || false, `seed bar ${i} emitted ${ev?.type}`);
  });
  const evs: MacdCurlEvent[] = [];
  tape.slice(seedN).forEach((c, i) => {
    const ev = tracker.addClosedBar('TEST', T0 + (seedN + i + 1) * IV, c);
    if (ev) evs.push(ev);
  });
  check('live-after-seed still produces the setup→cross sequence',
    evs.some((e) => e.type === 'setup') && evs.some((e) => e.type === 'cross'),
    `types: ${evs.map((e) => e.type).join(',')}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');

// Synthetic regression for the EmaCrossTracker (📈 layer) — no external data
// needed; bar series are constructed to force each transition. Covers: warmup
// gating, nominate→confirm, the confirm notional floor (dead-tape 3× must NOT
// confirm), instant-confirm and its notional demotion to nominate, the price
// hold, the post-expire re-arm cooldown (the TGHL lesson), confirm-ends-the-
// day, boot-seed silence, gap-decay parity + in-gap flip pending (the CPHI
// lesson), the warm-symbol consolidated re-seed, and the parallel
// price-reclaim channel (S27-S28). Legacy scenarios run with reclaim_detect
// OFF (CROSS_ONLY) so the cross channel is tested in isolation, exactly as
// before the reclaim channel existed.
// Run: npx tsx scripts/verify-ema-cross.ts
import { EmaCrossTracker, EMA_CROSS, EMA_CROSS_15M, EMA_CROSS_1H, EMA_CROSS_4H, EMA_CROSS_1D, adjustSplitHistory, type EmaCrossConfig, type EmaCrossEvent } from '../src/services/ema-cross.js';

const T0 = 1_750_000_200; // aligned to a 5m boundary — a SUNDAY ~11:10 ET, so
                          // gap-decay never applies and pre-decay scenarios
                          // keep their exact original semantics
const T0_SESSION = 1_750_168_800; // Tuesday 2025-06-17 10:00 ET (EDT), 5m-aligned
                                  // — mid-session weekday for gap-decay scenarios

// The cross channel in isolation — the Sim default, keeping every
// pre-reclaim scenario's counts byte-identical. cross_detect is forced ON:
// prod retired the crossover (2026-07-26) but the machinery stays tested.
const CROSS_ONLY: EmaCrossConfig = { ...EMA_CROSS, reclaim_detect: false, cross_detect: true };
// Both channels on — for the independence scenario.
const BOTH_ON: EmaCrossConfig = { ...EMA_CROSS, cross_detect: true };

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

class Sim {
  tracker: EmaCrossTracker;
  events: EmaCrossEvent[] = [];
  liveClosed = 0;
  lastCloseTs = 0;
  private iv: number;
  private i = 0;
  private t0: number;
  constructor(private sym = 'TEST', cfg: EmaCrossConfig = CROSS_ONLY, t0 = T0) {
    this.iv = cfg.interval_sec;
    this.t0 = t0;
    this.tracker = new EmaCrossTracker(cfg, (_t, closeTs) => {
      this.liveClosed++;
      this.lastCloseTs = closeTs;
    });
  }
  // Feed one live tick that opens bucket i (closing bucket i-1). The event for
  // a bar surfaces when the NEXT bar's first tick arrives — feed a trailing
  // flush bar to close the last one you care about.
  bar(close: number, vol: number): EmaCrossEvent | null {
    const ev = this.tracker.addBar(this.sym, this.t0 + this.i++ * this.iv, close, vol);
    if (ev) this.events.push(ev);
    this.events.push(...this.tracker.drainEvents());
    return ev;
  }
  bars(n: number, close: number, vol: number): void {
    for (let k = 0; k < n; k++) this.bar(close, vol);
  }
  // Advance time without feeding — an on-feed silence gap (no buckets form).
  skip(n: number): void {
    this.i += n;
  }
  now(): number {
    return this.t0 + this.i * this.iv;
  }
  // Feed a tick INSIDE the currently open bucket (the one the last bar()
  // call opened) — exercises the intrabar TV-parity path.
  tick(close: number, vol: number, offsetSec = 42): EmaCrossEvent | null {
    const ev = this.tracker.addBar(this.sym, this.t0 + (this.i - 1) * this.iv + offsetSec, close, vol);
    if (ev) this.events.push(ev);
    const q = this.tracker.drainEvents();
    this.events.push(...q);
    return ev ?? q[0] ?? null;
  }
  seed(close: number, vol: number): void {
    this.tracker.seedBar(this.sym, this.t0 + this.i++ * this.iv, close, vol);
  }
  count(type: EmaCrossEvent['type'], signal?: 'cross' | 'reclaim'): number {
    return this.events.filter((e) => e.type === type
      && (signal === undefined || (signal === 'reclaim' ? e.signal === 'reclaim' : e.signal !== 'reclaim'))).length;
  }
}

// Warm the EMAs into a below-zero diff: flat, then a dip. 80 closed bars —
// past warmup_bars(65), with the fast EMA well under the slow one, ready to
// cross on a rally.
function warmDipped(s: Sim, price: number, vol: number): void {
  s.bars(55, price, vol);
  s.bars(25, price * 0.9, vol);
}

// ---------------------------------------------------------------------------
console.log('S1 — no events inside warmup');
{
  const s = new Sim();
  s.bars(25, 1.0, 10_000);
  s.bars(15, 0.9, 10_000);
  s.bars(20, 1.2, 60_000); // a violent cross pattern, but only 60 closed bars
  check('silent under warmup bars', s.events.length === 0, `${s.events.length} events`);
}

console.log('S2 — nominate, then volume-expansion confirm; confirm ends the day');
{
  const s = new Sim();
  warmDipped(s, 1.0, 10_000);
  s.bars(5, 1.2, 10_000); // rally on baseline volume → cross must NOMINATE
  check('nominated', s.count('nominate') === 1 && s.count('confirm') === 0);
  s.bar(1.25, 35_000); // 3.5× median, price holds, $43.7k notional
  s.bar(1.25, 10_000); // flush closes the 35k bar
  const cf = s.events.find((e) => e.type === 'confirm');
  check('confirmed on the expansion bar', !!cf && cf.bars_since_cross >= 1);
  check('event carries volume + sibling median', cf?.volume === 35_000 && cf?.sib_median === 10_000);
  s.bars(6, 0.8, 10_000);
  s.bars(8, 1.4, 10_000); // re-cross after the confirm
  check('no re-nomination after a confirm', s.count('nominate') === 1 && s.count('confirm') === 1);
}

console.log('S3 — thin tape: 3× ratio without confirm-grade dollars must NOT confirm');
{
  const s = new Sim();
  warmDipped(s, 0.25, 10_000); // nominate floor passes ($3k bucket), confirm floor won't
  s.bars(5, 0.3, 10_000);
  check('nominated', s.count('nominate') === 1);
  s.bar(0.31, 32_000); // 3.2× the median and price holds — but ~$9.9k < $10k
  s.bars(8, 0.3, 10_000); // run the window out
  const ex = s.events.find((e) => e.type === 'expire');
  check('no confirm below the notional floor', s.count('confirm') === 0);
  check('expired with the 3.2× peak recorded', !!ex && (ex.peak_ratio ?? 0) >= 3.1, `peak ${ex?.peak_ratio}`);
}

console.log('S4 — instant confirm: cross bar itself ≥5× with real dollars');
{
  const s = new Sim();
  warmDipped(s, 1.0, 10_000);
  s.bars(4, 1.2, 60_000); // 6× median, $72k — whichever bar crosses, it confirms
  const first = s.events[0];
  check('instant-confirmed', first?.type === 'confirm' && first.bars_since_cross === 0,
    `first event ${first?.type}, bars ${first?.bars_since_cross}`);
}

console.log('S5 — instant path demotes to nominate when confirm-grade dollars are missing');
{
  const s = new Sim();
  warmDipped(s, 0.5, 2_000);
  s.bars(4, 0.6, 12_000); // 6× the median, ~$7.2k — above nominate floor, below confirm floor
  const first = s.events[0];
  check('nominated instead of instant-confirm', first?.type === 'nominate' && first.vol_ratio >= 5,
    `first event ${first?.type} at ${first?.vol_ratio}x`);
}

console.log('S6 — price must hold: 3.5× volume below cross×1.005 does not confirm');
{
  const s = new Sim();
  warmDipped(s, 1.0, 10_000);
  s.bars(5, 1.2, 10_000);
  check('nominated', s.count('nominate') === 1);
  s.bar(1.203, 35_000); // volume + dollars fine; price under 1.2×1.005
  s.bars(6, 1.19, 10_000);
  check('no confirm without the price hold', s.count('confirm') === 0);
  check('expired', s.count('expire') === 1);
}

console.log('S7 — expired nomination re-arms only after the cooldown');
{
  const s = new Sim();
  warmDipped(s, 1.0, 10_000);
  s.bars(5, 1.2, 10_000);
  s.bars(7, 1.19, 10_000); // quiet window → expire
  const ex = s.events.find((e) => e.type === 'expire');
  check('first observation expired', !!ex);
  const lockedUntil = (ex?.ts_sec ?? 0) + EMA_CROSS.renominate_cooldown_sec;
  // Dip/rally cycles: the early re-crosses land inside the cooldown and must
  // stay silent; a later one (≥12 bars after expire) re-nominates — stop
  // there so the expansion bar lands inside the fresh observation window.
  let renom: EmaCrossEvent | null = null;
  outer: for (let cycle = 0; cycle < 6 && !renom; cycle++) {
    for (const [n, p] of [[3, 0.7], [3, 1.3]] as const) {
      for (let k = 0; k < n; k++) {
        const ev = s.bar(p, 10_000);
        if (ev?.type === 'nominate') { renom = ev; break outer; }
      }
    }
  }
  const noms = s.events.filter((e) => e.type === 'nominate');
  check('no nomination inside the cooldown', !noms.some((e) => e.ts_sec > (ex?.ts_sec ?? 0) && e.ts_sec < lockedUntil));
  check('re-nominated after the cooldown', !!renom && renom.ts_sec >= lockedUntil);
  s.bar(1.4, 60_000); // expansion with dollars inside the second observation
  s.bar(1.4, 10_000);
  check('second observation can confirm', s.count('confirm') === 1);
}

console.log('S8 — boot-seeded bars are silent but count toward warmup');
{
  const s = new Sim();
  check('fresh symbol is seedable', s.tracker.canSeed('TEST'));
  for (let k = 0; k < 55; k++) s.seed(1.0, 10_000);
  for (let k = 0; k < 25; k++) s.seed(0.9, 10_000);
  check('seeded symbol no longer seedable', !s.tracker.canSeed('TEST'));
  check('seeding emitted nothing', s.events.length === 0 && s.liveClosed === 0);
  s.bars(5, 1.2, 10_000); // live rally right after boot — warmup carried over
  check('live cross fires on seed-warmed EMAs', s.count('nominate') === 1);
  check('only live bars persist', s.liveClosed > 0 && s.liveClosed <= 5, `${s.liveClosed} persisted`);
}

console.log('S9 — intrabar: nominate seconds into the bar, confirm as volume floods (DXST/EHGO)');
{
  const s = new Sim();
  warmDipped(s, 1.0, 10_000);
  s.bar(0.95, 1_000); // bucket opens quietly below the cross
  const nom = s.tick(1.35, 4_000, 42); // 42s in: provisional EMAs cross, volume still thin
  check('nominated mid-bar (not at close)', nom?.type === 'nominate' && nom.intrabar === true,
    `got ${nom?.type ?? 'nothing'}`);
  const cf = s.tick(1.4, 50_000, 90); // the surge lands: 5.5× accumulated on the cross bar, $77k
  check('confirmed mid-bar on accumulated volume', cf?.type === 'confirm' && cf.intrabar === true && cf.bars_since_cross === 0,
    `got ${cf?.type ?? 'nothing'}`);
  check('no duplicate events when the bar closes', (s.bars(2, 1.4, 10_000), s.count('nominate') === 1 && s.count('confirm') === 1));
}

console.log('S10 — intrabar cross bar can only instant-confirm (5×); 3× waits for the next bar');
{
  const s = new Sim();
  warmDipped(s, 1.0, 10_000);
  s.bar(0.95, 1_000);
  const nom = s.tick(1.35, 4_000);
  check('nominated mid-bar', nom?.type === 'nominate' && nom.intrabar === true);
  s.tick(1.36, 30_000, 100); // 3.5× accumulated — below the cross bar's 5× rule
  check('3.5× mid-cross-bar does not confirm', s.count('confirm') === 0);
  s.bar(1.36, 1_000); // closes the cross bar at 3.5× → still the 5× rule → no confirm
  check('3.5× at cross-bar close does not confirm either', s.count('confirm') === 0);
  const cf = s.tick(1.4, 35_000, 60); // next bar: 3.5× accumulated + price hold → confirms
  check('next bar confirms intrabar at 3×', cf?.type === 'confirm' && cf.intrabar === true && cf.bars_since_cross === 1,
    `got ${cf?.type ?? 'nothing'}, bars ${cf?.bars_since_cross}`);
}

console.log('S11 — intrabar respects the floors: thin-tape dollars and the cooldown');
{
  const s = new Sim();
  warmDipped(s, 0.5, 2_000);
  s.bar(0.48, 200);
  const nom = s.tick(0.62, 12_000); // ~6× accumulated, ~$7.6k — above nominate floor, below confirm
  check('intrabar 6× without confirm dollars only nominates', nom?.type === 'nominate' && nom.intrabar === true);
  s.tick(0.63, 2_000, 120); // more volume — bucket still below $10k
  check('still no confirm', s.count('confirm') === 0);
  s.bars(8, 0.5, 2_000); // run the window out (price below the hold line)
  check('expired', s.count('expire') === 1);
  const ex = s.events.find((e) => e.type === 'expire');
  const locked = (ex?.ts_sec ?? 0) + EMA_CROSS.renominate_cooldown_sec;
  s.bars(3, 0.4, 2_000);
  s.bar(0.55, 2_000);
  const early = s.tick(0.58, 2_000, 60); // re-cross poke inside the cooldown
  check('intrabar re-cross blocked inside the cooldown',
    early == null && !s.events.some((e) => e.type === 'nominate' && e.ts_sec > (ex?.ts_sec ?? 0) && e.ts_sec < locked));
}

console.log('S12 — 4h config: same machine at interval 14400, tf-stamped, offset-aligned buckets');
{
  const OFF = 3600; // the EST anchor — buckets must land on offset-shifted boundaries
  const s = new Sim('TEST', { ...EMA_CROSS_4H, cross_detect: true, reclaim_detect: false, bucket_offset_sec: OFF });
  warmDipped(s, 1.0, 10_000);
  check('4h bar closes land on the offset grid', (s.lastCloseTs - OFF) % 14_400 === 0,
    `closeTs ${s.lastCloseTs}`);
  s.bar(0.95, 1_000);
  const nom = s.tick(1.35, 4_000);
  check('4h intrabar nomination fires', nom?.type === 'nominate' && nom.intrabar === true);
  check('events carry tf=4h', nom?.tf === '4h');
  const cf = s.tick(1.4, 50_000, 90);
  check('4h intrabar confirm on accumulated volume', cf?.type === 'confirm' && cf.tf === '4h');
}

console.log('S13 — split adjustment: reverse splits rescale seed history; real moves untouched');
{
  const D = 86_400;
  const mk = (a: [number, number, number][]) => a.map(([closeTs, close, volume]) => ({ closeTs, close, volume }));
  // WOK-shaped reverse split: $0.10-0.11 → $2.05 overnight (observed 18.6× → factor 19)
  const rs = adjustSplitHistory(mk([[0, 0.10, 1000], [14_400, 0.11, 1000], [14_400 + D, 2.05, 50]]));
  check('pre-split closes rescaled', Math.abs(rs[1].close - 0.11 * 19) < 1e-9 && rs[2].close === 2.05,
    `${rs[0].close.toFixed(2)}/${rs[1].close.toFixed(2)}/${rs[2].close}`);
  check('pre-split volumes divided', Math.abs(rs[0].volume - 1000 / 19) < 1e-9);
  const gap = adjustSplitHistory(mk([[0, 1.0, 1000], [D, 2.3, 5000]]));
  check('real overnight news gap (2.3×, non-integer) untouched', gap[0].close === 1.0);
  const crash = adjustSplitHistory(mk([[0, 11.3, 1000], [D, 1.22, 5000]]));
  check('real overnight crash (-89%) untouched — down-moves are never splits', crash[0].close === 11.3);
  const intraday = adjustSplitHistory(mk([[0, 0.9, 1000], [14_400, 3.95, 9000]]));
  check('same-session 4.4× pump untouched', intraday[0].close === 0.9);
}

console.log('S14 — golden reference: tracker EMAs match an independent implementation exactly');
{
  // Deterministic pseudo-random walk (LCG) — 400 bars of jittery prices and
  // volumes, fed tick-by-tick; the tracker's internal EMA state must equal a
  // straightforward EMA computed over the same CLOSED bar sequence.
  let x = 42;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const s = new Sim();
  const closes: number[] = [];
  let price = 2.0;
  for (let i = 0; i < 400; i++) {
    price = Math.max(0.2, price * (1 + (rnd() - 0.5) * 0.06));
    const vol = Math.round(500 + rnd() * 20_000);
    closes.push(price);
    s.bar(price, vol);
  }
  // The last fed bar is still open — the reference covers the closed 399.
  const closed = closes.slice(0, -1);
  const ref = (len: number): number => {
    let e = 0, seed = 0;
    closed.forEach((c, i) => {
      const n = i + 1;
      if (n <= len) { seed += c; if (n === len) e = seed / len; }
      else e = c * (2 / (len + 1)) + e * (1 - 2 / (len + 1));
    });
    return e;
  };
  const snap = s.tracker.snapshot('TEST')!;
  check('bars counted', snap.bars === closed.length, `${snap.bars} vs ${closed.length}`);
  check('fast EMA exact', Math.abs((snap.ema_fast ?? 0) - ref(EMA_CROSS.fast)) < 1e-9,
    `${snap.ema_fast} vs ${ref(EMA_CROSS.fast)}`);
  check('slow EMA exact', Math.abs((snap.ema_slow ?? 0) - ref(EMA_CROSS.slow)) < 1e-9,
    `${snap.ema_slow} vs ${ref(EMA_CROSS.slow)}`);
}

console.log('S15 — 1h config: same machine at interval 3600, tf-stamped');
{
  const s = new Sim('TEST', { ...EMA_CROSS_1H, cross_detect: true, reclaim_detect: false });
  warmDipped(s, 1.0, 10_000);
  s.bar(0.95, 1_000);
  const nom = s.tick(1.35, 4_000);
  check('1h intrabar nomination fires with tf=1h', nom?.type === 'nominate' && nom.tf === '1h' && nom.intrabar === true);
  const cf = s.tick(1.4, 50_000, 90);
  check('1h intrabar confirm on accumulated volume', cf?.type === 'confirm' && cf.tf === '1h');
}

console.log('S16 — junk-print phantom (LBTYK): an $11 odd-lot print cannot nominate');
{
  const s = new Sim();
  s.bars(70, 1.0, 10_000); // flat tape: EMAs equal, prevDiff 0 (≤0 qualifies for a cross)
  const ev = s.bar(1.1, 1); // lone 1-share print 10% above market opens a bucket
  check('phantom tick blocked intrabar', ev == null);
  s.bar(1.0, 10_000); // closes the 1-share bar — the closed path must skip it too
  check('phantom bar blocked at close', s.count('nominate') === 0 && s.count('confirm') === 0);
  s.bars(5, 0.9, 10_000); // the consumed cross re-arms via a genuine re-dip…
  s.bars(3, 1.1, 10_000); // …and a real-dollar re-cross still fires
  check('real re-cross still nominates', s.count('nominate') === 1);
}

console.log('S17 — stale-EMA guard (SKYQ): long in-session gaps cannot nominate intrabar');
{
  const s = new Sim();
  s.tracker.setSessionOpen(T0); // everything in this sim is "in-session"
  warmDipped(s, 1.0, 10_000);
  s.skip(30); // 30 bar-intervals of feed silence while the EMAs sit stale
  const resume = s.bar(1.35, 10_000); // gap-resume tick provisionally crosses…
  check('gap-resume tick suppressed intrabar', resume == null);
  const closed = s.bar(1.36, 10_000); // …but only after the resume bucket commits
  check('nomination fires once fresh data is committed (≤1 bar late)',
    closed?.type === 'nominate', `got ${closed?.type ?? 'nothing'}`);
}

console.log('S18 — stale guard exempts the session open (overnight gaps are symmetric)');
{
  const s = new Sim();
  warmDipped(s, 1.0, 10_000);
  s.skip(96); // "overnight": no bars for 8h of wall clock
  s.tracker.setSessionOpen(s.now() - 60); // the session just re-opened
  const openTick = s.bar(1.35, 10_000); // first tick after the open
  check('session-open resume may nominate intrabar', openTick?.type === 'nominate' && openTick.intrabar === true,
    `got ${openTick?.type ?? 'nothing'}`);
}

console.log('S19 — seed/live continuity: a deploy-style split changes nothing');
{
  // The same pseudo-random series run two ways: (A) fully live, (B) first
  // 137 bars boot-seeded + the rest live — the EMA state must be IDENTICAL.
  // This is the invariant that makes deploy-heavy days mathematically safe.
  let x = 7;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const series: Array<{ c: number; v: number }> = [];
  let p = 3.0;
  for (let i = 0; i < 300; i++) {
    p = Math.max(0.5, p * (1 + (rnd() - 0.5) * 0.05));
    series.push({ c: p, v: Math.round(1_000 + rnd() * 20_000) });
  }
  const a = new Sim();
  series.forEach((bb) => a.bar(bb.c, bb.v));
  const b = new Sim();
  series.slice(0, 137).forEach((bb) => b.seed(bb.c, bb.v));
  series.slice(137).forEach((bb) => b.bar(bb.c, bb.v));
  const sa = a.tracker.snapshot('TEST')!;
  const sb = b.tracker.snapshot('TEST')!;
  check('bars identical', sa.bars === sb.bars, `${sa.bars} vs ${sb.bars}`);
  check('fast EMA identical', Math.abs((sa.ema_fast ?? 0) - (sb.ema_fast ?? 0)) < 1e-12,
    `${sa.ema_fast} vs ${sb.ema_fast}`);
  check('slow EMA identical', Math.abs((sa.ema_slow ?? 0) - (sb.ema_slow ?? 0)) < 1e-12,
    `${sa.ema_slow} vs ${sb.ema_slow}`);
  check('sibling median identical', sa.sib_median === sb.sib_median);
  check('prev diff identical', Math.abs((sa.prev_diff ?? 0) - (sb.prev_diff ?? 0)) < 1e-12);
}

console.log('S20 — pending cross (ZBAO): a quiet-curl cross waits for dollars, then fires');
{
  const s = new Sim();
  s.bars(70, 1.0, 10_000); // flat: EMAs equal, prevDiff 0
  s.bar(1.01, 300);        // price-coherent cross bar on junk dollars (~$300)
  s.bar(1.012, 250);       // closes the cross bar → pending (no event)
  s.bars(6, 1.015, 300);   // quiet drift, still junk dollars, cross alive
  check('no event while dollars are missing', s.events.length === 0, `${s.events.length} events`);
  check('tracker reports pending', s.tracker.snapshot('TEST')?.pending === true);
  s.bar(1.05, 8_000);      // dollars arrive ($8.4k) while fast still above slow
  s.bar(1.05, 8_000);      // closes the converting bar
  const nom = s.events.find((e) => e.type === 'nominate');
  check('converted to nomination', !!nom, `${s.events.length} events`);
  check('anchored at the ORIGINAL cross', !!nom && nom.cross_ts_sec != null && nom.cross_ts_sec < nom.ts_sec - 5 * 300,
    `cross_ts ${nom?.cross_ts_sec} vs ts ${nom?.ts_sec}`);
  check('pending cleared after conversion', s.tracker.snapshot('TEST')?.pending === false);
}

console.log('S21 — pending dies with the cross; outlier phantoms never pend (LBTYK safe)');
{
  const s = new Sim();
  s.bars(70, 1.0, 10_000);
  s.bar(1.01, 300);
  s.bar(1.005, 250); // pending set on the coherent junk cross
  s.bars(8, 0.9, 10_000); // cross geometry dies before dollars arrive
  check('pending cleared when the cross dies', s.tracker.snapshot('TEST')?.pending === false);
  check('no events from the dead pending', s.events.length === 0);

  const t = new Sim();
  t.bars(70, 1.0, 10_000);
  t.bar(1.1, 1);       // the LBTYK phantom: +10% outlier on $1.1
  t.bar(1.0, 10_000);  // closes it — outlier junk is DISCARDED, not pended
  check('outlier phantom never pends', t.tracker.snapshot('TEST')?.pending === false);
  t.bars(4, 1.0, 10_000); // normal tape continues — a pended phantom would convert here
  check('phantom stays silent on normal tape', t.count('nominate') === 0 && t.count('confirm') === 0);
}

console.log('S22 — gap-decay parity: an in-session feed gap equals flat carry-forward bars (CPHI)');
{
  // A: 80 real bars, a 9-bucket in-session silence, resume. B: the same 80
  // bars with the silence filled by 9 explicit flat bars at the last close.
  // The EMAs must match to 1e-9 — decay IS the flat fill, computed lazily.
  const a = new Sim('TEST', CROSS_ONLY, T0_SESSION);
  warmDipped(a, 1.0, 10_000);
  a.skip(9);
  a.bar(0.91, 10_000); // resume tick: closes the open 0.9 bar, decays the gap
  const b = new Sim('TEST', CROSS_ONLY, T0_SESSION);
  warmDipped(b, 1.0, 10_000);
  b.bars(9, 0.9, 10_000); // the flat fill, as real bars
  b.bar(0.91, 10_000);
  const sa = a.tracker.snapshot('TEST')!;
  const sb = b.tracker.snapshot('TEST')!;
  check('fast EMA matches the flat-filled series', Math.abs((sa.ema_fast ?? 0) - (sb.ema_fast ?? 0)) < 1e-9,
    `${sa.ema_fast} vs ${sb.ema_fast}`);
  check('slow EMA matches the flat-filled series', Math.abs((sa.ema_slow ?? 0) - (sb.ema_slow ?? 0)) < 1e-9,
    `${sa.ema_slow} vs ${sb.ema_slow}`);
  check('decay adds no bars to warmup or siblings', sa.bars === 80 && sb.bars === 89,
    `${sa.bars} vs ${sb.bars}`);
  check('no events from either path', a.events.length === 0 && b.events.length === 0);
}

console.log('S23 — decay flip: a quiet-curl cross DURING silence pends, then converts on dollars');
{
  const s = new Sim('TEST', CROSS_ONLY, T0_SESSION);
  warmDipped(s, 1.0, 10_000);
  s.bars(4, 1.0, 10_000);  // 3 closed recovery bars — diff still just below zero,
                           // last close now ABOVE both EMAs (the curl set-up)
  check('no cross before the gap', s.events.length === 0);
  s.skip(12);              // in-session silence — the flat carry crosses fast over slow
  s.bar(1.0, 300);         // junk resume tick (closes the open bar, decays the gap)
  check('flip parked as pending, not nominated', s.events.length === 0 && s.tracker.snapshot('TEST')?.pending === true);
  s.bar(1.01, 250);        // still junk dollars — no conversion either path
  check('junk dollars cannot convert', s.count('nominate') === 0 && s.tracker.snapshot('TEST')?.pending === true);
  s.bar(1.02, 10_000);     // dollars arrive → INTRABAR conversion at this very tick
  const nom = s.events.find((e) => e.type === 'nominate');
  check('converted to a nomination the moment dollars arrive', !!nom && nom.intrabar === true,
    `${s.events.length} events`);
  check('anchored at the in-gap cross, not the resume', !!nom && nom.cross_ts_sec != null
    && nom.cross_ts_sec > nom.ts_sec - 20 * 300 && nom.cross_ts_sec < nom.ts_sec - 2 * 300,
    `cross_ts ${nom?.cross_ts_sec} vs ts ${nom?.ts_sec}`);
  check('pending cleared after conversion', s.tracker.snapshot('TEST')?.pending === false);
}

console.log('S26 — dead sibling window (CPHI): a real-dollar cross pends and converts, not vanishes');
{
  const s = new Sim(); // consecutive bars — no decay involved; the sibling ring is the subject
  warmDipped(s, 1.0, 10); // ultra-thin tape: sibling median 10 shares (< the 50 floor)
  s.bar(1.2, 3_000);  // closes the last dip bar, opens the first real-dollar recovery bar
  s.bar(1.2, 3_000);  // closes recovery bar 1 (diff still ≤0); this tick's provisional
                      // cross meets real dollars but a dead sibling window → PEND
  check('pended intrabar over the dead sibling window (was: consumed silently)',
    s.events.length === 0 && s.tracker.snapshot('TEST')?.pending === true);
  const ev = s.tick(1.22, 3_000, 90); // dollars keep accumulating → intrabar conversion
  check('converted intrabar on dollar evidence', ev?.type === 'nominate' && ev.intrabar === true,
    `got ${ev?.type ?? 'nothing'}`);
  check('cross price anchored at the pend', ev?.cross_price === 1.2, `$${ev?.cross_price}`);
}

console.log('S24 — out-of-session gaps decay nothing (overnight/weekend EMAs hold, like TV)');
{
  // Default T0 is a Sunday — every bucket is out-of-session. The same curl
  // set-up as S23 must come through an equally long gap bit-identical to a
  // gapless control, with no pending.
  const s = new Sim();
  warmDipped(s, 1.0, 10_000);
  s.bars(4, 1.0, 10_000);
  s.skip(12);
  s.bar(1.0, 300);
  const ctl = new Sim();
  warmDipped(ctl, 1.0, 10_000);
  ctl.bars(4, 1.0, 10_000);
  ctl.bar(1.0, 300);
  const ss = s.tracker.snapshot('TEST')!;
  const sc = ctl.tracker.snapshot('TEST')!;
  check('EMAs identical to the gapless control', Math.abs((ss.ema_fast ?? 0) - (sc.ema_fast ?? 0)) < 1e-12
    && Math.abs((ss.ema_slow ?? 0) - (sc.ema_slow ?? 0)) < 1e-12);
  check('no pending from the closed-session gap', ss.pending === false);
}

console.log('S25 — reseedFromHistory: warm-symbol consolidated re-seed (CPHI/sparse path)');
{
  const s = new Sim();
  warmDipped(s, 1.0, 10_000);
  s.bars(5, 1.2, 10_000);
  s.bar(1.25, 35_000);
  s.bar(1.25, 10_000); // S2 pattern → confirmed, day flag set
  check('set-up confirmed', s.count('confirm') === 1);
  const base = s.now() + 300;
  const hist = Array.from({ length: 70 }, (_, k) => ({ closeTs: base + k * 300, close: 2.0, volume: 5_000 }));
  check('warm symbol accepts the re-seed', s.tracker.reseedFromHistory('TEST', hist));
  const snap = s.tracker.snapshot('TEST')!;
  check('EMA state rebuilt from the denser series', snap.bars === 70
    && Math.abs((snap.ema_fast ?? 0) - 2.0) < 1e-9 && Math.abs((snap.ema_slow ?? 0) - 2.0) < 1e-9);
  check('day flag survives the re-seed', snap.confirmed_today === true);
  check('feed-scale sibling volumes kept (not the consolidated 5k)', snap.sib_median === 10_000,
    `median ${snap.sib_median}`);
  check('ticks at or before the re-seeded history are dropped',
    s.tracker.addBar('TEST', base + 69 * 300 - 10, 9.9, 1) == null);

  const t = new Sim();
  warmDipped(t, 1.0, 10_000);
  t.bars(5, 1.2, 10_000); // nominate → live observation in flight
  check('in-flight observation refuses the re-seed',
    t.count('nominate') === 1 && !t.tracker.reseedFromHistory('TEST', hist)
    && t.tracker.snapshot('TEST')?.observing === true);
}

console.log('S27 — price-reclaim channel: fires BEFORE the crossover, confirms on volume, independent funnels');
{
  const s = new Sim('TEST', BOTH_ON); // both channels on — independence test
  warmDipped(s, 1.0, 10_000);   // dipped close 0.9 sits below both EMAs → armed
  s.bar(0.97, 10_000); // pops above BOTH EMAs (fast ~0.90, slow ~0.955); queued event
  const nom = s.events.find((e) => e.signal === 'reclaim');
  check('reclaim nominated intrabar while the 10/65 diff is still negative',
    nom?.type === 'nominate' && nom.intrabar === true
    && s.count('nominate', 'cross') === 0,
    `got ${nom?.type ?? 'nothing'}/${nom?.signal ?? '-'}`);
  const cf = s.tick(0.98, 45_000, 90); // 5.5× accumulated on the reclaim bar, $53.9k
  check('reclaim confirmed mid-bar on accumulated volume',
    cf?.type === 'confirm' && cf.signal === 'reclaim' && cf.intrabar === true && cf.bars_since_cross === 0,
    `got ${cf?.type ?? 'nothing'}`);
  s.bars(6, 1.2, 10_000); // rally drags EMA10 over EMA65 → the CROSS channel must still fire
  check('cross channel unaffected by the reclaim confirm',
    s.count('nominate', 'cross') === 1,
    `${s.count('nominate', 'cross')} cross nominations`);
  check('reclaim channel done for the day', s.count('nominate', 'reclaim') === 1 && s.count('confirm', 'reclaim') === 1);
}

console.log('S28 — reclaim arms only from below BOTH EMAs; a confirm ends its day');
{
  const s = new Sim('TEST', EMA_CROSS);
  warmDipped(s, 1.0, 10_000);
  s.bar(0.93, 10_000);  // recovers above the fast EMA but NOT the slow — not armed
  const ev = s.bar(1.0, 10_000); // clears both, but prev bar was between the EMAs
  check('no reclaim without prev-below-BOTH (gradual walk excluded)',
    ev == null && s.count('nominate', 'reclaim') === 0, `${s.events.length} events`);

  const t = new Sim('TEST', EMA_CROSS);
  warmDipped(t, 1.0, 10_000);
  t.bar(0.97, 60_000);  // reclaim bar arrives 6× with $58k → instant confirm
  const first = t.events.find((e) => e.signal === 'reclaim');
  check('reclaim instant-confirms on a 6× dollar bar',
    first?.type === 'confirm' && first.bars_since_cross === 0, `got ${first?.type ?? 'nothing'}`);
  t.bars(8, 0.85, 10_000); // dip back below both — re-arms the condition…
  t.bars(2, 1.0, 10_000);  // …and pops again
  check('confirmed reclaim stays silent for the rest of the day',
    t.count('nominate', 'reclaim') === 0 && t.count('confirm', 'reclaim') === 1);
}

console.log('S29 — pending reclaim (AMIX): a thin-window burst pends and converts, not vanishes');
{
  const s = new Sim('TEST', EMA_CROSS);
  warmDipped(s, 1.0, 10);  // dead tape (10-sh sibling median), ends dipped → armed
  s.bar(1.05, 3_000);      // real-dollar burst bar pops above both EMAs
  s.bar(1.06, 3_000);      // closes the burst bar → thin window → PEND; new bucket's
                           // dollars then convert INTRABAR on this same tick
  const nom = s.events.find((e) => e.signal === 'reclaim');
  check('thin-window reclaim pended and converted on dollars',
    nom?.type === 'nominate' && nom.intrabar === true, `got ${nom?.type ?? 'nothing'}`);
  check('anchored at the original reclaim bar', !!nom && nom.cross_ts_sec != null && nom.cross_ts_sec <= nom.ts_sec,
    `cross_ts ${nom?.cross_ts_sec} vs ts ${nom?.ts_sec}`);
  check('pending cleared after conversion', s.tracker.snapshot('TEST')?.pending_reclaim === false);

  const t = new Sim('TEST', EMA_CROSS);
  warmDipped(t, 1.0, 10);
  t.bar(1.05, 3_000);      // burst bar
  t.bar(0.85, 3_000);      // closes it → PEND; price then collapses back inside
  check('pend created on the thin-window burst', t.tracker.snapshot('TEST')?.pending_reclaim === true);
  t.bar(0.86, 3_000);      // the 0.85 close lands back below the stack → pend dies
  check('pending reclaim dies when price closes back inside the stack',
    t.tracker.snapshot('TEST')?.pending_reclaim === false && t.count('nominate', 'reclaim') === 0);
}

console.log('S30 — prod configs are reclaim-only: the crossover pattern emits no cross events');
{
  const s = new Sim('TEST', EMA_CROSS); // prod 5m: cross_detect false
  warmDipped(s, 1.0, 10_000);
  s.bars(5, 1.2, 10_000);   // the classic S2 crossover pattern
  s.bar(1.25, 35_000);
  s.bar(1.25, 10_000);
  check('no cross-channel events', s.count('nominate', 'cross') === 0 && s.count('confirm', 'cross') === 0,
    `${s.events.length} events`);
  check('reclaim channel carried the detection',
    s.count('nominate', 'reclaim') + s.count('confirm', 'reclaim') >= 1);
}

console.log('S31 — 15m and 1d configs: reclaim fires tf-stamped on the new grids');
{
  for (const [cfg, tf] of [[EMA_CROSS_15M, '15m'], [EMA_CROSS_1D, '1d']] as const) {
    const s = new Sim('TEST', cfg);
    warmDipped(s, 1.0, 10_000);
    s.bar(0.97, 10_000); // pops above both EMAs — intrabar reclaim
    const nom = s.events.find((e) => e.signal === 'reclaim');
    check(`${tf} reclaim nominates with tf stamped`,
      nom?.type === 'nominate' && nom.tf === tf, `got ${nom?.type ?? 'nothing'}/${nom?.tf ?? '-'}`);
  }
}

console.log('S32 — basis break (FFAI split): an overnight regime jump resets state, no phantom');
{
  const s = new Sim('TEST', EMA_CROSS); // prod reclaim-only config
  warmDipped(s, 1.0, 10_000);   // last close 0.9 sits below both EMAs — armed
  s.skip(96);                   // 8h of silence — an overnight boundary
  const ev = s.bar(85.0, 10_000); // ~94× the last close: the split print
  check('no event on the split print', ev == null && s.events.length === 0, `${s.events.length} events`);
  check('state reset — symbol is seedable again', s.tracker.canSeed('TEST'));

  const t = new Sim('TEST', EMA_CROSS);
  warmDipped(t, 1.0, 10_000);
  t.skip(96);
  t.bar(2.07, 30_000);          // +130% overnight gap, non-integer ratio — REAL news gap
  check('a real non-integer overnight gap does NOT reset', !t.tracker.canSeed('TEST'));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

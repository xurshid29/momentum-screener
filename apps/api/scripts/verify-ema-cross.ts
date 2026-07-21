// Synthetic regression for the EmaCrossTracker (📈 layer) — no external data
// needed; bar series are constructed to force each transition. Covers: warmup
// gating, nominate→confirm, the confirm notional floor (dead-tape 3× must NOT
// confirm), instant-confirm and its notional demotion to nominate, the price
// hold, the post-expire re-arm cooldown (the TGHL lesson), confirm-ends-the-
// day, and boot-seed silence. Run: npx tsx scripts/verify-ema-cross.ts
import { EmaCrossTracker, EMA_CROSS, EMA_CROSS_1H, EMA_CROSS_4H, adjustSplitHistory, type EmaCrossConfig, type EmaCrossEvent } from '../src/services/ema-cross.js';

const T0 = 1_750_000_200; // aligned to a 5m boundary; absolute value irrelevant

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
  constructor(private sym = 'TEST', cfg: EmaCrossConfig = EMA_CROSS) {
    this.iv = cfg.interval_sec;
    this.tracker = new EmaCrossTracker(cfg, (_t, closeTs) => {
      this.liveClosed++;
      this.lastCloseTs = closeTs;
    });
  }
  // Feed one live tick that opens bucket i (closing bucket i-1). The event for
  // a bar surfaces when the NEXT bar's first tick arrives — feed a trailing
  // flush bar to close the last one you care about.
  bar(close: number, vol: number): EmaCrossEvent | null {
    const ev = this.tracker.addBar(this.sym, T0 + this.i++ * this.iv, close, vol);
    if (ev) this.events.push(ev);
    return ev;
  }
  bars(n: number, close: number, vol: number): void {
    for (let k = 0; k < n; k++) this.bar(close, vol);
  }
  // Feed a tick INSIDE the currently open bucket (the one the last bar()
  // call opened) — exercises the intrabar TV-parity path.
  tick(close: number, vol: number, offsetSec = 42): EmaCrossEvent | null {
    const ev = this.tracker.addBar(this.sym, T0 + (this.i - 1) * this.iv + offsetSec, close, vol);
    if (ev) this.events.push(ev);
    return ev;
  }
  seed(close: number, vol: number): void {
    this.tracker.seedBar(this.sym, T0 + this.i++ * this.iv, close, vol);
  }
  count(type: EmaCrossEvent['type']): number {
    return this.events.filter((e) => e.type === type).length;
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

console.log('S3 — dead tape: 3× ratio without dollars must NOT confirm');
{
  const s = new Sim();
  warmDipped(s, 0.5, 100); // sibling median 100 sh ≥ sibling_min_sh(50)
  s.bars(5, 0.6, 100);
  check('nominated', s.count('nominate') === 1);
  s.bar(0.62, 350); // 3.5× the median and price holds — but only ~$217
  s.bars(6, 0.6, 100); // run the window out
  const ex = s.events.find((e) => e.type === 'expire');
  check('no confirm below the notional floor', s.count('confirm') === 0);
  check('expired with the 3.5× peak recorded', !!ex && (ex.peak_ratio ?? 0) >= 3.4, `peak ${ex?.peak_ratio}`);
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

console.log('S5 — instant path demotes to nominate when dollars are missing');
{
  const s = new Sim();
  warmDipped(s, 0.5, 100);
  s.bars(4, 0.6, 600); // 6× the median but ~$360 notional
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

console.log('S11 — intrabar respects the floors: dead-tape dollars and the cooldown');
{
  const s = new Sim();
  warmDipped(s, 0.5, 100);
  s.bar(0.48, 50);
  const nom = s.tick(0.62, 600); // 6× accumulated but ~$370 — demotes to nominate
  check('intrabar 6× without dollars only nominates', nom?.type === 'nominate' && nom.intrabar === true);
  s.tick(0.63, 350, 120); // more junk volume — still far below $10k
  check('still no confirm', s.count('confirm') === 0);
  s.bars(8, 0.6, 100); // run the window out
  check('expired', s.count('expire') === 1);
  const ex = s.events.find((e) => e.type === 'expire');
  const locked = (ex?.ts_sec ?? 0) + EMA_CROSS.renominate_cooldown_sec;
  s.bars(3, 0.45, 100);
  s.bar(0.62, 100);
  const early = s.tick(0.65, 100, 60); // re-cross poke inside the cooldown
  check('intrabar re-cross blocked inside the cooldown',
    early == null && !s.events.some((e) => e.type === 'nominate' && e.ts_sec > (ex?.ts_sec ?? 0) && e.ts_sec < locked));
}

console.log('S12 — 4h config: same machine at interval 14400, tf-stamped, offset-aligned buckets');
{
  const OFF = 3600; // the EST anchor — buckets must land on offset-shifted boundaries
  const s = new Sim('TEST', { ...EMA_CROSS_4H, bucket_offset_sec: OFF });
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
  const s = new Sim('TEST', EMA_CROSS_1H);
  warmDipped(s, 1.0, 10_000);
  s.bar(0.95, 1_000);
  const nom = s.tick(1.35, 4_000);
  check('1h intrabar nomination fires with tf=1h', nom?.type === 'nominate' && nom.tf === '1h' && nom.intrabar === true);
  const cf = s.tick(1.4, 50_000, 90);
  check('1h intrabar confirm on accumulated volume', cf?.type === 'confirm' && cf.tf === '1h');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

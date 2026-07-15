// Synthetic regression for the EmaCrossTracker (📈 layer) — no external data
// needed; bar series are constructed to force each transition. Covers: warmup
// gating, nominate→confirm, the confirm notional floor (dead-tape 3× must NOT
// confirm), instant-confirm and its notional demotion to nominate, the price
// hold, the post-expire re-arm cooldown (the TGHL lesson), confirm-ends-the-
// day, and boot-seed silence. Run: npx tsx scripts/verify-ema-cross.ts
import { EmaCrossTracker, EMA_CROSS, type EmaCrossEvent } from '../src/services/ema-cross.js';

const BAR = EMA_CROSS.interval_sec;
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
  private i = 0;
  constructor(private sym = 'TEST') {
    this.tracker = new EmaCrossTracker(() => { this.liveClosed++; });
  }
  // Feed one live tick that opens bucket i (closing bucket i-1). The event for
  // a bar surfaces when the NEXT bar's first tick arrives — feed a trailing
  // flush bar to close the last one you care about.
  bar(close: number, vol: number): EmaCrossEvent | null {
    const ev = this.tracker.addBar(this.sym, T0 + this.i++ * BAR, close, vol);
    if (ev) this.events.push(ev);
    return ev;
  }
  bars(n: number, close: number, vol: number): void {
    for (let k = 0; k < n; k++) this.bar(close, vol);
  }
  seed(close: number, vol: number): void {
    this.tracker.seedBar(this.sym, T0 + this.i++ * BAR, close, vol);
  }
  count(type: EmaCrossEvent['type']): number {
    return this.events.filter((e) => e.type === type).length;
  }
}

// Warm the EMAs into a below-zero diff: flat, then a dip. 55 closed bars —
// past warmup_bars(50), with EMA6 well under EMA50, ready to cross on a rally.
function warmDipped(s: Sim, price: number, vol: number): void {
  s.bars(40, price, vol);
  s.bars(15, price * 0.9, vol);
}

// ---------------------------------------------------------------------------
console.log('S1 — no events inside warmup');
{
  const s = new Sim();
  s.bars(20, 1.0, 10_000);
  s.bars(10, 0.9, 10_000);
  s.bars(15, 1.2, 60_000); // a violent cross pattern, but only 45 closed bars
  check('silent under 50 bars', s.events.length === 0, `${s.events.length} events`);
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
  for (let k = 0; k < 40; k++) s.seed(1.0, 10_000);
  for (let k = 0; k < 15; k++) s.seed(0.9, 10_000);
  check('seeded symbol no longer seedable', !s.tracker.canSeed('TEST'));
  check('seeding emitted nothing', s.events.length === 0 && s.liveClosed === 0);
  s.bars(5, 1.2, 10_000); // live rally right after boot — warmup carried over
  check('live cross fires on seed-warmed EMAs', s.count('nominate') === 1);
  check('only live bars persist', s.liveClosed > 0 && s.liveClosed <= 5, `${s.liveClosed} persisted`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

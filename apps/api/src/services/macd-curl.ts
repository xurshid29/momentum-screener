// MACD momentum-curl detector (⤴, 2026-08-06) — the operator's live
// second-leg strategy, automated. The reclaim layer hunts a name's FIRST
// ignition; the operator (day job, can't watch charts) trades the LATER
// legs: pick the session's top gainers, watch the 3/10/8 all-SMA MACD on
// 5m, and enter when the line turns up toward its signal after the
// pullback reset — "close to the crossover", with a tight stop. Measured
// context that motivates it: top gainers make several big moves per
// session, the pullback comes 81% of the time (entry-mechanics study
// 2026-08-01), and the INLF/YXT/ZYBT/RITR/BJDX 08-05 charts all show the
// same signature (line curls up from below zero at the base of leg N,
// crossover, leg N+1 runs).
//
// This is NOT the twice-killed "MACD as a standalone signal" (EMAMACD /
// EMAMACD2): the universe here is conditioned on "already a top gainer
// today" — a different base rate — and the detector is a display/attention
// tool, not an entry gate. Universe selection (top-10 ∪ chg ≥30%) lives in
// the poller; this module is universe-agnostic and runs on the same closed
// 5m bars the EMA layer banks, so warm state is free for any name that
// enters the top-gainer set mid-session.
//
// CLOSED BARS ONLY, deliberately: the operator's own TV indicator has
// "Wait for timeframe closes" checked, so closed-bar evaluation is exact
// parity with the chart they trade from. (Intrabar would fire on line
// wiggles the chart never commits.)
//
// The MACD here is Raschke-style 3/10/8 with SMA for both the oscillator
// and the signal: line = SMA(close,3) − SMA(close,10), signal =
// SMA(line,8). Warmup = 10 + 8 − 1 = 17 closed bars.

export interface MacdCurlConfig {
  // Lane label stamped on every event ('5m' | '2m') — the grading cut and
  // the poller's per-variant row key. Two variants since 2026-08-07: the
  // operator runs BOTH TV setups — 3/10/8 on 5m and 3/15/8 on 2m.
  variant: string;
  fast: number;              // SMA length of the fast leg (3)
  slow: number;              // SMA length of the slow leg (10 / 15)
  signal: number;            // SMA length of the signal line (8)
  interval_sec: number;      // bar interval (300 = 5m / 120 = 2m)
  // A curl needs this many CONSECUTIVE rising line closes before it can
  // announce. 2 = the line has visibly turned, one bar of confirmation —
  // matches where the operator marks their entries (INLF ~10:30 ET).
  curl_rising_bars: number;
  // "Close to the crossover": the gap (signal − line) must have closed to
  // at most this fraction of the episode's widest gap. Scale-free, so it
  // works on a $0.22 name and a $23 name alike.
  curl_max_gap_frac: number;
  // Dead-chop floor: the episode's widest gap must be at least this
  // fraction of price, else the "curl" is line/signal jitter on a flat
  // tape (real second-leg resets on these movers run 5-15% of price;
  // quiet chop runs ~0.1%).
  min_dip_frac: number;
  // A SETUP whose line later falls back below the level it announced at
  // has failed — re-arm so the next genuine curl in the same episode can
  // announce again.
  rearm_on_fail: boolean;
  // Trend-EMA length for the INFORMATIONAL price-position marker
  // (2026-08-09, operator's ask — tested BEFORE wiring: on 26 leaders × 5
  // sessions, setups with price ABOVE this EMA graded WORSE on every grid
  // (lower capture AND more drawdown; the deep below-zero resets that pay
  // sit under it) — so this is a neutral badge + tier_events meta stamp,
  // deliberately NOT a "confirmed/safe" gate. The live grading decides if
  // the 5-session inversion holds. 0 disables.
  trend_ema: number;
}

export const MACD_CURL: MacdCurlConfig = {
  variant: '5m',
  fast: 3,
  slow: 10,
  signal: 8,
  interval_sec: 300,
  curl_rising_bars: 2,
  curl_max_gap_frac: 0.65,
  min_dip_frac: 0.003,
  rearm_on_fail: true,
  trend_ema: 21,
};

// The 2m·3/15/8 variant (2026-08-07, operator's ask) — their second TV
// setup, on 2-minute buckets. Warmup 15+8 = 23 closed bars (~46 min of
// active tape); bars persist to bars_2m so it survives deploys. Same curl
// knobs — the geometry rules are scale-free.
export const MACD_CURL_2M: MacdCurlConfig = {
  variant: '2m',
  fast: 3,
  slow: 15,
  signal: 8,
  interval_sec: 120,
  curl_rising_bars: 2,
  curl_max_gap_frac: 0.65,
  min_dip_frac: 0.003,
  rearm_on_fail: true,
  trend_ema: 21,
};

// The 15m·3/15/8 variant (2026-08-08, operator's pick from an 8-config
// sweep over 18 leaders × 4 sessions — scripts/research/macd-curl-replay.ts
// with --interval/--fast/--slow/--signal): best short-horizon median
// (+3.0%/1.5h), lowest drawdown tier, ~20% fewer whipsaw crosses than
// 3/10/8; the textbook 12/26/9 graded worst on these tapes. Slow leg spans
// ~3.75h. Rides the reclaim layer's bars_15m store (Databento/Yahoo
// backfilled) — warm from boot, no new table.
export const MACD_CURL_15M: MacdCurlConfig = {
  variant: '15m',
  fast: 3,
  slow: 15,
  signal: 8,
  interval_sec: 900,
  curl_rising_bars: 2,
  curl_max_gap_frac: 0.65,
  min_dip_frac: 0.003,
  rearm_on_fail: true,
  trend_ema: 21,
};

// The 1h and 4h variants (2026-08-09, operator's ask): the swing end of the
// MOMO ladder — same 3/15/8 + 21EMA on the coarse grids, riding the 1h/4h
// reclaim layers' bar streams and their Databento-backfilled stores
// (bars_1h 35d / bars_4h 130d) — warm from boot, no new tables. The 4h
// bars arrive already anchored to the ET session grid by the EMA layer's
// bucketing; this tracker just consumes close times. Grading note: 30m-2h
// outcome horizons are sub-bar here — judge these lanes on the daily
// forward grading, not the intraday cuts.
export const MACD_CURL_1H: MacdCurlConfig = {
  variant: '1h',
  fast: 3,
  slow: 15,
  signal: 8,
  interval_sec: 3600,
  curl_rising_bars: 2,
  curl_max_gap_frac: 0.65,
  min_dip_frac: 0.003,
  rearm_on_fail: true,
  trend_ema: 21,
};
export const MACD_CURL_4H: MacdCurlConfig = {
  variant: '4h',
  fast: 3,
  slow: 15,
  signal: 8,
  interval_sec: 14_400,
  curl_rising_bars: 2,
  curl_max_gap_frac: 0.65,
  min_dip_frac: 0.003,
  rearm_on_fail: true,
  trend_ema: 21,
};

export interface MacdCurlEvent {
  // setup = the curl (the operator's entry moment): line rising toward the
  //         signal from below, most of the gap closed.
  // cross = the line closed above the signal (the confirmation).
  // fade  = the line closed back below the signal (row goes cool; also
  //         starts the next episode).
  type: 'setup' | 'cross' | 'fade';
  ticker: string;
  variant: string;           // which lane fired ('5m' | '2m') — from the config
  ts_sec: number;            // close time of the triggering bar
  price: number;             // close of the triggering bar
  line: number;              // MACD line at this close
  signal_val: number;        // signal line at this close
  gap: number;               // signal − line (positive while below)
  below_zero: boolean;       // line still under the zero line (the classic
                             // post-pullback reset — a grading cut)
  rising_bars: number;       // consecutive rising line closes at this bar
  max_gap: number;           // the episode's widest gap (context for meta)
  // Price vs the trend EMA (cfg.trend_ema) at this bar's close —
  // INFORMATIONAL; null until that EMA is seeded. ⚠️ Measured 2026-08-09:
  // above-trend setups graded WORSE, not safer — grading meta, not a gate.
  above_trend: boolean | null;
}

interface SymState {
  closes: number[];          // ring: last `slow` closes
  lines: number[];           // ring: last `signal` MACD line values
  prevLine: number | null;
  prevSig: number | null;
  rising: number;            // consecutive rising line closes
  above: boolean;            // line above signal as of the last closed bar
  maxGap: number;            // widest (signal − line) this episode
  setupLine: number | null;  // line value at the announced setup
  setupDone: boolean;        // one setup per episode (unless re-armed)
  lastCloseTs: number;
  // Trend EMA (cfg.trend_ema, SMA-seeded) — the informational price-position
  // marker. Null until seeded.
  emaT: number | null;
  seedSumT: number;
  seedCntT: number;
}

function sma(xs: number[], n: number): number {
  let s = 0;
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i];
  return s / n;
}

export class MacdCurlTracker {
  private state = new Map<string, SymState>();

  constructor(private cfg: MacdCurlConfig = MACD_CURL) {}

  symbolsTracked(): number {
    return this.state.size;
  }

  // ET-vs-UTC offset in hours (4 under EDT, 5 under EST) — the snapshot's
  // session clock for counting missed buckets. Pushed by the tick feed on
  // its sync cadence; the fixed default keeps tests deterministic.
  private etOffsetHours = 4;
  setEtOffset(hours: number): void {
    this.etOffsetHours = hours;
  }

  // True when this bucket sits inside the ETH session (04:00–20:00 ET,
  // Mon–Fri) — same rule as the EMA tracker's gap-decay clock. Only
  // in-session holes count as "the market traded without us"; nights and
  // weekends must not wash the state (TV holds its panel across the close).
  private inSession(bucketStartSec: number): boolean {
    const etSec = bucketStartSec - this.etOffsetHours * 3600;
    const secOfDay = ((etSec % 86_400) + 86_400) % 86_400;
    if (secOfDay < 4 * 3600 || secOfDay >= 20 * 3600) return false;
    const day = (Math.floor(etSec / 86_400) + 4) % 7; // epoch day 0 = Thursday
    return day !== 6 && day !== 0; // Sat / Sun
  }

  // Read-only view for a live row: the current line/signal geometry, so the
  // tab can show "curling / crossed / cooling" between events. `setup_active`
  // = a setup announced this episode and the line still rides below the
  // signal — the row's "curling" state between the setup and its resolution.
  //
  // `livePrice` (2026-08-06 evening, the LPSN/WYHG report): TV's MACD panel
  // draws the FORMING bar, while our committed state moves only when a
  // bucket closes — and a bucket only closes when the NEXT trade lands on
  // our MINI feed, so on a thin tape the tab lagged the chart by minutes
  // (LPSN read "crossed" through a visible roll-over; WYHG read "turning"
  // after TV's line had hooked above). Passing the live screen price
  // (Finviz = consolidated tape, no MINI blindness) folds it into the rings
  // provisionally. DISPLAY ONLY: events and the committed state stay
  // closed-bar, so grading semantics are untouched.
  //
  // The fold covers EVERY missed in-session bucket, not just the forming
  // bar (same evening, round 2 — LPSN/GVH again): our feed had banked
  // NOTHING of LPSN's two-hour dust-print fade ($2.40 → $2.27) and missed
  // GVH's three-bar dump, so folding ONE live bar against a ring still full
  // of stale spike closes read "crossed" through both. Each missed
  // in-session bucket now folds the live price as a flat carry (bounded at
  // one full ring refresh), which converges the line to where a tape
  // sitting at the live price actually puts it. When ≥2 buckets had to be
  // synthesized, `rising` reports 0 — a "turn" cannot be claimed from bars
  // the market printed but we never saw.
  snapshot(ticker: string, livePrice?: number, nowSec = Math.floor(Date.now() / 1000)): {
    line: number; signal_val: number; gap: number; above: boolean;
    rising_bars: number; below_zero: boolean; setup_active: boolean;
    above_trend: boolean | null;
    provisional: boolean; synth_buckets: number;
    last_close: number; last_close_ts: number;
  } | null {
    const st = this.state.get(ticker);
    if (!st || st.prevLine == null || st.prevSig == null) return null;
    let line = st.prevLine;
    let sig = st.prevSig;
    let rising = st.rising;
    let above = st.above;
    let provisional = false;
    let synth = 0;
    let emaT = st.emaT;
    let refPx = st.closes.length > 0 ? st.closes[st.closes.length - 1] : 0;
    if (
      livePrice != null && livePrice > 0 &&
      st.closes.length >= this.cfg.slow && st.lines.length >= this.cfg.signal
    ) {
      const iv = this.cfg.interval_sec;
      // Missed FULL in-session buckets between the last closed bar and the
      // bucket containing `now`, plus the forming bucket itself. Capped at a
      // full ring refresh (slow + signal) — beyond that every extra carry is
      // a no-op on the result.
      const curBucket = Math.floor(nowSec / iv) * iv;
      const cap = this.cfg.slow + this.cfg.signal;
      let k = 1;
      for (let b = st.lastCloseTs; b + iv <= curBucket && k < cap; b += iv) {
        if (this.inSession(b)) k++;
      }
      const closes = st.closes.slice();
      const lines = st.lines.slice();
      let pLine = st.prevLine;
      const kT = 2 / (this.cfg.trend_ema + 1);
      for (let j = 0; j < k; j++) {
        closes.push(livePrice);
        if (closes.length > this.cfg.slow) closes.shift();
        pLine = sma(closes, this.cfg.fast) - sma(closes, this.cfg.slow);
        lines.push(pLine);
        if (lines.length > this.cfg.signal) lines.shift();
        // Trend EMA folds forward with the same carries.
        if (emaT != null) emaT = livePrice * kT + emaT * (1 - kT);
      }
      const pSig = sma(lines, this.cfg.signal);
      // A turn is only claimable off REAL tape: with a fresh ring (k=1) the
      // usual live-vs-committed comparison holds; across a synthesized hole
      // the step-to-step "rise" is a convergence artifact, not buying.
      rising = k === 1 ? (pLine > st.prevLine ? st.rising + 1 : 0) : 0;
      above = pLine > pSig;
      line = pLine;
      sig = pSig;
      provisional = true;
      synth = k - 1;
      refPx = livePrice;
    }
    return {
      line,
      signal_val: sig,
      gap: sig - line,
      above,
      rising_bars: rising,
      below_zero: line < 0,
      setup_active: st.setupDone && !above,
      above_trend: emaT != null && refPx > 0 ? refPx > emaT : null,
      provisional,
      synth_buckets: synth,
      last_close: st.closes.length > 0 ? st.closes[st.closes.length - 1] : 0,
      last_close_ts: st.lastCloseTs,
    };
  }

  // ET-day roll: episodes don't span the closed session in spirit — a fresh
  // day starts clean. MACD rings deliberately survive (TV's line is
  // continuous across sessions too; bars-not-time, like the EMA layer).
  resetDaily(): void {
    for (const st of this.state.values()) {
      st.setupDone = false;
      st.setupLine = null;
    }
  }

  private ensure(ticker: string): SymState {
    let st = this.state.get(ticker);
    if (!st) {
      st = {
        closes: [], lines: [], prevLine: null, prevSig: null,
        rising: 0, above: false, maxGap: 0, setupLine: null,
        setupDone: false, lastCloseTs: 0,
        emaT: null, seedSumT: 0, seedCntT: 0,
      };
      this.state.set(ticker, st);
    }
    return st;
  }

  // Feed one CLOSED bar (in time order per symbol). Returns at most one
  // event. `silent` = boot-seed replay: build state, emit nothing.
  addClosedBar(ticker: string, closeTs: number, close: number, silent = false): MacdCurlEvent | null {
    const st = this.ensure(ticker);
    if (closeTs <= st.lastCloseTs) return null; // stale/duplicate replay bar
    st.lastCloseTs = closeTs;

    // Trend EMA updates on EVERY closed bar (its warmup runs independently
    // of the MACD's — events stamp null until it seeds).
    if (this.cfg.trend_ema > 0) {
      if (st.emaT == null) {
        st.seedSumT += close;
        st.seedCntT++;
        if (st.seedCntT === this.cfg.trend_ema) st.emaT = st.seedSumT / this.cfg.trend_ema;
      } else {
        const kT = 2 / (this.cfg.trend_ema + 1);
        st.emaT = close * kT + st.emaT * (1 - kT);
      }
    }

    st.closes.push(close);
    if (st.closes.length > this.cfg.slow) st.closes.shift();
    if (st.closes.length < this.cfg.slow) return null;
    const line = sma(st.closes, this.cfg.fast) - sma(st.closes, this.cfg.slow);

    st.lines.push(line);
    if (st.lines.length > this.cfg.signal) st.lines.shift();
    if (st.lines.length < this.cfg.signal) {
      st.prevLine = line;
      return null;
    }
    const sig = sma(st.lines, this.cfg.signal);

    let out: MacdCurlEvent | null = null;
    const gap = sig - line;

    if (st.prevLine != null) st.rising = line > st.prevLine ? st.rising + 1 : 0;

    const firstValid = st.prevSig == null;
    const crossedUp = !firstValid && st.prevLine != null && st.prevSig != null
      && st.prevLine <= st.prevSig && line > sig;
    const crossedDown = !firstValid && st.prevLine != null && st.prevSig != null
      && st.prevLine >= st.prevSig && line < sig;

    const mk = (type: MacdCurlEvent['type']): MacdCurlEvent => ({
      type, ticker, variant: this.cfg.variant, ts_sec: closeTs, price: close,
      line, signal_val: sig, gap,
      below_zero: line < 0,
      rising_bars: st.rising,
      max_gap: st.maxGap,
      above_trend: st.emaT != null ? close > st.emaT : null,
    });

    if (firstValid) {
      // First bar with a valid signal — just establish which side we're on.
      st.above = line > sig;
      st.maxGap = st.above ? 0 : gap;
    } else if (crossedUp) {
      if (!silent) out = mk('cross');
      st.above = true;
      st.maxGap = 0;
      st.setupDone = false;
      st.setupLine = null;
    } else if (line <= sig) {
      if (st.above) {
        // Fresh cross-down — the episode starts here.
        if (crossedDown && !silent) out = mk('fade');
        st.above = false;
        st.maxGap = gap;
        st.setupDone = false;
        st.setupLine = null;
      } else {
        if (gap > st.maxGap) st.maxGap = gap;
        // The announced curl failed (line broke below its announce level) —
        // re-arm so the episode's next genuine turn can announce.
        if (this.cfg.rearm_on_fail && st.setupDone && st.setupLine != null && line < st.setupLine) {
          st.setupDone = false;
          st.setupLine = null;
        }
        if (
          !silent && !st.setupDone &&
          st.rising >= this.cfg.curl_rising_bars &&
          st.maxGap >= this.cfg.min_dip_frac * close &&
          gap <= this.cfg.curl_max_gap_frac * st.maxGap
        ) {
          out = mk('setup');
          st.setupDone = true;
          st.setupLine = line;
        }
      }
    }
    // line > sig without a cross-up (already above): nothing to do — the
    // cross fired when it happened; the snapshot carries the live geometry.

    st.prevLine = line;
    st.prevSig = sig;
    return out;
  }
}

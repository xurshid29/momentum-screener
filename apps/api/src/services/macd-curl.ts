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
  fast: number;              // SMA length of the fast leg (3)
  slow: number;              // SMA length of the slow leg (10)
  signal: number;            // SMA length of the signal line (8)
  interval_sec: number;      // bar interval (300 = 5m)
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
}

export const MACD_CURL: MacdCurlConfig = {
  fast: 3,
  slow: 10,
  signal: 8,
  interval_sec: 300,
  curl_rising_bars: 2,
  curl_max_gap_frac: 0.65,
  min_dip_frac: 0.003,
  rearm_on_fail: true,
};

export interface MacdCurlEvent {
  // setup = the curl (the operator's entry moment): line rising toward the
  //         signal from below, most of the gap closed.
  // cross = the line closed above the signal (the confirmation).
  // fade  = the line closed back below the signal (row goes cool; also
  //         starts the next episode).
  type: 'setup' | 'cross' | 'fade';
  ticker: string;
  ts_sec: number;            // close time of the triggering bar
  price: number;             // close of the triggering bar
  line: number;              // MACD line at this close
  signal_val: number;        // signal line at this close
  gap: number;               // signal − line (positive while below)
  below_zero: boolean;       // line still under the zero line (the classic
                             // post-pullback reset — a grading cut)
  rising_bars: number;       // consecutive rising line closes at this bar
  max_gap: number;           // the episode's widest gap (context for meta)
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

  // Read-only view for a live row: the current line/signal geometry, so the
  // tab can show "curling / crossed / cooling" between events. `setup_active`
  // = a setup announced this episode and the line still rides below the
  // signal — the row's "curling" state between the setup and its resolution.
  snapshot(ticker: string): {
    line: number; signal_val: number; gap: number; above: boolean;
    rising_bars: number; below_zero: boolean; setup_active: boolean;
    last_close: number; last_close_ts: number;
  } | null {
    const st = this.state.get(ticker);
    if (!st || st.prevLine == null || st.prevSig == null) return null;
    return {
      line: st.prevLine,
      signal_val: st.prevSig,
      gap: st.prevSig - st.prevLine,
      above: st.above,
      rising_bars: st.rising,
      below_zero: st.prevLine < 0,
      setup_active: st.setupDone && !st.above,
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
      type, ticker, ts_sec: closeTs, price: close,
      line, signal_val: sig, gap,
      below_zero: line < 0,
      rising_bars: st.rising,
      max_gap: st.maxGap,
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

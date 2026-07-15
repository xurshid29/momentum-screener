// EMA-cross layer (📈, 2026-07-10) — the operator's manual TradingView loop,
// automated: an EMA(6) over EMA(50) bullish crossover on 5-minute bars
// NOMINATES a known runner for a ~30-minute observation window; it CONFIRMS
// only if volume expands vs its sibling candles (the prior hour's bars) with
// price holding above the cross — otherwise it silently expires. The cross by
// itself carries no selection power (measured twice: ≈0.9× a random bar, and
// +0.0pts paired vs our detection as an entry trigger); the volume-expansion
// stage is the measured carrier (quiet-accum cohort study), so precision here
// lives in the confirm rule. Built as a SEPARATE nomination channel because
// the cross is anchored to local price structure (a curl vs the ~4h EMA50),
// not to prior-close change like the 🤫/👀 tiers — it can fire on names flat
// or red on the day. Graded via tier_events (tier='cross') — keep/kill after
// a week of data.
//
// Bars come from the tick feed's per-second stream, aggregated here into
// 5-minute buckets (bar-close semantics like TV: a bucket closes when a trade
// arrives in a later bucket; empty buckets don't advance the EMAs — matching
// how thin names paint on a TV chart). EMAs are SMA-seeded and need
// warmup_bars closed bars before crosses count, so the layer warms up for a
// few hours after each deploy (same class of limitation as detector
// baselines; note it when grading the first hours of a day).

export const EMA_CROSS = {
  interval_sec: 300,   // 5-minute bars (the operator trades this TF on TV)
  fast: 6,
  slow: 50,
  warmup_bars: 50,     // no crosses until the slow EMA has real shape
  sibling_bars: 12,    // volume baseline = median of the prior hour's closed bars
  sibling_min_sh: 50,  // dead-tape floor — a median below this can't "expand" meaningfully
  observe_bars: 6,     // ~30 min of post-cross observation
  confirm_vol_x: 3,    // a closed bar ≥3× the sibling median…
  confirm_price_ext: 0.005, // …with close ≥ cross close × (1 + this)
  instant_vol_x: 5,    // the cross bar itself arriving ≥5× median = instant confirm
} as const;

export interface EmaCrossEvent {
  type: 'nominate' | 'confirm' | 'expire';
  ticker: string;
  ts_sec: number;        // close time of the triggering bar
  price: number;         // close of the triggering bar
  cross_price: number;   // close of the cross bar
  vol_ratio: number;     // triggering bar volume / sibling median
  bars_since_cross: number;
  peak_ratio?: number;   // expire telemetry: best vol ratio seen in the window
  peak_price?: number;   // expire telemetry: best close seen in the window
}

interface Observation {
  crossTs: number;
  crossPrice: number;
  sibMedian: number;
  barsSeen: number;
  peakRatio: number;
  peakPrice: number;
}

interface SymState {
  bucketStart: number;   // -1 = none open
  bucketClose: number;
  bucketVol: number;
  emaF: number | null;
  emaS: number | null;
  seedSumF: number;
  seedSumS: number;
  bars: number;          // closed bars seen (live + boot-seeded)
  prevDiff: number | null; // emaF - emaS at the previous closed bar
  sibVols: number[];     // ring: volumes of the last sibling_bars CLOSED bars
  watch: Observation | null;
  firedToday: boolean;   // one nomination per symbol per ET day
  seededUpTo: number;    // bucket start of the last boot-seeded bar (-1 = none)
                         // — live ticks at/before it are already accounted for
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export class EmaCrossTracker {
  private state = new Map<string, SymState>();

  // onBarClosed fires for every LIVE closed bar (not boot-seeded replays) —
  // the tick feed persists these to bars_5m so warmup survives deploys.
  constructor(private onBarClosed?: (ticker: string, closeTs: number, close: number, volume: number) => void) {}

  symbolsTracked(): number {
    return this.state.size;
  }

  // Boot-time replay of a persisted CLOSED bar: runs the same EMA/sibling/
  // counter math but emits no events, starts no observations, and does not
  // re-persist. Bars must arrive in time order per symbol. Marks the bucket
  // so a live tick belonging to an already-seeded bar can't double-process.
  seedBar(ticker: string, closeTs: number, close: number, volume: number): void {
    const st = this.ensure(ticker);
    this.processClosedBar(ticker, st, closeTs, close, volume, true);
    st.seededUpTo = closeTs - EMA_CROSS.interval_sec;
  }

  // ET-day roll: nominations re-arm, in-flight observations drop (they can't
  // span the closed session anyway — no bars 20:00→04:00). EMAs and bar
  // history deliberately survive: price structure isn't day-anchored.
  resetDaily(): void {
    for (const st of this.state.values()) {
      st.firedToday = false;
      st.watch = null;
    }
  }

  private ensure(ticker: string): SymState {
    let st = this.state.get(ticker);
    if (!st) {
      st = {
        bucketStart: -1, bucketClose: 0, bucketVol: 0,
        emaF: null, emaS: null, seedSumF: 0, seedSumS: 0,
        bars: 0, prevDiff: null, sibVols: [], watch: null, firedToday: false,
        seededUpTo: -1,
      };
      this.state.set(ticker, st);
    }
    return st;
  }

  // Feed one per-second bar; returns an event when a 5m bar CLOSES and trips
  // a transition. Aggregation is causal: a bucket only closes when a trade
  // arrives in a later bucket.
  addBar(ticker: string, tsSec: number, close: number, volume: number): EmaCrossEvent | null {
    const st = this.ensure(ticker);
    const bucket = Math.floor(tsSec / EMA_CROSS.interval_sec) * EMA_CROSS.interval_sec;
    if (bucket < st.bucketStart) return null; // stale/out-of-order tick — ignore
    if (bucket <= st.seededUpTo) return null; // bar already covered by boot seed
    if (st.bucketStart === -1) {
      st.bucketStart = bucket;
      st.bucketClose = close;
      st.bucketVol = volume;
      return null;
    }
    if (bucket === st.bucketStart) {
      st.bucketClose = close;
      st.bucketVol += volume;
      return null;
    }
    // A later bucket started → the open one is closed. Process it, then open
    // the new one.
    const closeTs = st.bucketStart + EMA_CROSS.interval_sec;
    const ev = this.processClosedBar(ticker, st, closeTs, st.bucketClose, st.bucketVol, false);
    this.onBarClosed?.(ticker, closeTs, st.bucketClose, st.bucketVol);
    st.bucketStart = bucket;
    st.bucketClose = close;
    st.bucketVol = volume;
    return ev;
  }

  private processClosedBar(ticker: string, st: SymState, closeTs: number, c: number, v: number, silent: boolean): EmaCrossEvent | null {
    st.bars++;

    // EMA update — SMA seed over the first `length` closed bars, recursive after.
    if (st.bars <= EMA_CROSS.fast) {
      st.seedSumF += c;
      if (st.bars === EMA_CROSS.fast) st.emaF = st.seedSumF / EMA_CROSS.fast;
    } else if (st.emaF != null) {
      const k = 2 / (EMA_CROSS.fast + 1);
      st.emaF = c * k + st.emaF * (1 - k);
    }
    if (st.bars <= EMA_CROSS.slow) {
      st.seedSumS += c;
      if (st.bars === EMA_CROSS.slow) st.emaS = st.seedSumS / EMA_CROSS.slow;
    } else if (st.emaS != null) {
      const k = 2 / (EMA_CROSS.slow + 1);
      st.emaS = c * k + st.emaS * (1 - k);
    }

    // Sibling median of the bars BEFORE this one — the reference this bar's
    // volume is compared against.
    const sibMedian = median(st.sibVols);

    let out: EmaCrossEvent | null = null;

    // 1) Active observation — does this bar confirm (volume expansion with
    // price holding), or does the window run out? (Skipped on boot-seed
    // replays: history must not nominate, confirm, or expire anything.)
    if (!silent && st.watch) {
      const w = st.watch;
      w.barsSeen++;
      const ratio = w.sibMedian > 0 ? v / w.sibMedian : 0;
      if (ratio > w.peakRatio) w.peakRatio = ratio;
      if (c > w.peakPrice) w.peakPrice = c;
      if (ratio >= EMA_CROSS.confirm_vol_x && c >= w.crossPrice * (1 + EMA_CROSS.confirm_price_ext)) {
        out = {
          type: 'confirm', ticker, ts_sec: closeTs, price: c,
          cross_price: w.crossPrice, vol_ratio: +ratio.toFixed(1), bars_since_cross: w.barsSeen,
        };
        st.watch = null;
      } else if (w.barsSeen >= EMA_CROSS.observe_bars) {
        out = {
          type: 'expire', ticker, ts_sec: closeTs, price: c,
          cross_price: w.crossPrice, vol_ratio: +ratio.toFixed(1), bars_since_cross: w.barsSeen,
          peak_ratio: +w.peakRatio.toFixed(1), peak_price: w.peakPrice,
        };
        st.watch = null;
      }
    }

    // 2) Cross detection — only with warmed EMAs, once per day per symbol, and
    // only when the tape has a usable sibling baseline.
    if (
      !silent &&
      out == null &&
      st.emaF != null && st.emaS != null &&
      st.bars > EMA_CROSS.warmup_bars &&
      st.prevDiff != null &&
      !st.watch && !st.firedToday
    ) {
      const diff = st.emaF - st.emaS;
      if (st.prevDiff <= 0 && diff > 0 && sibMedian >= EMA_CROSS.sibling_min_sh) {
        st.firedToday = true;
        const ratio = v / sibMedian;
        if (ratio >= EMA_CROSS.instant_vol_x && c > 0) {
          // The cross bar itself arrived on expanded volume — the operator's
          // "sometimes the current volume is much higher than siblings" case.
          out = {
            type: 'confirm', ticker, ts_sec: closeTs, price: c,
            cross_price: c, vol_ratio: +ratio.toFixed(1), bars_since_cross: 0,
          };
        } else {
          st.watch = {
            crossTs: closeTs, crossPrice: c, sibMedian,
            barsSeen: 0, peakRatio: +ratio.toFixed(1), peakPrice: c,
          };
          out = {
            type: 'nominate', ticker, ts_sec: closeTs, price: c,
            cross_price: c, vol_ratio: +ratio.toFixed(1), bars_since_cross: 0,
          };
        }
      }
    }

    if (st.emaF != null && st.emaS != null) st.prevDiff = st.emaF - st.emaS;

    // The just-closed bar becomes a sibling for the next ones.
    st.sibVols.push(v);
    if (st.sibVols.length > EMA_CROSS.sibling_bars) st.sibVols.shift();

    return out;
  }
}

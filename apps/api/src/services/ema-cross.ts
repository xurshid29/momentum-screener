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
//
// INTRABAR detection (2026-07-16, the DXST/EHGO lag report): TV alerts
// evaluate the cross on the LIVE forming bar, so the operator's alerts fired
// 42–75s into the bar while our closed-bar-only evaluation waited for the
// close — a structural ~4–5 min lag. Every live tick now also runs a
// provisional check: EMAs folded forward with the current price (closed-bar
// state untouched), and confirms may fire mid-bar on the bucket's ACCUMULATED
// volume — sound because volume is monotone: anything clearing a threshold
// mid-bar also clears it at close. Price-side repaint (a poke above that
// un-crosses by close) can nominate a wiggle — exactly what the operator's TV
// alert does — and the volume-confirm stage disposes of it. The closed-bar
// path remains as the backstop; intrabar events carry `intrabar: true` so
// grading can measure the latency win separately.

export interface EmaCrossConfig {
  tf: string;                    // label stamped on every event ('5m' | '4h')
  interval_sec: number;
  fast: number;
  slow: number;
  warmup_bars: number;
  sibling_bars: number;
  sibling_min_sh: number;
  observe_bars: number;
  confirm_vol_x: number;
  confirm_price_ext: number;
  instant_vol_x: number;
  confirm_min_notional: number;
  renominate_cooldown_sec: number;
  intrabar_detect: boolean;
  // Bucket anchor offset in seconds. 5m buckets divide the hour so 0 always
  // works; 4h buckets must align to the ET session grid (04:00/08:00/12:00/
  // 16:00 ET — how TV draws 4h ETH bars), which is offset 0 under EDT but
  // 3600 under EST. The tick feed recomputes it at the midnight roll.
  bucket_offset_sec: number;
}

export const EMA_CROSS: EmaCrossConfig = {
  tf: '5m',
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
  // Dollar floor on the confirming bar (close × volume). The sibling floor is
  // 50 SHARES, so on a dead tape "3× the median" can be ~180 shares — under
  // $200 on a sub-$1 name. Same lesson as the tick tiers' junk floor. Applies
  // to both confirm paths; an instant-confirm that fails it demotes to a
  // normal nomination (the cross is real, the dollar evidence isn't yet).
  // ⚠️ Feed-visible (EQUS.MINI) dollars, first guess — recalibrate from the
  // notional now recorded in tier_events meta.
  confirm_min_notional: 10_000,
  // Re-arm cooldown after an EXPIRED observation. Nominations were originally
  // once/ticker/day, but TGHL 2026-07-15 showed why that's wrong: a weak
  // 0.4× morning cross burned the slot and expired, and the REAL 16:25 cross
  // (6.7×, ran +20%) would have been locked out — it only fired because a
  // deploy happened to reset the tracker. A CONFIRMED cross still ends the
  // symbol's day (it's already surfaced); an expired one re-arms after this.
  renominate_cooldown_sec: 3600,
  // TV-parity live evaluation (see header). Kill switch only — flip to false
  // if the fast path misbehaves live; detection reverts to bar-close-only.
  intrabar_detect: true,
  bucket_offset_sec: 0,
};

// The 4h layer (2026-07-17): the operator's swing-timing loop — same 6/50
// cross, 4-hour ETH bars, detected intrabar the second it happens. They keep
// the entry filter and the exit; this is a pure detection tool (dashboard
// only, no Telegram until tier_events shows the real fire rate). Confirm
// machinery runs identically for grading, but the NOMINATION is the product.
export const EMA_CROSS_4H: EmaCrossConfig = {
  tf: '4h',
  interval_sec: 14_400,
  fast: 6,
  slow: 50,
  warmup_bars: 50,          // ~2-3 weeks of tape — needs the bars_4h backfill
  sibling_bars: 12,         // ~2 trading days of volume context
  sibling_min_sh: 50,
  observe_bars: 6,          // ~24h observation
  confirm_vol_x: 3,
  confirm_price_ext: 0.005,
  instant_vol_x: 5,
  confirm_min_notional: 10_000,
  renominate_cooldown_sec: 14_400, // one bar — a dud re-arms next bar
  intrabar_detect: true,
  bucket_offset_sec: 0,     // set live by the tick feed (EDT 0 / EST 3600)
};

export interface EmaCrossEvent {
  type: 'nominate' | 'confirm' | 'expire';
  ticker: string;
  tf: string;            // which layer fired ('5m' | '4h') — from the config
  ts_sec: number;        // close time of the triggering bar (intrabar: the tick's time)
  price: number;         // close of the triggering bar (intrabar: the tick's price)
  cross_price: number;   // close of the cross bar
  vol_ratio: number;     // triggering bar volume / sibling median (intrabar: volume so far)
  volume: number;        // triggering bar volume (shares) — makes the ratio auditable
  sib_median: number;    // the sibling median the ratio was computed against
  bars_since_cross: number;
  intrabar?: boolean;    // fired mid-bar by the TV-parity live check
  peak_ratio?: number;   // expire telemetry: best vol ratio seen in the window
  peak_price?: number;   // expire telemetry: best close seen in the window
}

interface Observation {
  crossTs: number;
  crossPrice: number;
  sibMedian: number;
  barsSeen: number;      // CLOSED bars observed after the cross bar
  peakRatio: number;
  peakPrice: number;
  crossBucket: number;   // bucket start of the cross bar; -1 = cross bar already
                         // closed when detected (close-path nomination)
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
  confirmedToday: boolean; // a confirm ends the symbol's day (already surfaced)
  lockedUntil: number;   // no re-nomination before this ts (cooldown after expire)
  seededUpTo: number;    // bucket start of the last boot-seeded bar (-1 = none)
                         // — live ticks at/before it are already accounted for
}

export interface SeedHistoryBar { closeTs: number; close: number; volume: number }

// Split-adjust a symbol's SEED history (the WOK lesson, 2026-07-17): TV
// charts are split-adjusted, Databento serves raw prices — a reverse split
// inside the seed window leaves the EMA50 computed over two price scales
// (WOK: pre-split $0.05-1.12 mixed with post-split ~$2 put our EMA50 at
// 2.00 vs TV's 2.63, and a $2.04 poke "crossed"). Detection is asymmetric
// by design: reverse splits are UP jumps (nobody forward-splits a $2
// stock), while big overnight DOWN gaps are real crashes (WOK itself had a
// genuine -89% overnight dump) — so only up-jumps across an overnight gap
// qualify: ≥4.85× unconditionally (real overnight gaps that large are
// effectively nonexistent), 1.94-4.85× only within 2.5% of a whole-number
// ratio (real news gaps land at 2.3×, 2.7× — not on integers). Earlier
// closes multiply by the factor, volumes divide (share count scales
// inversely). The observed boundary ratio embeds that day's real move, so
// the factor is rounded to the nearest integer — small residual error on
// old bars, decayed by the EMA.
export function adjustSplitHistory(bars: SeedHistoryBar[]): SeedHistoryBar[] {
  if (bars.length < 2) return bars;
  const factors: { idx: number; f: number }[] = []; // f applies to bars [0, idx)
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i];
    if (cur.closeTs - prev.closeTs < 6 * 3600) continue; // same session — never a split
    if (!(prev.close > 0) || !(cur.close > 0)) continue;
    const r = cur.close / prev.close;
    if (r >= 4.85) {
      factors.push({ idx: i, f: Math.round(r) });
    } else if (r >= 1.94) {
      const n = Math.round(r);
      if (n >= 2 && Math.abs(r - n) / n <= 0.025) factors.push({ idx: i, f: n });
    }
  }
  if (factors.length === 0) return bars;
  const out = bars.map((b) => ({ ...b }));
  let cum = 1;
  let fi = factors.length - 1;
  for (let i = out.length - 1; i >= 0; i--) {
    while (fi >= 0 && factors[fi].idx === i + 1) { cum *= factors[fi].f; fi--; }
    if (cum !== 1) { out[i].close *= cum; out[i].volume /= cum; }
  }
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export class EmaCrossTracker {
  private state = new Map<string, SymState>();
  private bucketOff: number;

  // onBarClosed fires for every LIVE closed bar (not boot-seeded replays) —
  // the tick feed persists these (bars_5m / bars_4h) so warmup survives
  // deploys. cfg defaults to the 5m layer for backward compatibility.
  constructor(
    private cfg: EmaCrossConfig = EMA_CROSS,
    private onBarClosed?: (ticker: string, closeTs: number, close: number, volume: number) => void,
  ) {
    this.bucketOff = cfg.bucket_offset_sec;
  }

  symbolsTracked(): number {
    return this.state.size;
  }

  // DST-aware bucket anchor (see EmaCrossConfig.bucket_offset_sec). Safe to
  // change at the midnight roll — no buckets are open then.
  setBucketOffset(sec: number): void {
    this.bucketOff = sec;
  }

  // True when historical bars may still be seeded for this symbol — i.e. it
  // has never produced a live bar. Once live aggregation has started, seeding
  // older bars would corrupt EMA ordering, so the backfill must skip it.
  canSeed(ticker: string): boolean {
    const st = this.state.get(ticker);
    return !st || (st.bars === 0 && st.bucketStart === -1);
  }

  // Boot-time replay of a persisted CLOSED bar: runs the same EMA/sibling/
  // counter math but emits no events, starts no observations, and does not
  // re-persist. Bars must arrive in time order per symbol. Marks the bucket
  // so a live tick belonging to an already-seeded bar can't double-process.
  seedBar(ticker: string, closeTs: number, close: number, volume: number): void {
    const st = this.ensure(ticker);
    this.processClosedBar(ticker, st, closeTs, close, volume, true);
    st.seededUpTo = closeTs - this.cfg.interval_sec;
  }

  // ET-day roll: nominations re-arm, in-flight observations drop (they can't
  // span the closed session anyway — no bars 20:00→04:00). EMAs and bar
  // history deliberately survive: price structure isn't day-anchored.
  resetDaily(): void {
    for (const st of this.state.values()) {
      st.confirmedToday = false;
      st.lockedUntil = 0;
      st.watch = null;
    }
  }

  private ensure(ticker: string): SymState {
    let st = this.state.get(ticker);
    if (!st) {
      st = {
        bucketStart: -1, bucketClose: 0, bucketVol: 0,
        emaF: null, emaS: null, seedSumF: 0, seedSumS: 0,
        bars: 0, prevDiff: null, sibVols: [], watch: null, confirmedToday: false, lockedUntil: 0,
        seededUpTo: -1,
      };
      this.state.set(ticker, st);
    }
    return st;
  }

  // Feed one per-second bar; returns an event when a bar CLOSES and trips
  // a transition. Aggregation is causal: a bucket only closes when a trade
  // arrives in a later bucket.
  addBar(ticker: string, tsSec: number, close: number, volume: number): EmaCrossEvent | null {
    const st = this.ensure(ticker);
    const iv = this.cfg.interval_sec;
    const bucket = Math.floor((tsSec - this.bucketOff) / iv) * iv + this.bucketOff;
    if (bucket < st.bucketStart) return null; // stale/out-of-order tick — ignore
    if (bucket <= st.seededUpTo) return null; // bar already covered by boot seed
    if (st.bucketStart === -1) {
      st.bucketStart = bucket;
      st.bucketClose = close;
      st.bucketVol = volume;
      // A boot-seeded symbol is already warm — its very first live tick can
      // legitimately cross intrabar.
      return this.intrabarCheck(ticker, st, tsSec, close);
    }
    if (bucket === st.bucketStart) {
      st.bucketClose = close;
      st.bucketVol += volume;
      return this.intrabarCheck(ticker, st, tsSec, close);
    }
    // A later bucket started → the open one is closed. Process it, then open
    // the new one.
    const closeTs = st.bucketStart + iv;
    const ev = this.processClosedBar(ticker, st, closeTs, st.bucketClose, st.bucketVol, false);
    this.onBarClosed?.(ticker, closeTs, st.bucketClose, st.bucketVol);
    st.bucketStart = bucket;
    st.bucketClose = close;
    st.bucketVol = volume;
    return ev ?? this.intrabarCheck(ticker, st, tsSec, close);
  }

  // TV-parity live check, run on every tick (see header). Two jobs:
  // (1) with an active observation, confirm mid-bar on the bucket's
  // ACCUMULATED volume — the cross bar itself needs the instant rule (≥5×),
  // later bars the normal one (≥3× + price hold); both need the notional
  // floor. (2) with no observation, detect the cross itself on provisional
  // EMAs (closed EMA state folded forward with the live price — never
  // mutated). At a bucket's final tick the provisional diff equals the
  // closed-bar diff, so this path strictly precedes the closed-bar backstop.
  private intrabarCheck(ticker: string, st: SymState, tsSec: number, c: number): EmaCrossEvent | null {
    if (!this.cfg.intrabar_detect) return null;
    const w = st.watch;
    if (w) {
      if (w.sibMedian <= 0) return null;
      const isCrossBar = st.bucketStart === w.crossBucket;
      const ratio = st.bucketVol / w.sibMedian;
      const volOk = ratio >= (isCrossBar ? this.cfg.instant_vol_x : this.cfg.confirm_vol_x);
      const priceOk = isCrossBar
        ? c >= w.crossPrice
        : c >= w.crossPrice * (1 + this.cfg.confirm_price_ext);
      if (volOk && priceOk && c * st.bucketVol >= this.cfg.confirm_min_notional) {
        st.confirmedToday = true;
        st.watch = null;
        return {
          type: 'confirm', ticker, tf: this.cfg.tf, ts_sec: tsSec, price: c,
          cross_price: w.crossPrice, vol_ratio: +ratio.toFixed(1),
          volume: st.bucketVol, sib_median: w.sibMedian,
          bars_since_cross: isCrossBar ? 0 : w.barsSeen + 1, intrabar: true,
        };
      }
      return null;
    }
    if (st.confirmedToday || tsSec < st.lockedUntil) return null;
    if (st.emaF == null || st.emaS == null || st.bars < this.cfg.warmup_bars) return null;
    if (st.prevDiff == null || st.prevDiff > 0) return null;
    const kF = 2 / (this.cfg.fast + 1);
    const kS = 2 / (this.cfg.slow + 1);
    const pDiff = (c * kF + st.emaF * (1 - kF)) - (c * kS + st.emaS * (1 - kS));
    if (pDiff <= 0) return null;
    const sibMedian = median(st.sibVols);
    if (sibMedian < this.cfg.sibling_min_sh) return null;
    const ratio = st.bucketVol / sibMedian;
    if (ratio >= this.cfg.instant_vol_x && c * st.bucketVol >= this.cfg.confirm_min_notional) {
      st.confirmedToday = true;
      return {
        type: 'confirm', ticker, tf: this.cfg.tf, ts_sec: tsSec, price: c,
        cross_price: c, vol_ratio: +ratio.toFixed(1),
        volume: st.bucketVol, sib_median: sibMedian,
        bars_since_cross: 0, intrabar: true,
      };
    }
    st.watch = {
      crossTs: tsSec, crossPrice: c, sibMedian,
      barsSeen: 0, peakRatio: +ratio.toFixed(1), peakPrice: c,
      crossBucket: st.bucketStart,
    };
    return {
      type: 'nominate', ticker, tf: this.cfg.tf, ts_sec: tsSec, price: c,
      cross_price: c, vol_ratio: +ratio.toFixed(1),
      volume: st.bucketVol, sib_median: sibMedian,
      bars_since_cross: 0, intrabar: true,
    };
  }

  private processClosedBar(ticker: string, st: SymState, closeTs: number, c: number, v: number, silent: boolean): EmaCrossEvent | null {
    st.bars++;

    // EMA update — SMA seed over the first `length` closed bars, recursive after.
    if (st.bars <= this.cfg.fast) {
      st.seedSumF += c;
      if (st.bars === this.cfg.fast) st.emaF = st.seedSumF / this.cfg.fast;
    } else if (st.emaF != null) {
      const k = 2 / (this.cfg.fast + 1);
      st.emaF = c * k + st.emaF * (1 - k);
    }
    if (st.bars <= this.cfg.slow) {
      st.seedSumS += c;
      if (st.bars === this.cfg.slow) st.emaS = st.seedSumS / this.cfg.slow;
    } else if (st.emaS != null) {
      const k = 2 / (this.cfg.slow + 1);
      st.emaS = c * k + st.emaS * (1 - k);
    }

    // Sibling median of the bars BEFORE this one — the reference this bar's
    // volume is compared against.
    const sibMedian = median(st.sibVols);

    let out: EmaCrossEvent | null = null;

    // 1) Active observation — does this bar confirm (volume expansion with
    // price holding), or does the window run out? (Skipped on boot-seed
    // replays: history must not nominate, confirm, or expire anything.)
    if (!silent && st.watch && closeTs - this.cfg.interval_sec === st.watch.crossBucket) {
      // An intrabar-detected cross bar just closed — bar 0. Its full volume
      // gets the instant rule (parity with close-path detection); it neither
      // consumes the observation window nor expires it.
      const w = st.watch;
      const ratio = w.sibMedian > 0 ? v / w.sibMedian : 0;
      if (ratio > w.peakRatio) w.peakRatio = ratio;
      if (c > w.peakPrice) w.peakPrice = c;
      if (
        ratio >= this.cfg.instant_vol_x &&
        c >= w.crossPrice &&
        c * v >= this.cfg.confirm_min_notional
      ) {
        st.confirmedToday = true;
        out = {
          type: 'confirm', ticker, tf: this.cfg.tf, ts_sec: closeTs, price: c,
          cross_price: w.crossPrice, vol_ratio: +ratio.toFixed(1),
          volume: v, sib_median: w.sibMedian, bars_since_cross: 0,
        };
        st.watch = null;
      }
    } else if (!silent && st.watch) {
      const w = st.watch;
      w.barsSeen++;
      const ratio = w.sibMedian > 0 ? v / w.sibMedian : 0;
      if (ratio > w.peakRatio) w.peakRatio = ratio;
      if (c > w.peakPrice) w.peakPrice = c;
      if (
        ratio >= this.cfg.confirm_vol_x &&
        c >= w.crossPrice * (1 + this.cfg.confirm_price_ext) &&
        c * v >= this.cfg.confirm_min_notional
      ) {
        st.confirmedToday = true;
        out = {
          type: 'confirm', ticker, tf: this.cfg.tf, ts_sec: closeTs, price: c,
          cross_price: w.crossPrice, vol_ratio: +ratio.toFixed(1),
          volume: v, sib_median: w.sibMedian, bars_since_cross: w.barsSeen,
        };
        st.watch = null;
      } else if (w.barsSeen >= this.cfg.observe_bars) {
        // Expired without expansion — re-arm after the cooldown so a weak
        // cross doesn't lock out a genuine later one (the TGHL lesson).
        st.lockedUntil = closeTs + this.cfg.renominate_cooldown_sec;
        out = {
          type: 'expire', ticker, tf: this.cfg.tf, ts_sec: closeTs, price: c,
          cross_price: w.crossPrice, vol_ratio: +ratio.toFixed(1),
          volume: v, sib_median: w.sibMedian, bars_since_cross: w.barsSeen,
          peak_ratio: +w.peakRatio.toFixed(1), peak_price: w.peakPrice,
        };
        st.watch = null;
      }
    }

    // 2) Cross detection — only with warmed EMAs, a usable sibling baseline,
    // no confirm yet today, and outside the post-expire re-arm cooldown.
    if (
      !silent &&
      out == null &&
      st.emaF != null && st.emaS != null &&
      st.bars > this.cfg.warmup_bars &&
      st.prevDiff != null &&
      !st.watch && !st.confirmedToday && closeTs >= st.lockedUntil
    ) {
      const diff = st.emaF - st.emaS;
      if (st.prevDiff <= 0 && diff > 0 && sibMedian >= this.cfg.sibling_min_sh) {
        const ratio = v / sibMedian;
        if (ratio >= this.cfg.instant_vol_x && c * v >= this.cfg.confirm_min_notional) {
          // The cross bar itself arrived on expanded volume — the operator's
          // "sometimes the current volume is much higher than siblings" case.
          st.confirmedToday = true;
          out = {
            type: 'confirm', ticker, tf: this.cfg.tf, ts_sec: closeTs, price: c,
            cross_price: c, vol_ratio: +ratio.toFixed(1),
            volume: v, sib_median: sibMedian, bars_since_cross: 0,
          };
        } else {
          st.watch = {
            crossTs: closeTs, crossPrice: c, sibMedian,
            barsSeen: 0, peakRatio: +ratio.toFixed(1), peakPrice: c,
            crossBucket: -1, // this cross bar is already closed
          };
          out = {
            type: 'nominate', ticker, tf: this.cfg.tf, ts_sec: closeTs, price: c,
            cross_price: c, vol_ratio: +ratio.toFixed(1),
            volume: v, sib_median: sibMedian, bars_since_cross: 0,
          };
        }
      }
    }

    if (st.emaF != null && st.emaS != null) st.prevDiff = st.emaF - st.emaS;

    // The just-closed bar becomes a sibling for the next ones.
    st.sibVols.push(v);
    if (st.sibVols.length > this.cfg.sibling_bars) st.sibVols.shift();

    return out;
  }
}

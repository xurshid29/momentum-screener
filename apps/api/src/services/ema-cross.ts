// EMA-cross layer (📈, 2026-07-10) — the operator's manual TradingView loop,
// automated: an EMA(fast) over EMA(slow) bullish crossover — 6/50 at launch,
// 10/65 since 2026-07-22, the operator's evolved TV setup — on 5-minute bars
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
  // Junk floor on NOMINATIONS (bucket/bar notional $). Added 2026-07-22, the
  // LBTYK lesson: a single 1-share odd-lot print at $10.99 (vs a $9.97
  // market — $11 of notional) provisionally "crossed" and nominated. The SIP
  // consolidated tape EXCLUDES odd lots, so TV never even saw that trade —
  // this floor is TV-parity, not a departure from it: prints too small for
  // the public tape can't nominate alone. A real burst accumulates this in
  // seconds and fires then. Calibrated same day from 3d of tier_events
  // notional meta: every observed phantom was <$400 while the $500-2k band
  // (24% of nominations) held real thin-tape crosses (BANL $683, ALP $1.6k)
  // — hence $500, not the first-guess $2k.
  nominate_min_notional: number;
  // Splits junk-bar crosses into two fates (the ZBAO vs LBTYK distinction,
  // 2026-07-22): a junk-dollar cross bar whose close moved MORE than this
  // fraction vs the previous close is a phantom print (LBTYK: +10% on $11 —
  // a trade the SIP tape never carried) → discarded. A junk-dollar cross
  // bar at a coherent price (ZBAO: +1% on $162 — a real quiet curl) →
  // PENDING: it converts to a nomination when real dollars arrive while the
  // fast EMA still sits above the slow (ZBAO's volume came 1.5h after the
  // 18:25 cross; the old behavior consumed the cross and stayed silent
  // through a +40% run).
  junk_outlier_pct: number;
  // Stale-EMA guard (the SKYQ case, 2026-07-22): a thin name can go hours
  // without printing on OUR feed while the consolidated tape keeps trading —
  // the committed EMAs freeze, and the first resume tick "crosses" EMAs that
  // are hours old (TV's cross happened long ago). If a symbol's last closed
  // bar is more than this many intervals of IN-SESSION time behind the
  // current tick, intrabar nominations are suppressed until a fresh bucket
  // closes (the closed-bar path still fires — at most one bar late).
  // Session-open resumes are exempt: overnight gaps are symmetric across
  // feeds (TV fires intrabar at the open, and so do we).
  stale_gap_bars: number;
  renominate_cooldown_sec: number;
  intrabar_detect: boolean;
  // Gap-decay (2026-07-23, the CPHI lesson): our EMAs run on the MINI subset
  // tape, where the median known runner paints only ~33 five-minute bars/day
  // (vs ~192 ETH buckets) — so 65 "bars" of slow EMA reach back DAYS while
  // TV's consolidated 65 bars cover hours. CPHI: our EMA65 sat at $1.88
  // (remembering Monday's $2.20 tape) while TV's read $1.74 off the recent
  // flat-line — our cross fired 15 min late at the top of the move. Fix:
  // every in-session bucket with NO trades decays the EMAs toward the last
  // close, exactly as if a flat carry-forward bar had printed — applied
  // lazily in closed form when the next real bar (or tick) arrives, so
  // there are no timers and no synthetic bars in state, warmup counting,
  // sibling volumes, or persistence. Out-of-session time (nights/weekends)
  // decays nothing — TV holds EMAs across the close too. If the decayed
  // fast EMA overtakes the slow one DURING a gap (price sat above both
  // through the quiet — the operator's quiet-curl thesis), the cross parks
  // as PENDING at the carry price and converts when dollars arrive (the
  // ZBAO mechanism, reused verbatim).
  gap_decay: boolean;
  // Bucket anchor offset in seconds. 5m buckets divide the hour so 0 always
  // works; 4h buckets must align to the ET session grid (04:00/08:00/12:00/
  // 16:00 ET — how TV draws 4h ETH bars), which is offset 0 under EDT but
  // 3600 under EST. The tick feed recomputes it at the midnight roll.
  bucket_offset_sec: number;
}

export const EMA_CROSS: EmaCrossConfig = {
  tf: '5m',
  interval_sec: 300,   // 5-minute bars (the operator trades this TF on TV)
  fast: 10,
  slow: 65,
  warmup_bars: 65,     // no crosses until the slow EMA has real shape
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
  nominate_min_notional: 500,
  junk_outlier_pct: 0.05,
  stale_gap_bars: 3,
  // Re-arm cooldown after an EXPIRED observation. Nominations were originally
  // once/ticker/day, but TGHL 2026-07-15 showed why that's wrong: a weak
  // 0.4× morning cross burned the slot and expired, and the REAL 16:25 cross
  // (6.7×, ran +20%) would have been locked out — it only fired because a
  // deploy happened to reset the tracker. A CONFIRMED cross still ends the
  // symbol's day (it's already surfaced); an expired one re-arms after this.
  // 60→30 min 2026-07-22: tier_events showed late rallies re-cross a median
  // ~4.5h after the first (dud) cross — the re-arm path carries 27% of all
  // 5m confirms — and a 60-min lock suppressed re-crosses in the 30-59 min
  // band. Operator chose the tighter lock over a longer observation window.
  renominate_cooldown_sec: 1800,
  // TV-parity live evaluation (see header). Kill switch only — flip to false
  // if the fast path misbehaves live; detection reverts to bar-close-only.
  intrabar_detect: true,
  gap_decay: true,
  bucket_offset_sec: 0,
};

// The 1h layer (2026-07-21): the middle timeframe, added when the operator
// asked for configurable intervals. Same machinery; 1h buckets align to
// hour boundaries in every timezone, so the anchor offset is always 0.
export const EMA_CROSS_1H: EmaCrossConfig = {
  tf: '1h',
  interval_sec: 3_600,
  fast: 10,
  slow: 65,
  warmup_bars: 65,          // ~4-10 trading days of ETH bars
  sibling_bars: 12,         // ~a trading day of volume context
  sibling_min_sh: 50,
  observe_bars: 6,          // ~6h observation
  confirm_vol_x: 3,
  confirm_price_ext: 0.005,
  instant_vol_x: 5,
  confirm_min_notional: 10_000,
  nominate_min_notional: 500,
  junk_outlier_pct: 0.05,
  stale_gap_bars: 3,
  renominate_cooldown_sec: 7_200, // two bars
  intrabar_detect: true,
  gap_decay: true,
  bucket_offset_sec: 0,
};

// The 4h layer (2026-07-17): the operator's swing-timing loop — the same
// cross on 4-hour ETH bars, detected intrabar the second it happens. They keep
// the entry filter and the exit; this is a pure detection tool (dashboard
// only, no Telegram until tier_events shows the real fire rate). Confirm
// machinery runs identically for grading, but the NOMINATION is the product.
export const EMA_CROSS_4H: EmaCrossConfig = {
  tf: '4h',
  interval_sec: 14_400,
  fast: 10,
  slow: 65,
  warmup_bars: 65,          // ~3-4 weeks of tape — needs the bars_4h backfill
  sibling_bars: 12,         // ~2 trading days of volume context
  sibling_min_sh: 50,
  observe_bars: 6,          // ~24h observation
  confirm_vol_x: 3,
  confirm_price_ext: 0.005,
  instant_vol_x: 5,
  confirm_min_notional: 10_000,
  nominate_min_notional: 500,
  junk_outlier_pct: 0.05,
  stale_gap_bars: 3,
  renominate_cooldown_sec: 14_400, // one bar — a dud re-arms next bar
  intrabar_detect: true,
  gap_decay: true,
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
  cross_ts_sec?: number; // pending conversions: the ORIGINAL cross bar's close
                         // time — display anchors "cross X ago" here, honestly
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
  lastCloseTs: number;   // close time of the newest committed bar (0 = none)
  lastClose: number;     // close of the newest committed bar (0 = none)
  // Pending cross (the ZBAO mechanism, 2026-07-22): a price-coherent cross
  // on a junk-dollar bar isn't consumed — it parks here and converts to a
  // nomination when real dollars arrive while the fast EMA is still above
  // the slow. Cleared when the cross dies (diff ≤ 0) or at the day roll.
  pending: { crossTs: number; crossPrice: number } | null;
  prevDiff: number | null; // emaF - emaS at the previous closed bar
  decayedTo: number;     // bucket boundary the gap-decay has advanced to
                         // (0 = none) — buckets before it are accounted for,
                         // as real bars or as flat carry-forward decay steps
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

  // Epoch seconds of the most recent 04:00 ET session open — the anchor for
  // the stale-EMA guard (in-session gap only; overnight gaps are exempt).
  // Pushed by the tick feed on its sync cadence; 0 disables the guard.
  private sessionOpenTs = 0;
  setSessionOpen(tsSec: number): void {
    this.sessionOpenTs = tsSec;
  }

  // ET-vs-UTC offset in hours (4 under EDT, 5 under EST) — the gap-decay's
  // session clock. Pushed by the tick feed on its sync cadence; the fixed
  // default keeps tests deterministic.
  private etOffsetHours = 4;
  setEtOffset(hours: number): void {
    this.etOffsetHours = hours;
  }

  // True when this bucket sits inside the ETH session (04:00–20:00 ET,
  // Mon–Fri) — the only time an empty bucket means "the consolidated tape
  // was trading without us" and should decay the EMAs. Holidays count as
  // sessions (a small extra decay toward a flat price — accepted).
  private inSession(bucketStartSec: number): boolean {
    const etSec = bucketStartSec - this.etOffsetHours * 3600;
    const secOfDay = ((etSec % 86_400) + 86_400) % 86_400;
    if (secOfDay < 4 * 3600 || secOfDay >= 20 * 3600) return false;
    const day = (Math.floor(etSec / 86_400) + 4) % 7; // epoch day 0 = Thursday
    return day !== 6 && day !== 0; // Sat / Sun
  }

  // Advance the EMA state across empty buckets up to (not including)
  // targetBucketStart, folding the last close once per missed IN-SESSION
  // bucket — see EmaCrossConfig.gap_decay. Recomputes prevDiff so cross
  // detection compares against the decayed baseline; a sign flip DURING the
  // gap parks a pending quiet-curl cross (live only — boot-seed replays
  // rebuild EMAs but never observations, same as the rest of the seed path).
  private applyGapDecay(ticker: string, st: SymState, targetBucketStart: number, silent: boolean): void {
    if (!this.cfg.gap_decay) return;
    if (targetBucketStart <= st.decayedTo) return;
    if (st.lastCloseTs === 0 || st.emaF == null || st.emaS == null) {
      st.decayedTo = targetBucketStart;
      return;
    }
    const iv = this.cfg.interval_sec;
    const from = Math.max(st.decayedTo, st.lastCloseTs);
    const P = st.lastClose;
    const kF = 2 / (this.cfg.fast + 1);
    const kS = 2 / (this.cfg.slow + 1);
    let flippedAt = 0;
    for (let b = from; b < targetBucketStart; b += iv) {
      if (!this.inSession(b)) continue;
      const before = st.emaF - st.emaS;
      st.emaF = P * kF + st.emaF * (1 - kF);
      st.emaS = P * kS + st.emaS * (1 - kS);
      if (flippedAt === 0 && before <= 0 && st.emaF - st.emaS > 0) flippedAt = b + iv;
    }
    st.decayedTo = targetBucketStart;
    if (st.prevDiff != null) st.prevDiff = st.emaF - st.emaS;
    if (
      !silent && flippedAt > 0 && st.bars > this.cfg.warmup_bars &&
      !st.watch && !st.pending && !st.confirmedToday && flippedAt >= st.lockedUntil
    ) {
      st.pending = { crossTs: flippedAt, crossPrice: P };
      console.log(`[ema-cross] cross during quiet gap — pending at carry $${P} ${ticker} (${this.cfg.tf})`);
    }
  }

  // Read-only debug view of a symbol's live EMA state — powers the
  // /ema-debug endpoint so the operator can compare our EMAs against the
  // same symbol's TV chart whenever a detection looks off (the WOK class).
  snapshot(ticker: string): {
    tf: string; bars: number; ema_fast: number | null; ema_slow: number | null;
    prev_diff: number | null; sib_median: number; observing: boolean;
    pending: boolean;
    confirmed_today: boolean; locked_until: number; open_bucket_ts: number | null;
    open_bucket_close: number | null; open_bucket_vol: number | null;
  } | null {
    const st = this.state.get(ticker);
    if (!st) return null;
    return {
      tf: this.cfg.tf,
      bars: st.bars,
      ema_fast: st.emaF,
      ema_slow: st.emaS,
      prev_diff: st.prevDiff,
      sib_median: median(st.sibVols),
      observing: st.watch != null,
      pending: st.pending != null,
      confirmed_today: st.confirmedToday,
      locked_until: st.lockedUntil,
      open_bucket_ts: st.bucketStart === -1 ? null : st.bucketStart,
      open_bucket_close: st.bucketStart === -1 ? null : st.bucketClose,
      open_bucket_vol: st.bucketStart === -1 ? null : st.bucketVol,
    };
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

  // Replace a WARM symbol's EMA state with a replay of denser history — the
  // consolidated re-seed for MINI-sparse names (2026-07-23, the CPHI lesson:
  // its 329 banked bars were "warm", so the below-warmup backfill never
  // touched it, yet its slow EMA still remembered a multi-day horizon).
  // Refuses while an observation or pending cross is in flight (never
  // disturb live detection state). Day flags survive; the sibling-volume
  // ring keeps the FEED-SCALE volumes it had — consolidated volumes would
  // read every live ratio low for the next sibling window (the documented
  // Yahoo skew) — and live ticks at/before the reseeded history are dropped
  // by the seededUpTo guard, exactly like a boot seed.
  reseedFromHistory(ticker: string, bars: SeedHistoryBar[]): boolean {
    if (bars.length === 0) return false;
    const cur = this.state.get(ticker);
    if (cur && (cur.watch || cur.pending)) return false;
    const keep = cur
      ? { confirmedToday: cur.confirmedToday, lockedUntil: cur.lockedUntil, sibVols: cur.sibVols }
      : null;
    this.state.delete(ticker);
    const st = this.ensure(ticker);
    for (const b of bars) {
      this.processClosedBar(ticker, st, b.closeTs, b.close, b.volume, true);
      st.seededUpTo = b.closeTs - this.cfg.interval_sec;
    }
    if (keep) {
      st.confirmedToday = keep.confirmedToday;
      st.lockedUntil = keep.lockedUntil;
      if (keep.sibVols.length > 0) st.sibVols = keep.sibVols;
    }
    return true;
  }

  // ET-day roll: nominations re-arm, in-flight observations drop (they can't
  // span the closed session anyway — no bars 20:00→04:00). EMAs and bar
  // history deliberately survive: price structure isn't day-anchored.
  resetDaily(): void {
    for (const st of this.state.values()) {
      st.confirmedToday = false;
      st.lockedUntil = 0;
      st.watch = null;
      st.pending = null;
    }
  }

  private ensure(ticker: string): SymState {
    let st = this.state.get(ticker);
    if (!st) {
      st = {
        bucketStart: -1, bucketClose: 0, bucketVol: 0,
        emaF: null, emaS: null, seedSumF: 0, seedSumS: 0,
        bars: 0, lastCloseTs: 0, lastClose: 0, pending: null,
        prevDiff: null, decayedTo: 0, sibVols: [], watch: null, confirmedToday: false, lockedUntil: 0,
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
      // Decay across any silence since the newest committed (or seeded) bar
      // before the live tape resumes — the provisional EMAs the intrabar
      // check folds against must reflect the quiet gap.
      this.applyGapDecay(ticker, st, bucket, false);
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
    // the new one (decaying any empty buckets between the two).
    const closeTs = st.bucketStart + iv;
    const ev = this.processClosedBar(ticker, st, closeTs, st.bucketClose, st.bucketVol, false);
    this.onBarClosed?.(ticker, closeTs, st.bucketClose, st.bucketVol);
    this.applyGapDecay(ticker, st, bucket, false);
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
    const kF = 2 / (this.cfg.fast + 1);
    const kS = 2 / (this.cfg.slow + 1);
    const pDiff = (c * kF + st.emaF * (1 - kF)) - (c * kS + st.emaS * (1 - kS));
    // Pending-cross conversion, TV-parity live (2026-07-23): dollars
    // accumulating in the OPEN bucket convert a parked quiet-curl cross the
    // second they arrive — the same monotone-volume soundness as intrabar
    // confirms. Gated on the PROVISIONAL diff so a crashing tick can't
    // convert a cross its own close is about to kill (pending death itself
    // stays with the closed-bar path).
    if (st.pending) {
      if (pDiff <= 0) return null;
      const notional = c * st.bucketVol;
      if (notional < this.cfg.nominate_min_notional) return null;
      const p = st.pending;
      st.pending = null;
      const sibMedian = median(st.sibVols);
      const ratio = sibMedian > 0 ? st.bucketVol / sibMedian : 0;
      const barsSince = Math.max(1, Math.round((tsSec - p.crossTs) / this.cfg.interval_sec));
      console.log(`[ema-cross] pending cross converted after ${Math.round((tsSec - p.crossTs) / 60)}m ${ticker} (${this.cfg.tf}, intrabar)`);
      if (ratio >= this.cfg.instant_vol_x && c >= p.crossPrice && notional >= this.cfg.confirm_min_notional) {
        st.confirmedToday = true;
        return {
          type: 'confirm', ticker, tf: this.cfg.tf, ts_sec: tsSec, price: c,
          cross_price: p.crossPrice, vol_ratio: +ratio.toFixed(1),
          volume: st.bucketVol, sib_median: sibMedian, bars_since_cross: barsSince,
          intrabar: true, cross_ts_sec: p.crossTs,
        };
      }
      st.watch = {
        crossTs: p.crossTs, crossPrice: p.crossPrice, sibMedian,
        barsSeen: 0, peakRatio: +ratio.toFixed(1), peakPrice: c,
        crossBucket: -1, // the cross bar closed (or decayed) long ago
      };
      return {
        type: 'nominate', ticker, tf: this.cfg.tf, ts_sec: tsSec, price: c,
        cross_price: p.crossPrice, vol_ratio: +ratio.toFixed(1),
        volume: st.bucketVol, sib_median: sibMedian, bars_since_cross: barsSince,
        intrabar: true, cross_ts_sec: p.crossTs,
      };
    }
    if (st.prevDiff == null || st.prevDiff > 0) return null;
    if (pDiff <= 0) return null;
    // Junk-print guard (the LBTYK phantom): the bucket's accumulated dollars
    // must be real before a provisional cross may nominate. No state is
    // consumed on rejection — a later tick in the same bucket re-evaluates
    // as volume accumulates, so a genuine burst fires seconds later.
    if (c * st.bucketVol < this.cfg.nominate_min_notional) return null;
    // Stale-EMA guard (the SKYQ case — see EmaCrossConfig.stale_gap_bars):
    // after a long IN-SESSION gap on our feed, the committed EMAs are hours
    // old; the resume tick must not nominate against them. The bucket closes
    // first (committing fresh prices), then the closed-bar path decides.
    if (this.sessionOpenTs > 0 && st.lastCloseTs > 0) {
      const anchor = Math.max(st.lastCloseTs, this.sessionOpenTs);
      if (tsSec - anchor > this.cfg.stale_gap_bars * this.cfg.interval_sec) return null;
    }
    const sibMedian = median(st.sibVols);
    if (sibMedian < this.cfg.sibling_min_sh) {
      // Dead sibling window at a live cross (the CPHI class, 2026-07-23):
      // on a MINI-sparse name the "prior hour" of siblings spans DAYS of
      // junk prints, so a real cross used to be consumed silently by this
      // floor. With real bucket dollars (checked above) and a coherent
      // price, park it as PENDING — the conversion path above then fires
      // the moment dollar evidence accumulates. Incoherent pokes still
      // wait for the closed bar to decide.
      const coherent = st.lastClose > 0 && Math.abs(c / st.lastClose - 1) <= this.cfg.junk_outlier_pct;
      if (coherent) {
        st.pending = { crossTs: tsSec, crossPrice: c };
        console.log(`[ema-cross] cross pending — thin sibling window (${sibMedian} sh) ${ticker} (${this.cfg.tf})`);
      }
      return null;
    }
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
    // Decay across empty buckets between the previous bar and this one; the
    // real bar then supersedes the decay for its own bucket. Runs for seed
    // replays too — live and reseeded state stay bit-identical.
    this.applyGapDecay(ticker, st, closeTs - this.cfg.interval_sec, silent);
    st.decayedTo = closeTs;
    st.bars++;
    st.lastCloseTs = closeTs;
    const prevClose = st.lastClose; // previous bar's close — the outlier reference
    st.lastClose = c;

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

    // 1.5) Pending-cross management (the ZBAO mechanism). A price-coherent
    // cross that happened on a junk-dollar bar sits here until real dollars
    // arrive WHILE the fast EMA still rides above the slow — then it
    // converts to a nomination anchored at the ORIGINAL cross. Dies silently
    // if the cross geometry dies first.
    if (!silent && st.pending && st.emaF != null && st.emaS != null) {
      if (st.emaF - st.emaS <= 0) {
        st.pending = null; // the cross died before dollars ever arrived
      } else if (
        out == null && !st.watch && !st.confirmedToday &&
        c * v >= this.cfg.nominate_min_notional
      ) {
        const p = st.pending;
        st.pending = null;
        const ratio = sibMedian > 0 ? v / sibMedian : 0;
        const barsSince = Math.max(1, Math.round((closeTs - p.crossTs) / this.cfg.interval_sec));
        console.log(`[ema-cross] pending cross converted after ${Math.round((closeTs - p.crossTs) / 60)}m ${ticker} (${this.cfg.tf})`);
        if (
          ratio >= this.cfg.instant_vol_x &&
          c >= p.crossPrice &&
          c * v >= this.cfg.confirm_min_notional
        ) {
          // Dollars arrived violently — confirm outright (ZBAO's 20:25 class).
          st.confirmedToday = true;
          out = {
            type: 'confirm', ticker, tf: this.cfg.tf, ts_sec: closeTs, price: c,
            cross_price: p.crossPrice, vol_ratio: +ratio.toFixed(1),
            volume: v, sib_median: sibMedian, bars_since_cross: barsSince,
            cross_ts_sec: p.crossTs,
          };
        } else {
          st.watch = {
            crossTs: p.crossTs, crossPrice: p.crossPrice, sibMedian,
            barsSeen: 0, peakRatio: +ratio.toFixed(1), peakPrice: c,
            crossBucket: -1, // the cross bar closed long ago
          };
          out = {
            type: 'nominate', ticker, tf: this.cfg.tf, ts_sec: closeTs, price: c,
            cross_price: p.crossPrice, vol_ratio: +ratio.toFixed(1),
            volume: v, sib_median: sibMedian, bars_since_cross: barsSince,
            cross_ts_sec: p.crossTs,
          };
        }
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
      if (st.prevDiff <= 0 && diff > 0 && c * v < this.cfg.nominate_min_notional) {
        // Junk-dollar cross bar. Two fates (the ZBAO vs LBTYK distinction):
        // an OUTLIER price on junk dollars is a phantom print the SIP tape
        // never carried → discarded outright; a COHERENT price on junk
        // dollars is a real quiet curl → parked as pending (block 1.5).
        // Since 2026-07-23 this no longer requires a healthy sibling window
        // — a junk cross over a dead window pends/discards the same way
        // (it used to be consumed silently).
        const outlier = prevClose > 0 && Math.abs(c / prevClose - 1) > this.cfg.junk_outlier_pct;
        if (outlier) {
          console.log(`[ema-cross] cross discarded — outlier junk print $${Math.round(c * v)} ${ticker} (${this.cfg.tf})`);
        } else {
          st.pending = { crossTs: closeTs, crossPrice: c };
          console.log(`[ema-cross] cross pending — junk bar $${Math.round(c * v)} ${ticker} (${this.cfg.tf}) awaiting dollars`);
        }
      }
      if (st.prevDiff <= 0 && diff > 0 && sibMedian < this.cfg.sibling_min_sh
        && c * v >= this.cfg.nominate_min_notional) {
        // Real dollars over a dead sibling window (the CPHI class,
        // 2026-07-23): the cross is genuine but its volume baseline is
        // meaningless — on a MINI-sparse name the sibling ring spans days
        // of junk prints. Used to be consumed silently by the floor; now
        // it PENDS and converts (intrabar or on close) as dollars accrue.
        st.pending = { crossTs: closeTs, crossPrice: c };
        console.log(`[ema-cross] cross pending — thin sibling window (${sibMedian} sh) ${ticker} (${this.cfg.tf})`);
      }
      if (st.prevDiff <= 0 && diff > 0 && sibMedian >= this.cfg.sibling_min_sh
        && c * v >= this.cfg.nominate_min_notional
      ) {
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

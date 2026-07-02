// Tick-feed ignition detector — the "first detector" that runs ahead of the
// Finviz screener on a live per-second trade feed (Databento EQUS.MINI
// ohlcv-1s). Pure + stateful-per-symbol: feed it bars in time order and it
// emits events as a name moves through the ignition state machine:
//
//   idle ──watch──▶ watching ──confirm──▶ confirmed
//                       │
//                     fade──▶ faded ──confirm (surge rule only)──▶ confirmed
//
// WHY TWO TIERS (2026-07-02, from a week of prod near-miss diagnostics): the
// original single-shot rule was volume-CONFIRMED — relvol ≥5× a pre-move quiet
// baseline. On nano-caps volume confirmation is structurally late: price moves
// on a handful of prints and the 60s share volume catches up minutes later
// (DSY near-missed at +23% on 1.8×, finally fired at +56.7%), and names first
// seen already moving have NO quiet baseline so they could never fire at all
// (LHAI +238%, EHGO +120% — "no-baseline (0 quiet)"). The WATCH tier flags on
// PRICE (instant, baseline-free) with only a tiny absolute junk floor; the
// CONFIRM tier then promotes on either the original surge rule or a
// baseline-free "sustained participation" read. Alerts stay tiered: watch is
// a heads-up, confirm is the conviction ping.
//
// The surge rule is unchanged and validated offline (2026-06-17,
// docs/tick-feed-* notes): a RELATIVE-volume surge — not absolute $ —
// separates real ignitions from fading blips. On the validation set the real
// catches surged 9.8–100× their own quiet baseline while blips ran 0.3–0.7×;
// a ≥5× gate caught the real ones 35–50s before Finviz at far lower chg%
// (e.g. GLXG +15% vs +56%) with a 5% false-fire rate on fizzlers. Absolute
// dollar-volume was the WRONG primary gate — thin nano-caps don't trade real
// money until they've already popped. As a junk FLOOR for the watch tier,
// though, a tiny absolute check is fine: it only has to reject the
// one-odd-lot "+15% on 5 shares" prints, not rank anything.

export const TICK_DETECT = {
  window_sec: 60,          // momentum / volume measurement window
  relvol_min: 5,           // trailing-60s shares / baseline — the key surge gate
  cum_min: 12,             // % from prior close — actually igniting, not a wiggle
  mom_min: 8,              // % rise over the trailing 60s — the move is NOW
  near_high: 0.70,         // close in top 30% of the window range (not reverting)
  baseline_min_sh: 10,     // ignore names too thin for a baseline (gappers) —
                           // this min-SHARES floor is the real robustness guard
  baseline_min_samples: 1, // these nano-caps are so thin the baseline is often
                           // a single pre-surge print (DSY: one 17-share trade
                           // before it ripped); the min-shares floor, not a
                           // sample count, is what keeps it sane
  baseline_keep: 40,       // rolling count of quiet 60s-volume samples
  history_sec: 130,        // per-symbol bar retention (> window for trimming)

  // WATCH tier — price-led early flag, no baseline required.
  watch_cum_min: 10,       // % from prior close to flag a watch
  watch_cum_max: 100,      // first seen above this = the start is already missed
  watch_window_sec: 120,   // junk-floor measurement window
  watch_floor_prints: 5,   // ≥N traded seconds in the window — not one odd lot
  watch_floor_notional: 2000, // ≥$ traded in the window. NOTE: EQUS.MINI sees a
                           // fraction of consolidated tape, so $ knobs here are
                           // feed-visible dollars — recalibrate from the
                           // watch/confirm transition logs, not real-tape $.

  // CONFIRM tier (baseline-free "sustain" path — the surge rule is the other).
  confirm_hold_sec: 120,   // min watch age before a sustain-confirm
  confirm_ext_pts: 3,      // chg% must extend ≥ this beyond the watch flag
  confirm_notional_min: 25000, // $ traded since the flag (feed-visible)
  // Express lane — a vertical move that extends far beyond the flag on real
  // notional IS sustained participation; don't sit out the full hold while
  // the name doubles (CETX 2026-07-02: flagged +39%, +106% ninety seconds
  // later, still "pending").
  confirm_fast_hold_sec: 30,
  confirm_fast_ext_pts: 20,

  // FADE — watch expired or the move gave itself back.
  fade_giveback: 0.6,      // fraction of the watch-flag move given back
  fade_ttl_sec: 900,       // unconfirmed watch expires after 15 min
} as const;

export interface TickBar {
  ts_sec: number;   // epoch seconds of the 1-second bar
  close: number;
  high: number;
  low: number;
  volume: number;
}

export type TickEventType = 'watch' | 'confirm' | 'fade';

export interface TickEvent {
  type: TickEventType;
  ticker: string;
  ts_sec: number;
  price: number;
  change_pct: number;   // vs prior close, at this event
  rel_vol: number;      // trailing-60s shares / baseline (0 when no baseline)
  mom_pct: number;      // % rise over the trailing 60s
  // confirm/fade context — where the watch flag was planted.
  watch_change_pct?: number;
  // confirm provenance: 'surge' = the validated relvol rule; 'sustain' = the
  // baseline-free participation read (gapped names).
  via?: 'surge' | 'sustain';
  // feed-visible $ traded since the watch flag — calibration telemetry.
  notional?: number;
  // watch events: true when we OBSERVED the cross — the symbol traded below
  // watch_cum_min in our own bar history before crossing it. False = first
  // sight was already above the line (gapper, mid-move subscribe, or a
  // restart re-seeing an old move). Lets the poller tell a live development
  // from stale state (the AUID case, 2026-07-02).
  fresh_cross?: boolean;
}

type Phase = 'idle' | 'watching' | 'confirmed' | 'faded';

interface WatchAnchor {
  ts_sec: number;
  price: number;
  change_pct: number;
  notionalSince: number;
}

interface SymbolState {
  bars: TickBar[];          // trailing window (trimmed to history_sec)
  quietVols: number[];      // rolling trailing-60s share-vols sampled while quiet
  phase: Phase;
  watch: WatchAnchor | null;
  seenBelowWatch: boolean;  // ever traded below watch_cum_min in our history
  diagnosed: boolean;       // logged a near-miss reason once (see drainDiagnostics)
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export class TickDetector {
  private state = new Map<string, SymbolState>();
  // prior close per symbol (vs which change% is measured). Seeded daily from
  // the universe / daily_bars; a symbol with no prior close can't be scored.
  private priorClose = new Map<string, number>();
  // Near-miss diagnostics — when a tracked name reaches cum_min% but does NOT
  // surge-fire, we record once WHY (gapped = no baseline, vs which gate it
  // failed). Drained + logged by the service so the live rollout is debuggable.
  private diag: string[] = [];

  drainDiagnostics(): string[] {
    const out = this.diag;
    this.diag = [];
    return out;
  }

  setPriorClose(ticker: string, close: number): void {
    if (close > 0) this.priorClose.set(ticker, close);
  }

  hasPriorClose(ticker: string): boolean {
    return this.priorClose.has(ticker);
  }

  // Clear per-session state (midnight ET, mirroring the poller). Prior closes
  // are refreshed separately by the daily universe seed.
  reset(): void {
    this.state.clear();
  }

  symbolsTracked(): number {
    return this.state.size;
  }

  // Feed one per-second bar in time order. Returns a state-machine event on
  // the bar that trips a transition, else null. Causal — the quiet baseline is
  // built only from PAST quiet windows, so it reflects the pre-move level.
  addBar(ticker: string, bar: TickBar): TickEvent | null {
    const prior = this.priorClose.get(ticker);
    if (prior === undefined) return null;

    let st = this.state.get(ticker);
    if (!st) {
      st = { bars: [], quietVols: [], phase: 'idle', watch: null, seenBelowWatch: false, diagnosed: false };
      this.state.set(ticker, st);
    }
    st.bars.push(bar);
    const cutoff = bar.ts_sec - TICK_DETECT.history_sec;
    while (st.bars.length > 0 && st.bars[0].ts_sec < cutoff) st.bars.shift();

    // Trailing window aggregates — the 60s surge window and the 120s
    // junk-floor window in one backward pass.
    const winStart = bar.ts_sec - TICK_DETECT.window_sec;
    const watchStart = bar.ts_sec - TICK_DETECT.watch_window_sec;
    let basePrice = bar.close, whi = bar.high, wlo = bar.low, winVol = 0;
    let oldestInWin = bar.close;
    let prints = 0, notional = 0;
    for (let i = st.bars.length - 1; i >= 0; i--) {
      const b = st.bars[i];
      if (b.ts_sec < watchStart) break;
      if (b.volume > 0) {
        prints++;
        notional += b.close * b.volume;
      }
      if (b.ts_sec < winStart) continue;
      whi = Math.max(whi, b.high);
      wlo = Math.min(wlo, b.low);
      winVol += b.volume;
      oldestInWin = b.close;
    }
    basePrice = oldestInWin;

    const cum = (bar.close / prior - 1) * 100;
    const mom = basePrice > 0 ? (bar.close / basePrice - 1) * 100 : 0;
    const pos = whi > wlo ? (bar.close - wlo) / (whi - wlo) : 1;

    if (cum < TICK_DETECT.watch_cum_min) st.seenBelowWatch = true;

    // While the name is still quiet, record its trailing-60s volume as a
    // baseline sample (rolling). Once it's moving (cum >= mom_min) we stop, so
    // the baseline stays anchored to the pre-move level.
    if (cum < TICK_DETECT.mom_min) {
      st.quietVols.push(winVol);
      if (st.quietVols.length > TICK_DETECT.baseline_keep) st.quietVols.shift();
    }
    const baseline = st.quietVols.length >= TICK_DETECT.baseline_min_samples
      ? median(st.quietVols)
      : 0;

    if (st.watch) st.watch.notionalSince += bar.close * bar.volume;

    if (st.phase === 'confirmed') return null;
    const relVol = baseline > 0 ? winVol / baseline : 0;

    const ev = (type: TickEventType, via?: 'surge' | 'sustain'): TickEvent => ({
      type,
      ticker,
      ts_sec: bar.ts_sec,
      price: bar.close,
      change_pct: +cum.toFixed(2),
      rel_vol: +relVol.toFixed(1),
      mom_pct: +mom.toFixed(1),
      ...(st!.watch ? {
        watch_change_pct: st!.watch.change_pct,
        notional: Math.round(st!.watch.notionalSince),
      } : {}),
      ...(via ? { via } : {}),
    });

    // 1) The validated surge rule — unchanged gates, fires from ANY unconfirmed
    // phase (idle → straight confirm; watching → promote; faded → resurrect).
    // Keeping this first guarantees the two-tier machine is a strict superset
    // of the old single-shot detector.
    if (
      baseline >= TICK_DETECT.baseline_min_sh &&
      cum >= TICK_DETECT.cum_min &&
      mom >= TICK_DETECT.mom_min &&
      relVol >= TICK_DETECT.relvol_min &&
      pos >= TICK_DETECT.near_high
    ) {
      st.phase = 'confirmed';
      return ev('confirm', 'surge');
    }

    // 2) WATCH — price-led flag, idle only (a faded name doesn't re-watch; the
    // surge rule above remains its only way back). No baseline required: this
    // is exactly the tier that exists for gapped / first-seen-moving names.
    if (
      st.phase === 'idle' &&
      cum >= TICK_DETECT.watch_cum_min &&
      cum <= TICK_DETECT.watch_cum_max &&
      pos >= TICK_DETECT.near_high &&
      prints >= TICK_DETECT.watch_floor_prints &&
      notional >= TICK_DETECT.watch_floor_notional
    ) {
      st.phase = 'watching';
      st.watch = { ts_sec: bar.ts_sec, price: bar.close, change_pct: +cum.toFixed(2), notionalSince: 0 };
      return { ...ev('watch'), fresh_cross: st.seenBelowWatch };
    }

    // 3) Sustain-confirm / fade — only while watching.
    if (st.phase === 'watching' && st.watch) {
      const age = bar.ts_sec - st.watch.ts_sec;
      const ext = cum - st.watch.change_pct;
      const heldLongEnough =
        age >= TICK_DETECT.confirm_hold_sec ||
        (age >= TICK_DETECT.confirm_fast_hold_sec && ext >= TICK_DETECT.confirm_fast_ext_pts);
      if (
        heldLongEnough &&
        ext >= TICK_DETECT.confirm_ext_pts &&
        bar.close >= st.watch.price &&
        st.watch.notionalSince >= TICK_DETECT.confirm_notional_min &&
        pos >= TICK_DETECT.near_high
      ) {
        st.phase = 'confirmed';
        return ev('confirm', 'sustain');
      }
      const giveback = st.watch.change_pct > 0
        ? (st.watch.change_pct - cum) / st.watch.change_pct
        : 0;
      if (age > TICK_DETECT.fade_ttl_sec || giveback >= TICK_DETECT.fade_giveback) {
        st.phase = 'faded';
        const out = ev('fade');
        st.watch = null;
        return out;
      }
    }

    // Near-miss diagnostic — a tracked name reached an igniting chg% but the
    // surge rule didn't fire. Record the binding reason ONCE so we can tell
    // gappers (no baseline) from gate failures, without log spam.
    if (cum >= TICK_DETECT.cum_min && !st.diagnosed) {
      st.diagnosed = true;
      const reason =
        baseline < TICK_DETECT.baseline_min_sh ? `no-baseline (gapped, base=${Math.round(baseline)}sh, ${st.quietVols.length} quiet)`
        : relVol < TICK_DETECT.relvol_min ? `low-relvol (${relVol.toFixed(1)}x < ${TICK_DETECT.relvol_min})`
        : mom < TICK_DETECT.mom_min ? `low-mom (+${mom.toFixed(0)}%/60s < ${TICK_DETECT.mom_min})`
        : `reverting (pos ${pos.toFixed(2)} < ${TICK_DETECT.near_high})`;
      this.diag.push(`${ticker} +${cum.toFixed(0)}% — ${reason} [${st.phase}]`);
    }
    return null;
  }
}

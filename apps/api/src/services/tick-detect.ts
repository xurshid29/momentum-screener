// Tick-feed ignition detector — the "first detector" that runs ahead of the
// Finviz screener on a live per-second trade feed (Databento EQUS.MINI
// ohlcv-1s). Pure + stateful-per-symbol: feed it bars in time order and it
// emits a candidate the moment a name shows a genuine ignition START.
//
// The rule was validated offline (2026-06-17, docs/tick-feed-* notes): a
// RELATIVE-volume surge — not absolute $ — separates real ignitions from
// fading blips. On the validation set the real catches surged 9.8–100× their
// own quiet baseline while blips ran 0.3–0.7×; a ≥5× gate caught the real
// ones 35–50s before Finviz at far lower chg% (e.g. GLXG +15% vs +56%) with a
// 5% false-fire rate on fizzlers. Absolute dollar-volume was the WRONG gate —
// thin nano-caps don't trade real money until they've already popped, so a $
// gate fires later than Finviz. Hence: relative volume vs the symbol's own
// pre-move baseline.

export const TICK_DETECT = {
  window_sec: 60,          // momentum / volume measurement window
  relvol_min: 5,           // trailing-60s shares / baseline — the key gate
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
} as const;

export interface TickBar {
  ts_sec: number;   // epoch seconds of the 1-second bar
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface TickCandidate {
  ticker: string;
  ts_sec: number;
  price: number;
  change_pct: number;   // vs prior close
  rel_vol: number;      // trailing-60s shares / baseline
  mom_pct: number;      // % rise over the trailing 60s
}

interface SymbolState {
  bars: TickBar[];          // trailing window (trimmed to history_sec)
  quietVols: number[];      // rolling trailing-60s share-vols sampled while quiet
  fired: boolean;           // once per symbol per session
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
  // fire, we record once WHY (gapped = no baseline, vs which gate it failed).
  // Drained + logged by the service so the live rollout is debuggable.
  private diag: string[] = [];

  drainDiagnostics(): string[] {
    const out = this.diag;
    this.diag = [];
    return out;
  }

  setPriorClose(ticker: string, close: number): void {
    if (close > 0) this.priorClose.set(ticker, close);
  }

  // Clear per-session state (midnight ET, mirroring the poller). Prior closes
  // are refreshed separately by the daily universe seed.
  reset(): void {
    this.state.clear();
  }

  symbolsTracked(): number {
    return this.state.size;
  }

  // Feed one per-second bar in time order. Returns a candidate on the cycle a
  // name first trips the ignition rule, else null. Causal — baseline is built
  // only from PAST quiet windows, so it reflects the pre-move volume level.
  addBar(ticker: string, bar: TickBar): TickCandidate | null {
    const prior = this.priorClose.get(ticker);
    if (prior === undefined) return null;

    let st = this.state.get(ticker);
    if (!st) {
      st = { bars: [], quietVols: [], fired: false, diagnosed: false };
      this.state.set(ticker, st);
    }
    st.bars.push(bar);
    const cutoff = bar.ts_sec - TICK_DETECT.history_sec;
    while (st.bars.length > 0 && st.bars[0].ts_sec < cutoff) st.bars.shift();

    // Trailing window aggregates.
    const winStart = bar.ts_sec - TICK_DETECT.window_sec;
    let basePrice = bar.close, whi = bar.high, wlo = bar.low, winVol = 0;
    let oldestInWin = bar.close;
    for (let i = st.bars.length - 1; i >= 0; i--) {
      const b = st.bars[i];
      if (b.ts_sec < winStart) break;
      whi = Math.max(whi, b.high);
      wlo = Math.min(wlo, b.low);
      winVol += b.volume;
      oldestInWin = b.close;
    }
    basePrice = oldestInWin;

    const cum = (bar.close / prior - 1) * 100;
    const mom = basePrice > 0 ? (bar.close / basePrice - 1) * 100 : 0;
    const pos = whi > wlo ? (bar.close - wlo) / (whi - wlo) : 1;

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

    if (st.fired) return null;
    const relVol = baseline > 0 ? winVol / baseline : 0;
    if (
      baseline >= TICK_DETECT.baseline_min_sh &&
      cum >= TICK_DETECT.cum_min &&
      mom >= TICK_DETECT.mom_min &&
      relVol >= TICK_DETECT.relvol_min &&
      pos >= TICK_DETECT.near_high
    ) {
      st.fired = true;
      return {
        ticker,
        ts_sec: bar.ts_sec,
        price: bar.close,
        change_pct: +cum.toFixed(2),
        rel_vol: +relVol.toFixed(1),
        mom_pct: +mom.toFixed(1),
      };
    }
    // Near-miss diagnostic — a tracked name reached an igniting chg% but didn't
    // fire. Record the binding reason ONCE so we can tell gappers (no baseline)
    // from gate failures, without log spam.
    if (cum >= TICK_DETECT.cum_min && !st.diagnosed) {
      st.diagnosed = true;
      const reason =
        baseline < TICK_DETECT.baseline_min_sh ? `no-baseline (gapped, base=${Math.round(baseline)}sh, ${st.quietVols.length} quiet)`
        : relVol < TICK_DETECT.relvol_min ? `low-relvol (${relVol.toFixed(1)}x < ${TICK_DETECT.relvol_min})`
        : mom < TICK_DETECT.mom_min ? `low-mom (+${mom.toFixed(0)}%/60s < ${TICK_DETECT.mom_min})`
        : `reverting (pos ${pos.toFixed(2)} < ${TICK_DETECT.near_high})`;
      this.diag.push(`${ticker} +${cum.toFixed(0)}% — ${reason}`);
    }
    return null;
  }
}

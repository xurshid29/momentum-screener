import type { MacdCurlEvent } from './macd-curl.js';

export type MomoSetupState = 'warming' | 'resetting' | 'basing' | 'curling' | 'ready' | 'triggered' | 'failed';

export interface MomoSetupBar {
  closeTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MomoSetupSnapshot {
  state: MomoSetupState;
  state_at: number;
  setup_number: number;
  setup_at: number | null;
  trigger_at: number | null;
  entry: number | null;
  trigger: number | null;
  stop: number | null;
  stop_distance_pct: number | null;
  pullback_depth_pct: number | null;
  base_bars: number;
  volume_dryup_ratio: number | null;
  volume_reexpansion_ratio: number | null;
  below_zero: boolean | null;
  above_ema21: boolean | null;
  last_5m_ts: number | null;
  last_2m_ts: number | null;
  failure_reason: string | null;
}

export interface MomoSetupTransition {
  ticker: string;
  state: MomoSetupState;
  ts_sec: number;
}

interface SetupState {
  ticker: string;
  bars5: MomoSetupBar[];
  bars2: MomoSetupBar[];
  state: MomoSetupState;
  stateAt: number;
  episodeAt: number | null;
  setupNumber: number;
  setupAt: number | null;
  triggerAt: number | null;
  entry: number | null;
  trigger: number | null;
  stop: number | null;
  peak: number | null;
  lowAt: number | null;
  belowZero: boolean | null;
  aboveEma21: boolean | null;
  reexpansion: number | null;
  failureReason: string | null;
}

export const MOMO_SETUP = {
  min_pullback_pct: 3,
  max_stop_pct: 15,
  pivot_bars_2m: 3,
  volume_lookback_2m: 5,
  min_volume_reexpansion: 1.5,
  min_trigger_notional: 2_000,
  max_ready_bars_5m: 8,
} as const;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function ratio(n: number, d: number | null): number | null {
  return d != null && d > 0 ? n / d : null;
}

// Experimental second-leg setup engine. MACD supplies timing; price structure
// and volume decide whether the curl deserves an actionable row. It is pure,
// has no alert side effects, and only consumes closed bars.
export class MomoSetupTracker {
  private states = new Map<string, SetupState>();
  private pending: MomoSetupTransition[] = [];

  private ensure(ticker: string): SetupState {
    let st = this.states.get(ticker);
    if (!st) {
      st = {
        ticker,
        bars5: [], bars2: [], state: 'warming', stateAt: 0,
        episodeAt: null, setupNumber: 0, setupAt: null, triggerAt: null,
        entry: null, trigger: null, stop: null, peak: null, lowAt: null,
        belowZero: null, aboveEma21: null, reexpansion: null, failureReason: null,
      };
      this.states.set(ticker, st);
    }
    return st;
  }

  resetDaily(): void {
    for (const st of this.states.values()) {
      st.state = st.bars5.length >= 5 ? 'resetting' : 'warming';
      st.stateAt = 0;
      st.episodeAt = null;
      st.setupNumber = 0;
      st.setupAt = null;
      st.triggerAt = null;
      st.entry = null;
      st.trigger = null;
      st.stop = null;
      st.peak = null;
      st.lowAt = null;
      st.belowZero = null;
      st.aboveEma21 = null;
      st.reexpansion = null;
      st.failureReason = null;
    }
  }

  drainTransitions(): MomoSetupTransition[] {
    return this.pending.splice(0);
  }

  add5mBar(ticker: string, bar: MomoSetupBar, silent = false): void {
    const st = this.ensure(ticker);
    const last = st.bars5.at(-1);
    if (last && bar.closeTs <= last.closeTs) return;
    st.bars5.push(bar);
    if (st.bars5.length > 24) st.bars5.shift();
    if (silent) return;

    if (st.episodeAt != null) {
      const episodeBars = st.bars5.filter((b) => b.closeTs >= st.episodeAt!);
      const peak = st.peak ?? Math.max(...episodeBars.map((b) => b.high));
      st.peak = Math.max(peak, ...episodeBars.map((b) => b.high));
      const lowBar = episodeBars.reduce((a, b) => b.low < a.low ? b : a);
      st.lowAt = lowBar.closeTs;

      if (st.setupAt == null) {
        const depth = st.peak > 0 ? (st.peak - lowBar.low) / st.peak * 100 : 0;
        const baseBars = episodeBars.filter((b) => b.closeTs >= lowBar.closeTs).length - 1;
        this.transition(st, depth >= MOMO_SETUP.min_pullback_pct && baseBars >= 1 ? 'basing' : 'resetting', bar.closeTs);
      } else if (st.state !== 'failed') {
        if (st.stop != null && bar.low < st.stop * 0.995) {
          st.failureReason = 'pullback low broke';
          this.transition(st, 'failed', bar.closeTs);
        } else if (st.triggerAt == null && this.barsSince(st, st.setupAt) > MOMO_SETUP.max_ready_bars_5m) {
          st.failureReason = 'setup expired';
          this.transition(st, 'failed', bar.closeTs);
        } else if (st.triggerAt == null) {
          this.refreshReadiness(st, bar.closeTs);
        }
      }
    }
  }

  add2mBar(ticker: string, bar: MomoSetupBar, silent = false): void {
    const st = this.ensure(ticker);
    const last = st.bars2.at(-1);
    if (last && bar.closeTs <= last.closeTs) return;
    const prior = st.bars2.slice();
    st.bars2.push(bar);
    if (st.bars2.length > 32) st.bars2.shift();
    if (silent || st.state !== 'ready' || st.triggerAt != null) return;

    const pivotBars = prior.slice(-MOMO_SETUP.pivot_bars_2m);
    const volBars = prior.slice(-MOMO_SETUP.volume_lookback_2m);
    if (pivotBars.length < MOMO_SETUP.pivot_bars_2m || volBars.length < 3) return;
    const pivot = Math.max(...pivotBars.map((b) => b.high));
    const baseVol = median(volBars.map((b) => b.volume).filter((v) => v > 0));
    const reexpansion = ratio(bar.volume, baseVol);
    st.trigger = pivot;
    st.reexpansion = reexpansion;
    if (
      bar.close > pivot &&
      reexpansion != null && reexpansion >= MOMO_SETUP.min_volume_reexpansion &&
      bar.close * bar.volume >= MOMO_SETUP.min_trigger_notional
    ) {
      st.entry = bar.close;
      st.triggerAt = bar.closeTs;
      this.transition(st, 'triggered', bar.closeTs);
    }
  }

  onMacdEvent(event: MacdCurlEvent): void {
    if (event.variant !== '5m') return;
    const st = this.ensure(event.ticker);
    if (event.type === 'fade') {
      st.episodeAt = event.ts_sec;
      st.setupAt = null;
      st.triggerAt = null;
      st.entry = null;
      st.trigger = null;
      st.stop = null;
      st.peak = Math.max(event.price, ...st.bars5.slice(-5).map((b) => b.high));
      st.lowAt = event.ts_sec;
      st.belowZero = event.below_zero;
      st.aboveEma21 = event.above_trend;
      st.reexpansion = null;
      st.failureReason = null;
      this.transition(st, 'resetting', event.ts_sec);
      return;
    }
    if (event.type !== 'setup') return;

    // A deploy can miss the earlier fade event; use the recent structure as
    // a bounded episode instead of dropping the curl entirely.
    if (st.episodeAt == null) st.episodeAt = st.bars5.at(-6)?.closeTs ?? event.ts_sec;
    st.setupNumber++;
    st.setupAt = event.ts_sec;
    st.triggerAt = null;
    st.entry = null;
    st.trigger = null;
    st.reexpansion = null;
    st.failureReason = null;
    st.belowZero = event.below_zero;
    st.aboveEma21 = event.above_trend;
    const episodeBars = st.bars5.filter((b) => b.closeTs >= st.episodeAt!);
    if (episodeBars.length > 0) {
      st.peak = Math.max(st.peak ?? 0, ...episodeBars.map((b) => b.high));
      st.stop = Math.min(...episodeBars.map((b) => b.low));
      st.lowAt = episodeBars.reduce((a, b) => b.low < a.low ? b : a).closeTs;
    }
    this.transition(st, 'curling', event.ts_sec);
    this.refreshReadiness(st, event.ts_sec);
  }

  snapshot(ticker: string): MomoSetupSnapshot | null {
    const st = this.states.get(ticker);
    if (!st) return null;
    const episodeBars = st.episodeAt == null ? [] : st.bars5.filter((b) => b.closeTs >= st.episodeAt!);
    const low = st.stop ?? (episodeBars.length ? Math.min(...episodeBars.map((b) => b.low)) : null);
    const depth = st.peak != null && low != null && st.peak > 0 ? (st.peak - low) / st.peak * 100 : null;
    const refPrice = st.entry ?? st.bars5.at(-1)?.close ?? null;
    const stopDistance = refPrice != null && low != null && refPrice > low ? (refPrice - low) / refPrice * 100 : null;
    const lowAt = st.lowAt;
    const baseBars = lowAt == null ? 0 : episodeBars.filter((b) => b.closeTs > lowAt).length;
    const before = lowAt == null ? [] : episodeBars.filter((b) => b.closeTs <= lowAt).slice(-3);
    const after = lowAt == null ? [] : episodeBars.filter((b) => b.closeTs >= lowAt).slice(0, 3);
    const dryup = ratio(
      after.reduce((s, b) => s + b.volume, 0) / Math.max(1, after.length),
      before.length ? before.reduce((s, b) => s + b.volume, 0) / before.length : null,
    );
    return {
      state: st.state, state_at: st.stateAt, setup_number: st.setupNumber,
      setup_at: st.setupAt, trigger_at: st.triggerAt, entry: st.entry,
      trigger: st.trigger, stop: low, stop_distance_pct: stopDistance,
      pullback_depth_pct: depth, base_bars: baseBars,
      volume_dryup_ratio: dryup, volume_reexpansion_ratio: st.reexpansion,
      below_zero: st.belowZero, above_ema21: st.aboveEma21,
      last_5m_ts: st.bars5.at(-1)?.closeTs ?? null,
      last_2m_ts: st.bars2.at(-1)?.closeTs ?? null,
      failure_reason: st.failureReason,
    };
  }

  private refreshReadiness(st: SetupState, ts: number): void {
    const snap = [...this.states.entries()].find(([, x]) => x === st);
    if (!snap) return;
    const s = this.snapshot(snap[0]);
    const ready = s?.pullback_depth_pct != null && s.pullback_depth_pct >= MOMO_SETUP.min_pullback_pct
      && s.base_bars >= 1
      && s.stop_distance_pct != null && s.stop_distance_pct <= MOMO_SETUP.max_stop_pct;
    this.transition(st, ready ? 'ready' : 'curling', ts);
  }

  private barsSince(st: SetupState, ts: number): number {
    return st.bars5.filter((b) => b.closeTs > ts).length;
  }

  private transition(st: SetupState, next: MomoSetupState, ts: number): void {
    if (st.state === next) return;
    st.state = next;
    st.stateAt = ts;
    this.pending.push({ ticker: st.ticker, state: next, ts_sec: ts });
  }
}

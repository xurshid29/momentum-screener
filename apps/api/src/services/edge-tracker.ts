// EdgeTracker — the operator's 1-minute execution playbook, expressed as a
// deterministic state machine. Selection stays outside this module (Momentum
// and Live Ticks); EMA periods are saved per ticker by the user. This tracker
// only answers: is price approaching, confirming, or losing the configured
// dynamic level while standard EMA-MACD(3,15,8) turns upward?

import { randomUUID } from 'node:crypto';

export type EdgePhase = 'warming' | 'watching' | 'armed' | 'entry' | 'bailout';
export type EdgeSetup =
  | 'ema_bounce'
  | 'vwap_bounce'
  | 'ema_reclaim'
  | 'vwap_reclaim'
  | 'vwap_ema_reclaim';

export interface EdgePresetConfig {
  user_id: string;
  ticker: string;
  ema_fast: number;
  ema_slow: number;
  proximity_pct: number;
  stop_buffer_pct: number;
  alert_armed: boolean;
  alert_entry: boolean;
  alert_bailout: boolean;
  telegram_enabled: boolean;
  active: boolean;
}

export interface EdgeBar {
  ts_sec: number; // bucket close timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EdgeEvent {
  id: string;
  user_id: string;
  ticker: string;
  event: 'armed' | 'entry' | 'bailout';
  setup: EdgeSetup | null;
  price: number;
  level: number | null;
  bailout: number | null;
  at: string;
  snapshot: EdgeSnapshot;
}

export interface EdgeSnapshot extends EdgePresetConfig {
  state: EdgePhase;
  setup: EdgeSetup | null;
  state_at: string | null;
  price: number | null;
  ema_fast_value: number | null;
  ema_slow_value: number | null;
  vwap: number | null;
  macd: number | null;
  macd_signal: number | null;
  macd_histogram: number | null;
  macd_rising: boolean;
  histogram_rising: boolean;
  macd_cross_up: boolean;
  support_label: string | null;
  support_value: number | null;
  bailout_level: number | null;
  bars_seen: number;
  warmup_remaining: number;
  last_bar_at: string | null;
  last_event: Omit<EdgeEvent, 'snapshot'> | null;
}

interface Point {
  close: number;
  emaFast: number;
  emaSlow: number;
  vwap: number;
  macd: number;
  signal: number;
  histogram: number;
}

class EmaValue {
  private value: number | null = null;
  private seedSum = 0;
  private seedCount = 0;

  constructor(readonly length: number) {}

  update(price: number): number | null {
    if (this.value == null) {
      this.seedSum += price;
      this.seedCount += 1;
      if (this.seedCount === this.length) this.value = this.seedSum / this.length;
    } else {
      const alpha = 2 / (this.length + 1);
      this.value = price * alpha + this.value * (1 - alpha);
    }
    return this.value;
  }
}

// TradingView's Session VWAP on an extended-hours 1m chart begins with the
// 04:00 ET session. Subtracting four wall-clock hours before formatting gives
// the desired key (00:00–03:59 ET belongs to the previous session); the DST
// transition itself occurs on a Sunday when this feed is ignored.
const etDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
function sessionKey(tsSec: number): string {
  return etDate.format(new Date(tsSec * 1000 - 4 * 3600_000));
}

const ARMED_COOLDOWN_MS = 5 * 60_000;

export class EdgeTracker {
  private emaFast: EmaValue;
  private emaSlow: EmaValue;
  private macdFast = new EmaValue(3);
  private macdSlow = new EmaValue(15);
  private macdSignal = new EmaValue(8);
  private phase: EdgePhase = 'warming';
  private point: Point | null = null;
  private livePrice: number | null = null;
  private barsSeen = 0;
  private lastBarTs = 0;
  private vwapKey = '';
  private vwapPxVol = 0;
  private vwapVolume = 0;
  private activeSetup: EdgeSetup | null = null;
  private supportLabel: string | null = null;
  private supportValue: number | null = null;
  private bailoutLevel: number | null = null;
  private stateAt: string | null = null;
  private lastEvent: Omit<EdgeEvent, 'snapshot'> | null = null;
  private lastArmedAlertAt = 0;

  constructor(
    private cfg: EdgePresetConfig,
    private readonly emit: (event: EdgeEvent) => void,
  ) {
    this.emaFast = new EmaValue(cfg.ema_fast);
    this.emaSlow = new EmaValue(cfg.ema_slow);
  }

  seed(bars: EdgeBar[]): void {
    this.emaFast = new EmaValue(this.cfg.ema_fast);
    this.emaSlow = new EmaValue(this.cfg.ema_slow);
    this.macdFast = new EmaValue(3);
    this.macdSlow = new EmaValue(15);
    this.macdSignal = new EmaValue(8);
    this.phase = 'warming';
    this.point = null;
    this.livePrice = null;
    this.barsSeen = 0;
    this.lastBarTs = 0;
    this.vwapKey = '';
    this.vwapPxVol = 0;
    this.vwapVolume = 0;
    this.activeSetup = null;
    this.supportLabel = null;
    this.supportValue = null;
    this.bailoutLevel = null;
    this.stateAt = null;
    this.lastEvent = null;
    this.lastArmedAlertAt = 0;
    this.prevForSnapshot = null;
    for (const bar of bars) this.consume(bar, true);
    if (this.point) {
      this.phase = this.isWarm() ? 'watching' : 'warming';
      this.stateAt = new Date(this.lastBarTs * 1000).toISOString();
    }
  }

  addClosedBar(bar: EdgeBar): void {
    this.consume(bar, false);
  }

  // Alert-channel edits must not erase an in-flight trade. The service calls
  // this only when the indicator/risk fields are unchanged; EMA changes still
  // construct and seed a fresh tracker.
  updateConfig(cfg: EdgePresetConfig): void {
    this.cfg = cfg;
  }

  updateLive(price: number, low = price, high = price, tsSec = Math.floor(Date.now() / 1000)): void {
    if (price > 0) this.livePrice = price;
    if (!this.isWarm() || !this.point || this.phase === 'entry' || this.phase === 'bailout') return;
    // At 04:00 ET the prior VWAP is stale until the first new 1m candle
    // closes and resets the accumulator. Suppress that one-minute seam.
    if (this.vwapKey && sessionKey(tsSec) !== this.vwapKey) return;
    const near = this.nearestTouchedLevel(price, low, high);
    if (near) {
      if (this.phase !== 'armed') {
        this.phase = 'armed';
        this.activeSetup = near.setup;
        this.supportLabel = near.label;
        this.supportValue = near.value;
        this.bailoutLevel = near.value * (1 - this.cfg.stop_buffer_pct / 100);
        this.stateAt = new Date(tsSec * 1000).toISOString();
        const now = tsSec * 1000;
        if (now - this.lastArmedAlertAt >= ARMED_COOLDOWN_MS) {
          this.lastArmedAlertAt = now;
          this.fire('armed', price, tsSec);
        }
      }
    } else if (this.phase === 'armed') {
      // Use a wider release band than the arm band to avoid flickering at the
      // exact boundary. A later approach can arm again, subject to cooldown.
      const levels = [this.point.emaFast, this.point.emaSlow, this.point.vwap];
      const minDistPct = Math.min(...levels.map((v) => Math.abs(price - v) / v * 100));
      if (minDistPct > this.cfg.proximity_pct * 1.5) {
        this.phase = 'watching';
        this.activeSetup = null;
        this.supportLabel = null;
        this.supportValue = null;
        this.bailoutLevel = null;
        this.stateAt = new Date(tsSec * 1000).toISOString();
      }
    }
  }

  reset(): void {
    this.phase = this.isWarm() ? 'watching' : 'warming';
    this.activeSetup = null;
    this.supportLabel = null;
    this.supportValue = null;
    this.bailoutLevel = null;
    this.lastArmedAlertAt = 0;
    this.stateAt = new Date().toISOString();
  }

  snapshot(): EdgeSnapshot {
    const warmup = Math.max(0, this.cfg.ema_slow - this.barsSeen, 22 - this.barsSeen);
    return {
      ...this.cfg,
      state: this.phase,
      setup: this.activeSetup,
      state_at: this.stateAt,
      price: this.livePrice ?? this.point?.close ?? null,
      ema_fast_value: this.point?.emaFast ?? null,
      ema_slow_value: this.point?.emaSlow ?? null,
      vwap: this.point?.vwap ?? null,
      macd: this.point?.macd ?? null,
      macd_signal: this.point?.signal ?? null,
      macd_histogram: this.point?.histogram ?? null,
      macd_rising: this.point != null && this.prevForSnapshot != null
        ? this.point.macd > this.prevForSnapshot.macd : false,
      histogram_rising: this.point != null && this.prevForSnapshot != null
        ? this.point.histogram > this.prevForSnapshot.histogram : false,
      macd_cross_up: this.point != null && this.prevForSnapshot != null
        ? this.prevForSnapshot.macd <= this.prevForSnapshot.signal && this.point.macd > this.point.signal : false,
      support_label: this.supportLabel,
      support_value: this.supportValue,
      bailout_level: this.bailoutLevel,
      bars_seen: this.barsSeen,
      warmup_remaining: warmup,
      last_bar_at: this.lastBarTs ? new Date(this.lastBarTs * 1000).toISOString() : null,
      last_event: this.lastEvent,
    };
  }

  private prevForSnapshot: Point | null = null;

  private consume(bar: EdgeBar, silent: boolean): void {
    if (bar.ts_sec <= this.lastBarTs || !(bar.close > 0)) return;
    const previous = this.point;
    this.prevForSnapshot = previous;
    this.lastBarTs = bar.ts_sec;
    this.livePrice = bar.close;
    this.barsSeen += 1;

    const key = sessionKey(bar.ts_sec - 1);
    const newSession = this.vwapKey !== '' && key !== this.vwapKey;
    if (key !== this.vwapKey) {
      this.vwapKey = key;
      this.vwapPxVol = 0;
      this.vwapVolume = 0;
      if (newSession) {
        // A prior-session entry/bailout must never leak into the next day's
        // playbook. EMA/MACD remain continuous like the chart; trade state and
        // VWAP reset at the 04:00 ET session boundary.
        this.phase = 'watching';
        this.activeSetup = null;
        this.supportLabel = null;
        this.supportValue = null;
        this.bailoutLevel = null;
        this.lastArmedAlertAt = 0;
      }
    }
    const volume = Math.max(0, Number.isFinite(bar.volume) ? bar.volume : 0);
    const typical = (bar.high + bar.low + bar.close) / 3;
    this.vwapPxVol += typical * volume;
    this.vwapVolume += volume;

    const ef = this.emaFast.update(bar.close);
    const es = this.emaSlow.update(bar.close);
    const mf = this.macdFast.update(bar.close);
    const ms = this.macdSlow.update(bar.close);
    const line = mf != null && ms != null ? mf - ms : null;
    const sig = line != null ? this.macdSignal.update(line) : null;
    const vwap = this.vwapVolume > 0 ? this.vwapPxVol / this.vwapVolume : null;
    if (ef == null || es == null || line == null || sig == null || vwap == null) {
      this.phase = 'warming';
      return;
    }
    this.point = { close: bar.close, emaFast: ef, emaSlow: es, vwap, macd: line, signal: sig, histogram: line - sig };
    if (silent || !previous || newSession) {
      if (newSession) this.stateAt = new Date(bar.ts_sec * 1000).toISOString();
      return;
    }

    if (this.phase === 'entry') {
      if (this.bailoutLevel != null && bar.close < this.bailoutLevel) {
        this.phase = 'bailout';
        this.stateAt = new Date(bar.ts_sec * 1000).toISOString();
        this.fire('bailout', bar.close, bar.ts_sec);
      }
      // Once an entry fires, hold its risk reference until a bailout or the
      // operator explicitly resets after taking profit. Later bars must not
      // silently downgrade it back to watching.
      return;
    }
    if (this.phase === 'bailout') return;

    const macdRising = this.point.macd > previous.macd
      && this.point.histogram > previous.histogram;
    const candidate = macdRising ? this.entryCandidate(bar, previous) : null;
    if (candidate) {
      this.phase = 'entry';
      this.activeSetup = candidate.setup;
      this.supportLabel = candidate.label;
      this.supportValue = candidate.value;
      this.bailoutLevel = candidate.value * (1 - this.cfg.stop_buffer_pct / 100);
      this.stateAt = new Date(bar.ts_sec * 1000).toISOString();
      this.fire('entry', bar.close, bar.ts_sec);
      return;
    }

    const near = this.nearestTouchedLevel(bar.close, bar.low, bar.high);
    this.phase = near ? 'armed' : 'watching';
    this.activeSetup = near?.setup ?? null;
    this.supportLabel = near?.label ?? null;
    this.supportValue = near?.value ?? null;
    this.bailoutLevel = near ? near.value * (1 - this.cfg.stop_buffer_pct / 100) : null;
    this.stateAt = new Date(bar.ts_sec * 1000).toISOString();
  }

  private isWarm(): boolean {
    return this.point != null;
  }

  private entryCandidate(bar: EdgeBar, prev: Point): { setup: EdgeSetup; label: string; value: number } | null {
    const p = this.point!;
    const aboveEmas = bar.close >= p.emaFast && bar.close >= p.emaSlow;
    const wasAboveEmas = prev.close >= prev.emaFast && prev.close >= prev.emaSlow;
    const aboveAll = aboveEmas && bar.close >= p.vwap;
    const wasAboveAll = wasAboveEmas && prev.close >= prev.vwap;
    const emaReclaim = aboveEmas && !wasAboveEmas;
    const vwapReclaim = bar.close >= p.vwap && prev.close < prev.vwap;

    if (aboveAll && !wasAboveAll && (emaReclaim || vwapReclaim)) {
      const value = Math.max(p.emaFast, p.emaSlow, p.vwap);
      return { setup: 'vwap_ema_reclaim', label: `EMA ${this.cfg.ema_fast}/${this.cfg.ema_slow} + VWAP`, value };
    }
    if (emaReclaim) {
      const value = Math.max(p.emaFast, p.emaSlow);
      return { setup: 'ema_reclaim', label: `EMA ${this.cfg.ema_fast}/${this.cfg.ema_slow}`, value };
    }
    if (vwapReclaim) return { setup: 'vwap_reclaim', label: 'VWAP', value: p.vwap };

    // Bounce: a green 1m candle traded into a level from above and closed
    // back on its good side. Choose the closest touched level to the low so
    // the bailout reference matches what the chart actually respected.
    if (bar.close <= bar.open) return null;
    const touches: Array<{ setup: EdgeSetup; label: string; value: number; d: number }> = [];
    const add = (setup: EdgeSetup, label: string, value: number, prevValue: number) => {
      const tol = value * this.cfg.proximity_pct / 100;
      if (prev.close >= prevValue && bar.low <= value + tol && bar.close >= value) {
        touches.push({ setup, label, value, d: Math.abs(bar.low - value) });
      }
    };
    add('vwap_bounce', 'VWAP', p.vwap, prev.vwap);
    add('ema_bounce', `EMA ${this.cfg.ema_fast}`, p.emaFast, prev.emaFast);
    add('ema_bounce', `EMA ${this.cfg.ema_slow}`, p.emaSlow, prev.emaSlow);
    touches.sort((a, b) => a.d - b.d);
    return touches[0] ?? null;
  }

  private nearestTouchedLevel(price: number, low: number, high: number): { setup: EdgeSetup; label: string; value: number } | null {
    if (!this.point) return null;
    const p = this.point;
    const candidates = [
      { label: 'VWAP', value: p.vwap, setup: price >= p.vwap ? 'vwap_bounce' : 'vwap_reclaim' as EdgeSetup },
      { label: `EMA ${this.cfg.ema_fast}`, value: p.emaFast, setup: price >= p.emaFast ? 'ema_bounce' : 'ema_reclaim' as EdgeSetup },
      { label: `EMA ${this.cfg.ema_slow}`, value: p.emaSlow, setup: price >= p.emaSlow ? 'ema_bounce' : 'ema_reclaim' as EdgeSetup },
    ].map((x) => ({ ...x, d: Math.abs(price - x.value) / x.value * 100 }))
      .filter((x) => {
        const tol = x.value * this.cfg.proximity_pct / 100;
        return x.d <= this.cfg.proximity_pct || (low <= x.value + tol && high >= x.value - tol);
      })
      .sort((a, b) => a.d - b.d);
    return candidates[0] ?? null;
  }

  private fire(event: EdgeEvent['event'], price: number, tsSec: number): void {
    const base = {
      id: randomUUID(),
      user_id: this.cfg.user_id,
      ticker: this.cfg.ticker,
      event,
      setup: this.activeSetup,
      price,
      level: this.supportValue,
      bailout: this.bailoutLevel,
      at: new Date(tsSec * 1000).toISOString(),
    };
    this.lastEvent = base;
    this.emit({ ...base, snapshot: this.snapshot() });
  }
}

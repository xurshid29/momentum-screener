// Pure feature-extraction helpers over a chronological-ascending DailyBar[].
// All inputs come from getRecentBars() in daily-bars.ts; "today" is whatever
// bar Finviz most recently exposed for the ticker (partial mid-session,
// final after close).
//
// See docs/swing-screener-spec.md §3 + §3.1 for the score table these feed.

import type { DailyBar } from './finviz.js';

// 252 trading days ≈ 12 calendar months. Used for the 52-week high lookup.
export const TRADING_DAYS_PER_YEAR = 252;

// Simple moving average of the last `n` closes. Null when we don't yet have
// `n` bars (don't fake a partial — undefined is the honest signal).
export function sma(bars: DailyBar[], n: number): number | null {
  if (bars.length < n) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) sum += bars[i].close;
  return sum / n;
}

// Maximum of the `high` field over the last `lookback` bars (default 252 ≈ 1y).
export function high52w(bars: DailyBar[], lookback = TRADING_DAYS_PER_YEAR): number | null {
  if (bars.length === 0) return null;
  const start = Math.max(0, bars.length - lookback);
  let max = bars[start].high;
  for (let i = start + 1; i < bars.length; i++) if (bars[i].high > max) max = bars[i].high;
  return max;
}

// Wilder's ATR — average true range over the last 14 bars. Needs 15 bars
// (the first bar's TR has no prior close to reference). Returns null otherwise.
export function atr14(bars: DailyBar[]): number | null {
  const PERIOD = 14;
  if (bars.length < PERIOD + 1) return null;
  let sum = 0;
  for (let i = bars.length - PERIOD; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    sum += tr;
  }
  return sum / PERIOD;
}

// 20-day average volume — used both for the volume-confirmation component
// and the avg_volume_20 column on swing_results.
export function avgVolume(bars: DailyBar[], n = 20): number | null {
  if (bars.length < n) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) sum += bars[i].volume;
  return Math.round(sum / n);
}

// Base detection — are the `n` closes leading up to (but NOT including)
// today contained within a contained range? The 2026-06-13 recalibration
// lengthened the window 5 → 15 bars and loosened the thresholds: a 5-day
// ≤10% range mostly proxied LOW VOLATILITY, not consolidation — outcome data
// showed in_base names had the *lowest* forward peaks (tight-base+breakout
// peaked +4.2/5d vs +9.1 for breakout-without-base). A real base on a
// volatile name is multi-week and wider. The `tight` flag drives the
// `in_base` boolean column on swing_results.
//
// Spec §3.1 table (v2):
//   prior-15-close range ≤ 15% → score 6 (tight base)
//   ≤ 25% → score 3
//   else  → score 0
export function baseDetection(bars: DailyBar[], n = 15): { score: number; tight: boolean } {
  // Need the last `n` bars *before* today, so `n + 1` bars total.
  if (bars.length < n + 1) return { score: 0, tight: false };
  const priorClose = bars.slice(-n - 1, -1).map((b) => b.close);
  const min = Math.min(...priorClose);
  const max = Math.max(...priorClose);
  if (min <= 0) return { score: 0, tight: false };
  const range = (max - min) / min;
  if (range <= 0.15) return { score: 6, tight: true };
  if (range <= 0.25) return { score: 3, tight: false };
  return { score: 0, tight: false };
}

// Fresh-breakout detection — is today the FIRST (or second) close above the
// prior `look`-bar high? Plain "price > prior high" stays true on every bar
// of an extended ramp, so the old broke_out flag kept firing all the way up
// a parabola — exactly the "already extended, at resistance" complaint.
// Outcome data (2026-06-13): day-1 crosses at score ≥60 peaked +14.4%/5d
// with −11 drawdown vs +7.7/−18 for stale crosses. Freshness is what makes
// it a *starting* breakout, and the same mechanism catches both a flat
// consolidation break and the first thrust out of a downtrend base.
//   day-1 cross (yesterday was NOT above its prior high) → 20 pts
//   day-2 cross                                          → 12 pts
//   still above, but crossed ≥3 bars ago (stale)         →  4 pts
//   not above the prior `look`-bar high                  →  0 pts
export function freshBreakout(
  price: number,
  bars: DailyBar[],
  look = 15,
): { score: number; crossDay: 1 | 2 | null; aboveToday: boolean } {
  if (bars.length < look + 3) return { score: 0, crossDay: null, aboveToday: false };
  const n = bars.length;
  // The live screen price stands in for today's (possibly partial) last bar.
  const closeAt = (i: number) => (i === n - 1 ? price : bars[i].close);
  const crossedAt = (i: number): boolean => {
    if (i < look) return false;
    let hi = -Infinity;
    for (let k = i - look; k < i; k++) hi = Math.max(hi, bars[k].high);
    return closeAt(i) > hi;
  };
  if (!crossedAt(n - 1)) return { score: 0, crossDay: null, aboveToday: false };
  if (!crossedAt(n - 2)) return { score: 20, crossDay: 1, aboveToday: true };
  if (!crossedAt(n - 3)) return { score: 12, crossDay: 2, aboveToday: true };
  return { score: 4, crossDay: null, aboveToday: true };
}

// Close strength — where in today's range did the bar settle? Only meaningful
// once today's bar has both a high and a low; we read the latest bar.
//   top 25% → 4 pts (close_in_top_q = true)
//   top 50% → 2 pts
//   else    → 0 pts
export function closeStrength(latest: DailyBar | null): { score: number; topQ: boolean } {
  if (!latest) return { score: 0, topQ: false };
  const range = latest.high - latest.low;
  if (range <= 0) return { score: 0, topQ: false };
  const pos = (latest.close - latest.low) / range;
  if (pos >= 0.75) return { score: 4, topQ: true };
  if (pos >= 0.5) return { score: 2, topQ: false };
  return { score: 0, topQ: false };
}

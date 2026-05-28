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
// today contained within a tight range? Tighter = better setup. The
// returned `tight` flag drives the `in_base` boolean column on swing_results.
//
// Spec §3.1 table:
//   ≤ 10% → score 10 (tight base)
//   ≤ 15% → score 6
//   ≤ 20% → score 3
//   else  → score 0
export function baseDetection(bars: DailyBar[], n = 5): { score: number; tight: boolean } {
  // Need the last `n` bars *before* today, so `n + 1` bars total.
  if (bars.length < n + 1) return { score: 0, tight: false };
  const priorClose = bars.slice(-n - 1, -1).map((b) => b.close);
  const min = Math.min(...priorClose);
  const max = Math.max(...priorClose);
  if (min <= 0) return { score: 0, tight: false };
  const range = (max - min) / min;
  if (range <= 0.10) return { score: 10, tight: true };
  if (range <= 0.15) return { score: 6, tight: false };
  if (range <= 0.20) return { score: 3, tight: false };
  return { score: 0, tight: false };
}

// Breakout detection — `price` above the highest `high` of the prior `n`
// bars (excluding today). Returns the score for that breakout *and* a flag
// the alert path uses. Spec §3.1:
//   today > prior 10-day high  → 10 pts, broke_out = true (alert trigger)
//   today > prior 5-day high   → 5 pts
//   neither                    → 0 pts
export function breakoutDetection(
  price: number,
  bars: DailyBar[],
): { score: number; brokeOut10: boolean; brokeOut5: boolean } {
  if (bars.length < 11) return { score: 0, brokeOut10: false, brokeOut5: false };
  const prior10 = bars.slice(-11, -1);              // 10 bars before today
  const prior5 = prior10.slice(-5);                 // tightest 5
  const high10 = prior10.reduce((m, b) => Math.max(m, b.high), -Infinity);
  const high5 = prior5.reduce((m, b) => Math.max(m, b.high), -Infinity);
  const brokeOut10 = price > high10;
  const brokeOut5 = price > high5;
  return {
    score: brokeOut10 ? 10 : brokeOut5 ? 5 : 0,
    brokeOut10,
    brokeOut5,
  };
}

// Close strength — where in today's range did the bar settle? Only meaningful
// once today's bar has both a high and a low; we read the latest bar.
//   top 25% → 5 pts (close_in_top_q = true)
//   top 50% → 3 pts
//   else    → 0 pts
export function closeStrength(latest: DailyBar | null): { score: number; topQ: boolean } {
  if (!latest) return { score: 0, topQ: false };
  const range = latest.high - latest.low;
  if (range <= 0) return { score: 0, topQ: false };
  const pos = (latest.close - latest.low) / range;
  if (pos >= 0.75) return { score: 5, topQ: true };
  if (pos >= 0.5) return { score: 3, topQ: false };
  return { score: 0, topQ: false };
}

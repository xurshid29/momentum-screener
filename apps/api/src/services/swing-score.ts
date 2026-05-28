// Composite "swing score" for the Swing screener — fuses the daily-bar
// setup, trend qualifier, strength vs 52w high, volume confirmation, and
// catalyst durability into a single 0–100 number. Pure + deterministic.
// See docs/swing-screener-spec.md §3 + §3.1 for the locked-in weights.

import type { CatalystDirection, CatalystUrgency } from '../db/types.js';
import type { ShelfLevel } from './shelf.js';
import type { DailyBar } from './finviz.js';
import {
  sma,
  high52w,
  atr14,
  avgVolume,
  baseDetection,
  breakoutDetection,
  closeStrength,
} from './daily-bar-features.js';

export interface SwingScoreBreakdown {
  trend: number;
  strength: number;
  setup: number;        // composite: base + breakout + close strength
  volume: number;
  catalyst: number;
  shelf: number;        // ≤ 0 — a penalty
}

// Setup-pattern sub-flags. Persisted on swing_results so the post-hoc
// backtest can answer "did breakouts work?" without re-deriving from bars.
export interface SwingSetupFlags {
  in_base: boolean;
  broke_out: boolean;       // the 10-day breakout — the alert trigger
  broke_out_5d: boolean;    // the smaller 5-day breakout
  close_in_top_q: boolean;
}

// Daily-bar snapshot frozen with the score — same purpose as setup flags.
export interface SwingDailyContext {
  sma_20: number | null;
  sma_50: number | null;
  sma_200: number | null;
  high_52w: number | null;
  atr_14: number | null;
  avg_volume_20: number | null;
  dist_52w_high_pct: number | null;   // (price - high_52w) / high_52w * 100
}

export interface SwingScore {
  score: number;
  breakdown: SwingScoreBreakdown;
  flags: SwingSetupFlags;
  context: SwingDailyContext;
}

export interface SwingScoreInput {
  price: number | null;
  volume: number | null;
  bars: DailyBar[];                    // ~250 bars, ascending; today's bar is the last entry
  catalyst_score: number | null;
  catalyst_direction: CatalystDirection | null;
  catalyst_urgency: CatalystUrgency | null;
  catalyst_type: string | null;
  shelf_level: ShelfLevel | null;
}

// Trend qualifier — full SMA stack alignment (price > 20 > 50 > 200) is the
// classic uptrend filter. Partial alignment scores partial; below the 50-SMA
// disqualifies entirely (you don't swing-long a downtrend).
function trendScore(price: number, s20: number | null, s50: number | null, s200: number | null): number {
  if (s50 != null && price < s50) return 0;
  if (s20 == null || s50 == null) return 0;
  if (s200 != null && price > s20 && s20 > s50 && s50 > s200) return 25;
  if (price > s20 && s20 > s50) return 18;
  if (price > s20) return 10;
  return 0;
}

// Distance from 52w high — the canonical relative-strength check. Within 5%
// = near the highs (the strongest setups). > 30% off = a depressed name not
// worth a multi-day hold even on a setup.
function strengthScore(price: number, high: number | null): { score: number; dist: number | null } {
  if (high == null || high <= 0) return { score: 0, dist: null };
  const dist = ((price - high) / high) * 100;   // 0 at the high, negative below
  if (dist >= -5) return { score: 15, dist };
  if (dist >= -15) return { score: 10, dist };
  if (dist >= -30) return { score: 5, dist };
  return { score: 0, dist };
}

// Volume confirmation — today's cumulative-day volume vs the 20-day average.
// Without expansion behind it, a breakout doesn't follow through.
function volumeScore(todayVolume: number | null, avg20: number | null): number {
  if (todayVolume == null || avg20 == null || avg20 <= 0) return 0;
  const ratio = todayVolume / avg20;
  if (ratio >= 2.5) return 15;
  if (ratio >= 1.5) return 10;
  if (ratio >= 1.0) return 5;
  return 0;
}

// Durable catalysts get more weight than promotional pumps. The list of
// "durable" types matches the catalyst classifier's taxonomy — these are the
// stories that play out over multiple sessions, not the intraday squeezes.
const DURABLE_TYPES = new Set([
  'fda_approval',
  'fda_clinical',
  'regulatory_approval',
  'm_and_a',
  'mna',
  'earnings_beat',
  'earnings_guidance',
  'contract_win',
  'partnership',
]);
function catalystScore(
  score: number | null,
  direction: CatalystDirection | null,
  urgency: CatalystUrgency | null,
  type: string | null,
): number {
  if (score == null || direction === 'bearish') return 0;
  if (direction !== 'bullish') return Math.min(5, Math.round((score ?? 0) * 0.05));
  if (urgency === 'strong' || urgency === 'major') {
    if (type && DURABLE_TYPES.has(type)) return 20;
    return 12;
  }
  if (urgency === 'watch') return 5;
  return 0;
}

// Dilution penalty — heavier than the intraday runner-score because a multi-
// day hold gives the company time to actually file a 424B prospectus and
// dump shares into the strength.
function shelfPenalty(level: ShelfLevel | null): number {
  if (level === 'active') return -25;
  if (level === 'effective') return -15;
  if (level === 'shelf') return -7;
  return 0;
}

export function scoreSwing(i: SwingScoreInput): SwingScore | null {
  if (i.price == null || i.price <= 0) return null;

  const s20 = sma(i.bars, 20);
  const s50 = sma(i.bars, 50);
  const s200 = sma(i.bars, 200);
  const high = high52w(i.bars);
  const atr = atr14(i.bars);
  const avg20 = avgVolume(i.bars, 20);

  const base = baseDetection(i.bars, 5);
  const brk = breakoutDetection(i.price, i.bars);
  const todayBar = i.bars.length > 0 ? i.bars[i.bars.length - 1] : null;
  const closeStr = closeStrength(todayBar);
  const setupTotal = base.score + brk.score + closeStr.score;     // max 25

  const strength = strengthScore(i.price, high);

  const breakdown: SwingScoreBreakdown = {
    trend: trendScore(i.price, s20, s50, s200),
    strength: strength.score,
    setup: setupTotal,
    volume: volumeScore(i.volume, avg20),
    catalyst: catalystScore(i.catalyst_score, i.catalyst_direction, i.catalyst_urgency, i.catalyst_type),
    shelf: shelfPenalty(i.shelf_level),
  };

  const raw =
    breakdown.trend + breakdown.strength + breakdown.setup +
    breakdown.volume + breakdown.catalyst + breakdown.shelf;

  return {
    score: Math.max(0, Math.min(100, Math.round(raw))),
    breakdown,
    flags: {
      in_base: base.tight,
      broke_out: brk.brokeOut10,
      broke_out_5d: brk.brokeOut5,
      close_in_top_q: closeStr.topQ,
    },
    context: {
      sma_20: s20,
      sma_50: s50,
      sma_200: s200,
      high_52w: high,
      atr_14: atr,
      avg_volume_20: avg20,
      dist_52w_high_pct: strength.dist,
    },
  };
}

// Composite "swing score" for the Swing screener — selects EARLY, VOLATILE
// breakouts: names just starting out of a consolidation (or a downtrend
// base) with enough daily range to move 40–50% in days. Pure + deterministic.
// See docs/swing-screener-spec.md §3 + §3.1 for the weights.
//
// Recalibrated 2026-06-13 against forward outcomes (508 swing detections with
// a full 5-day horizon). The original score was INVERTED against its own
// goal: the ≥65 alert set had the LOWEST forward upside (peak_5d +2.8 vs
// +8.4 for sub-50 scores), full SMA-stack alignment (the old Trend 25)
// peaked +5.6 vs +9.5 for the below-SMA50 names it disqualified, the
// at-52w-high reward selected the WORST upside band (+5.4 vs +8.6 for names
// >30% below the high), and ATR — the single strongest upside predictor
// (≥8% ATR: 15% of detections peak ≥+20%, 5% peak ≥+40%; <3% ATR: zero ever
// reached +20) — wasn't scored at all. The v2 below, reconstructed on the
// same history: ≥60 → peak_5d +12.1, 17% ≥+20, 7% ≥+40 (~3.5 det/day) vs the
// old alert set's +2.8 / 0% / 0%. Mean chg_5d stays negative everywhere —
// these names bleed on a passive 5-day hold; the score targets peak capture
// (enter the fresh break, exit into strength), not buy-and-hold.

import type { CatalystDirection, CatalystUrgency } from '../db/types.js';
import type { ShelfLevel } from './shelf.js';
import type { DailyBar } from './finviz.js';
import {
  sma,
  high52w,
  atr14,
  avgVolume,
  baseDetection,
  freshBreakout,
  closeStrength,
} from './daily-bar-features.js';

export interface SwingScoreBreakdown {
  volatility: number;   // 0..25 — ATR% of price; can this name even move 40%?
  room: number;         // 0..15 — distance below the 52w high (inverts the old "strength")
  trigger: number;      // 0..30 — fresh range-high cross + base quality + close strength
  volume: number;       // 0..15 — expansion vs the 20-day average
  trend: number;        // 0..10 — light structure bonus (no longer a gate)
  catalyst: number;     // 0..10 — durable bullish catalyst
  extension: number;    // −15..0 — stretched above the 20-SMA = late entry
  shelf: number;        // ≤ 0 — dilution penalty
}

// Setup-pattern sub-flags. Persisted on swing_results so the post-hoc
// backtest can answer "did breakouts work?" without re-deriving from bars.
// Semantics since 2026-06-13: broke_out = DAY-1 fresh cross of the prior
// 15-bar high (the alert trigger); broke_out_5d = day-2 of that cross.
export interface SwingSetupFlags {
  in_base: boolean;
  broke_out: boolean;       // day-1 fresh breakout — the alert trigger
  broke_out_5d: boolean;    // day-2 of the breakout
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

// Volatility — ATR as % of price. The strongest single predictor of forward
// upside in the outcome data, and the direct answer to "can it move 40-50%
// in several days": only the ≥8% band ever printed +40 (5% of detections);
// sub-4% names (large-caps, REITs) structurally cannot and score 0 here.
function volatilityScore(atr: number | null, price: number): number {
  if (atr == null || price <= 0) return 0;
  const pct = (atr / price) * 100;
  if (pct >= 10) return 25;
  if (pct >= 8) return 22;
  if (pct >= 6) return 15;
  if (pct >= 4) return 7;
  return 0;
}

// Room — distance BELOW the 52w high. Inverts the old "strength" reward:
// at-the-high names (the old +15 band) had the worst forward peaks (+5.4)
// while names >30% below the high had the best (+8.6) — depth is room to
// run, and the depressed-base names are exactly the downtrend-reversal
// setups the screener should catch. At-high still gets a token 3 so a
// blue-sky break isn't zeroed outright.
function roomScore(price: number, high: number | null): { score: number; dist: number | null } {
  if (high == null || high <= 0) return { score: 0, dist: null };
  const dist = ((price - high) / high) * 100;   // 0 at the high, negative below
  if (dist <= -30) return { score: 15, dist };
  if (dist <= -15) return { score: 10, dist };
  if (dist <= -5) return { score: 5, dist };
  return { score: 3, dist };
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

// Light structure bonus — replaces the old 25-pt Trend gate. The outcome
// data showed mature SMA alignment had the LEAST remaining upside (trend 25
// → peak +5.6; the disqualified trend-0 reversal class → +9.5), so structure
// is now a nudge, not a gate: a downtrend-reversal name can reach the alert
// line on volatility + room + a fresh trigger.
function trendScore(price: number, s50: number | null, s200: number | null): number {
  let s = 0;
  if (s50 != null && price > s50) s += 5;
  if (s50 != null && s200 != null && s50 > s200) s += 5;
  return s;
}

// Extension guard — how stretched above the 20-SMA the entry is. Forward
// chg_5d bleeds monotonically with extension (−2.4% at <0% ext → −10.9% at
// ≥15%): a name 30%+ above its 20-SMA is mid-parabola, not starting.
function extensionPenalty(price: number, s20: number | null): number {
  if (s20 == null || s20 <= 0) return 0;
  const ext = ((price - s20) / s20) * 100;
  if (ext >= 30) return -15;
  if (ext >= 15) return -8;
  return 0;
}

// Durable catalysts get more weight than promotional pumps. The list of
// "durable" types matches the catalyst classifier's taxonomy — these are the
// stories that play out over multiple sessions, not the intraday squeezes.
// Weight halved (20 → 10) in the v2 rebalance: the setup quality carries the
// score; the catalyst is a tailwind.
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
  if (direction !== 'bullish') return Math.min(3, Math.round((score ?? 0) * 0.03));
  if (urgency === 'strong' || urgency === 'major') {
    if (type && DURABLE_TYPES.has(type)) return 10;
    return 6;
  }
  if (urgency === 'watch') return 3;
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

  const base = baseDetection(i.bars);
  const brk = freshBreakout(i.price, i.bars);
  const todayBar = i.bars.length > 0 ? i.bars[i.bars.length - 1] : null;
  const closeStr = closeStrength(todayBar);
  // Fresh cross (0/4/12/20) + base quality (0/3/6) + close strength (0/2/4).
  const trigger = brk.score + base.score + closeStr.score;        // max 30

  const room = roomScore(i.price, high);

  const breakdown: SwingScoreBreakdown = {
    volatility: volatilityScore(atr, i.price),
    room: room.score,
    trigger,
    volume: volumeScore(i.volume, avg20),
    trend: trendScore(i.price, s50, s200),
    catalyst: catalystScore(i.catalyst_score, i.catalyst_direction, i.catalyst_urgency, i.catalyst_type),
    extension: extensionPenalty(i.price, s20),
    shelf: shelfPenalty(i.shelf_level),
  };

  const raw =
    breakdown.volatility + breakdown.room + breakdown.trigger +
    breakdown.volume + breakdown.trend + breakdown.catalyst +
    breakdown.extension + breakdown.shelf;

  return {
    score: Math.max(0, Math.min(100, Math.round(raw))),
    breakdown,
    flags: {
      in_base: base.tight,
      broke_out: brk.crossDay === 1,
      broke_out_5d: brk.crossDay === 2,
      close_in_top_q: closeStr.topQ,
    },
    context: {
      sma_20: s20,
      sma_50: s50,
      sma_200: s200,
      high_52w: high,
      atr_14: atr,
      avg_volume_20: avg20,
      dist_52w_high_pct: room.dist,
    },
  };
}

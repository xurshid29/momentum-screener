// Composite "runner score" for the Ignition screener — fuses the structural and
// signal inputs of a low-float momentum ignition into a single 0–100 number.
// Pure + deterministic. See docs/ignition-screener-spec.md §3 for the weights.

import type { CatalystDirection } from '../db/types.js';

export interface RunnerScoreBreakdown {
  float: number;
  volume: number;
  catalyst: number;
  earliness: number;
  halt: number;
}

export interface RunnerScore {
  score: number;
  breakdown: RunnerScoreBreakdown;
}

export interface RunnerScoreInput {
  float_m: number | null;
  rel_vol_5min: number | null;       // % — 100 = a typical 5-minute volume slice
  rel_volume: number | null;         // day relative volume (×)
  catalyst_score: number | null;     // 0..100 impact from the catalyst classifier
  catalyst_direction: CatalystDirection | null;
  change_pct: number | null;
  is_halt: boolean;
}

// Smaller float = more violent move per dollar of buying.
function floatScore(floatM: number | null): number {
  if (floatM == null) return 0;
  if (floatM < 2) return 30;
  if (floatM < 5) return 25;
  if (floatM < 10) return 16;
  if (floatM < 15) return 8;
  return 0;
}

// Volume precedes price — the earliest tell. Lead with the 5-min burst; fall
// back to day relative volume when the 5-min window hasn't filled yet.
function volumeScore(relVol5m: number | null, relVolDay: number | null): number {
  if (relVol5m != null) {
    if (relVol5m >= 3000) return 35;
    if (relVol5m >= 1000) return 27;
    if (relVol5m >= 500) return 18;
    if (relVol5m >= 200) return 8;
  }
  if (relVolDay != null && relVolDay >= 10) return 6;
  return 0;
}

// A catalyst only counts toward an *up*-runner if it's bullish. A bearish
// catalyst (bankruptcy, offering, probe) is *why* a stock is falling — it must
// not lift the score. Neutral/mixed get partial credit (news is news).
function catalystScore(score: number | null, direction: CatalystDirection | null): number {
  if (score == null || direction === 'bearish') return 0;
  const weight = direction === 'bullish' ? 0.25 : 0.10;
  return Math.round(score * weight);
}

// The move so far: penalize already-extended up-moves (we want ignition, not
// exhaustion) and — heavily — down-moves (a stock crashing is not a runner).
function changeScore(changePct: number | null): number {
  const c = changePct ?? 0;
  if (c >= 300) return -20;
  if (c >= 150) return -12;
  if (c >= 80) return -5;
  if (c >= 0) return 0;
  if (c <= -15) return -35;   // crashing — disqualify
  return -12;                 // red
}

export function scoreRunner(i: RunnerScoreInput): RunnerScore {
  const breakdown: RunnerScoreBreakdown = {
    float: floatScore(i.float_m),
    volume: volumeScore(i.rel_vol_5min, i.rel_volume),
    catalyst: catalystScore(i.catalyst_score, i.catalyst_direction),
    earliness: changeScore(i.change_pct),
    halt: i.is_halt ? 12 : 0,
  };
  const raw =
    breakdown.float + breakdown.volume + breakdown.catalyst + breakdown.earliness + breakdown.halt;
  return { score: Math.max(0, Math.min(100, Math.round(raw))), breakdown };
}

// Composite "runner score" for the Ignition screener — fuses the structural and
// signal inputs of a low-float momentum ignition into a single 0–100 number.
// Pure + deterministic. See docs/ignition-screener-spec.md §3 for the weights.
//
// Recalibrated 2026-06-12 against 22 days of forward-return outcomes
// (screener_outcomes). The study found the old score under-scored its own best
// cohort — fresh, regular-hours ignitions up 25–100% intraday scored ~45 (below
// the alert line) yet returned +14.9%/1d and HELD +14%/5d, while the score spent
// its points on catalyst impact + shelf risk, both of which were miscalibrated
// for the 1-day horizon. The rebalance: reward the move-maturity sweet spot,
// penalize pre-market exhaustion, lean on day relative volume, make catalyst a
// type-aware modifier (not an impact booster), and drop the inverted shelf
// penalty. See the per-function notes and the spec for the evidence.

import type { CatalystDirection } from '../db/types.js';
import type { ShelfLevel } from './shelf.js';

export interface RunnerScoreBreakdown {
  float: number;
  volume: number;
  catalyst: number;
  maturity: number;   // intraday move maturity (was "earliness"; now rewards the sweet spot)
  premarket: number;  // pre-market exhaustion penalty
  shelf: number;
}

export interface RunnerScore {
  score: number;
  breakdown: RunnerScoreBreakdown;
}

export interface RunnerScoreInput {
  float_m: number | null;
  rel_vol_5min: number | null;       // % — 100 = a typical 5-minute volume slice
  rel_volume: number | null;         // day relative volume (×)
  catalyst_type: string | null;      // the classifier's catalyst_type (drives the catalyst score)
  catalyst_direction: CatalystDirection | null;
  change_pct: number | null;
  seen_in_premarket: boolean;        // did this ticker already trade in pre-market today
  shelf_level: ShelfLevel | null;    // effective shelf / dilution risk (informational; only 'active' drags)
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

// Volume precedes price — the earliest tell. Lead with the 5-min burst, but
// it's null/0 ~40% of the time (pre-market, and the first cycle a name appears),
// so fall back to day relative volume — which the outcome data shows is itself a
// clean monotonic predictor (day-RVol 25×+ → +4.4%/1d, the 2–3× gate floor is
// dead at +0.2%). Take the stronger of the two reads. Max 30.
function volumeScore(relVol5m: number | null, relVolDay: number | null): number {
  let v5 = 0;
  if (relVol5m != null) {
    if (relVol5m >= 3000) v5 = 30;
    else if (relVol5m >= 1000) v5 = 24;
    else if (relVol5m >= 500) v5 = 16;
    else if (relVol5m >= 200) v5 = 7;
  }
  let vd = 0;
  if (relVolDay != null) {
    if (relVolDay >= 25) vd = 24;
    else if (relVolDay >= 10) vd = 14;
    else if (relVolDay >= 5) vd = 7;
    else if (relVolDay >= 3) vd = 3;
  }
  return Math.max(v5, vd);
}

// Type-aware catalyst (−15..+15). The outcome study was unambiguous: catalyst
// *type* predicts the 1-day move, raw impact_score does not — high-impact /
// high-urgency news actually trended NEGATIVE for ignitions. So this is a
// type-keyed modifier, not the old impact×direction booster:
//   • offering/dilution & bankruptcy actively DRAG — a 424B is *why* it's
//     selling (offering_dilution was −8.3%/1d);
//   • M&A / legal, then partnership / contract / 13D-G / earnings underperform
//     (the target caps the move, the PR fades) → graded penalty;
//   • FDA/clinical is the one type that HELD multi-day (+14.6%/1d, +12%/5d) → premium;
//   • trade halts are a real same-session catalyst (T1 news-pending strongest);
//   • everything else — generic PR, recaps, crypto/AI theme, 8-Ks, and notably
//     catalyst *absence* (the single best alert cell at +7.7%/1d) — is neutral,
//     so 0, never a penalty.
function catalystScore(type: string | null, direction: CatalystDirection | null): number {
  switch (type) {
    case 'offering_dilution':
    case 'bankruptcy':
      return -12;
    case 'merger_acquisition':
    case 'legal_regulatory':
      return -8;
    case 'partnership':
    case 'contract_order':
    case 'ownership_change':
    case 'earnings_guidance':
      return -5;
    case 'fda_clinical':
      return 14;
    case 'halt_news_pending':
      return 10;
    case 'halt_news':
      return 8;
    case 'halt_volatility':
    case 'halt_info_requested':
      return 4;
  }
  // Any other bearish-direction catalyst (e.g. halt_regulatory, a bearish
  // generic headline) still drags. Unknown / neutral / no catalyst = neutral.
  if (direction === 'bearish') return -8;
  return 0;
}

// Move maturity at the moment we flag it. The outcomes carved a clear sweet
// spot: a name already up 25–100% intraday is the strongest cohort (+6.7..7.4%/1d
// and it HOLDS), while 0–25% is dead, >100% is a blow-off that fades, and any red
// print is a non-runner. Reward the band; penalize the extremes. (The old
// "earliness" only ever penalized — it gave the 25–100% band a flat 0 and so
// never lifted the exact cohort that runs.)
function maturityScore(changePct: number | null): number {
  const c = changePct ?? 0;
  if (c <= -15) return -25;   // crashing — disqualify
  if (c < 0) return -12;      // red — not a runner
  if (c < 25) return 0;       // just off the gate — neutral
  if (c < 100) return 12;     // sweet spot — established, not parabolic
  if (c < 150) return -6;     // extended
  if (c < 300) return -15;    // late
  return -25;                 // blow-off
}

// Pre-market exhaustion. A name that already ran in pre-market gives back into
// the close: the outcome split is stark — a fresh regular-hours ignition up
// 25–100% did +14.9%/1d, the *same* move that had traded pre-market did 0.0%.
// Penalize, don't disqualify (a clean PM gap with real volume can still score).
function premarketScore(seenInPremarket: boolean): number {
  return seenInPremarket ? -8 : 0;
}

// Dilution penalty — only an *active* offering (a 424B* in the last 90 days,
// i.e. shares being sold right now). The old code also penalized 'effective'
// and 'shelf', but those names OUT-performed at the 1-day horizon: an effective
// shelf is a multi-day-runner kill-switch, not a same-session signal. It still
// rides the row + Telegram as a ⚠️, it just no longer drags the ignition score.
function shelfScore(level: ShelfLevel | null): number {
  return level === 'active' ? -5 : 0;
}

export function scoreRunner(i: RunnerScoreInput): RunnerScore {
  const breakdown: RunnerScoreBreakdown = {
    float: floatScore(i.float_m),
    volume: volumeScore(i.rel_vol_5min, i.rel_volume),
    catalyst: catalystScore(i.catalyst_type, i.catalyst_direction),
    maturity: maturityScore(i.change_pct),
    premarket: premarketScore(i.seen_in_premarket),
    shelf: shelfScore(i.shelf_level),
  };
  const raw =
    breakdown.float + breakdown.volume + breakdown.catalyst +
    breakdown.maturity + breakdown.premarket + breakdown.shelf;
  return { score: Math.max(0, Math.min(100, Math.round(raw))), breakdown };
}

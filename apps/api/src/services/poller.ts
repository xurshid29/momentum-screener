// PollerService — the singleton port of screener-poll_breakout.sh.
// One instance per API process. Holds cross-cycle state in memory.
// Single-instance only by design — see CLAUDE.md.

import { sql } from 'kysely';
import { getDb } from '../db/index.js';
import type {
  RowStatus,
  ScreenerFilterSnapshot,
  NewsSource,
  CatalystDirection,
  CatalystUrgency,
  Classifier,
  TradingSession,
} from '../db/types.js';
import { fetchScreener, fetchFinvizNews, type ScreenerRow } from './finviz.js';
import { fetchYahooNews } from './yahoo.js';
import { fetchBenzingaDelta } from './benzinga.js';
import { fetchEdgarFilings, type EdgarFiling } from './edgar.js';
import { fetchHalts, type TradeHalt } from './halts.js';
import { broadcast } from './sse.js';
import { sendTelegram, telegramEnabled, escapeHtml } from './telegram.js';
import { scoreRunner, type RunnerScoreBreakdown } from './runner-score.js';
import type { TickEvent } from './tick-detect.js';
import {
  scoreSwing,
  type SwingScoreBreakdown,
  type SwingSetupFlags,
  type SwingDailyContext,
} from './swing-score.js';
import { shelf, type ShelfInfo } from './shelf.js';
import { dailyBars, getRecentBarsForTickers } from './daily-bars.js';
import { outcomes } from './outcomes.js';
import { getContinuationCandidates, type ContinuationCandidate } from './continuation.js';
import { classifyByRules, type Classification, type ClassifierInput } from './catalyst-rules.js';
import { recordTierEvent } from './tier-events.js';
import { classifyByClaude } from './catalyst-claude.js';

const DEFAULTS: ScreenerFilterSnapshot = {
  // Note: no `sh_float_u50` here. Finviz drops rows with null Float when that
  // filter is active, which excludes legitimate nano-cap candidates (e.g.
  // CNSP) where Finviz hasn't computed a Float value. The float ceiling is
  // enforced post-fetch in finviz.ts using shares_outstanding as a fallback.
  filter: 'ind_stocksonly,sh_price_1to25,sh_relvol_o5,ta_change_20to',
  float_max_m: 35,
  top_n: 50,
  accel_threshold: 2.0,
  interval_sec: 20,
};

// After-hours momentum volume gate. In AH, Finviz freezes relative volume at the
// 4pm close, so toAfterHoursFilter() drops the sh_relvol gate and the
// change-gated momentum screen lets through names that "moved" >5% on a handful
// of AH shares (BLIV +6.8% on 5 shares, GRAN +8.4% on 90). Re-impose a floor on
// our own AH-aware RVol (rel_vol_5min/1min, from AH volume deltas; percent,
// 100 = 1×). Freshly-appeared names are exempt (cold-start: RVol not measurable
// for ~75s). Mirrors IGNITION.ah_rvol_min. AH-only — regular/PM are untouched.
const AH_MOMENTUM = { rvol_min: 100, cold_start_ms: 120_000 };

const DELTA_LOOKBACK_SEC = 1800;

// Ignition screener — a second, volume-led screen run each cycle alongside the
// Momentum one, to catch low-float names in the first minutes of a move.
// See docs/ignition-screener-spec.md.
const IGNITION = {
  filter: 'ind_stocksonly,sh_price_u10,sh_relvol_o2,sh_curvol_o500',
  // Pre-market liquidity is thin: a nano-float ripping +100% can still be
  // sitting below 500K cumulative shares, so the regular-session filter
  // gates it out until the move is mostly over (see the WHLR post-mortem —
  // it first appeared at +146.65% under the standard filter). The pre-market
  // variant drops the volume floor to 100K while keeping the relvol > 2
  // gate so we don't flood with thin-print noise.
  premarket_filter: 'ind_stocksonly,sh_price_u10,sh_relvol_o2,sh_curvol_o100',
  // Raised 15→25M (2026-06-15). A 10-day study found 15–25M names run as hard
  // as the 2–5M cohort and harder than 10–15M (34% reach +40% vs 14%); the
  // band adds ~4.7 ignition-eligible names/day (price<$10, relVol>2), of which
  // a large fraction run. Float is post-filtered in code — Finviz drops
  // null-float rows if it's in the query string. Beyond 25M the edge falls off
  // (25–50M: 12% reach +40%), so 25M is the ceiling. Paired with the
  // runner-score float ladder extension (15–25M → 6 pts) — cap + score move
  // together or higher-float names enter but never score onto the alert line.
  float_max_m: 25,
  top_n: 80,         // fetched from Finviz, then runner-score-ranked
  min_price: 0.10,   // post-filter — sh_price_u10 has no lower bound
  broadcast_n: 25,   // top-N (by runner-score) kept in the SSE payload + persisted
  // Alert threshold on the recalibrated runner-score (2026-06-12). Validated
  // against 22 days of forward outcomes: ≥65 alerts on ~5/day at +13.9%/1d
  // (holds +5.2%/5d) vs the old ≥58 rule's +4.7%/1d that gave back by day 5.
  // Lower thresholds trade conviction for volume (58→~10/day +8.9%/1d).
  alert_score: 65,
  // Suppress alerts when first detection is already too extended to trade.
  // Outcomes set the real cliff at +100%: the 25–100% band is the strongest
  // cohort (the recalibrated score rewards it), but >100% is a blow-off that
  // fades (−6%/1d). The old cap of 40 was set from a tiny 05-21/05-22 sample
  // and suppressed the 40–100% winners (e.g. AKTX entered ~+50% → +255%/1d).
  // We still keep the row in the SSE payload — only the Telegram push is
  // gated, so a name that pulls back under the cap and re-fires gets a fresh
  // second-leg alert.
  alert_entry_chg_max: 100,
  new_window_ms: 120_000,  // a ticker stays flagged "new" for 2 min after first entering the set
  // After-hours only: Finviz freezes relative volume at the 4pm close, so
  // toAfterHoursFilter() (finviz.ts) drops the sh_relvol_o2 gate and the
  // volume-led screen pulls in flat, low-volume names (LNKS +4%/0.2×, SCNI
  // 0%/0.2×…). Re-impose the discriminator with OUR after-hours-aware RVol
  // (rel_vol_5min/1min, computed from the AH volume deltas): an *established*
  // AH ignition (past the new_window_ms cold-start) must show ≥ this much
  // relative volume (percent; 100 = 1×). 100 = the lowest runner-score volume
  // tier — junk reads ~0, real AH movers read 100s–10000s+. AH-only; regular/PM
  // keep Finviz's live relvol gate.
  ah_rvol_min: 100,
  // A transient empty Ignition fetch (the Finviz screener export occasionally
  // fails or returns an empty 200) shouldn't blank the sidebar or reset every
  // "new" flag. Reuse the last good list for up to this long before accepting
  // an empty result as a genuine clear (market close / quiet overnight).
  reuse_max_ms: 180_000,   // 3 min ≈ 9 cycles
};

// Fresh-burst alert — "catch the vertical at first sight". The gap it closes
// (measured 2026-06-12 on the DSY case + a 7-trading-day union replay): a
// runner's move starts BEFORE Finviz's screens return the name (DSY ramped
// ~+10% → +47% pre-sight), and the ignition alert can't fire fast — its volume
// component needs a 5-min read, and a PM name eats the −8 exhaustion penalty
// (DSY topped out at score 64 < 65 while ripping +47 → +134%). So this path
// pings on the union's first minutes instead: nano-float + a violent early
// volume read, before any score has a chance to mature.
//
// Simulated on the 7-day union series: ~12.7 alerts/day (≈10 PM + 3 REG),
// median chg@alert +33%, median +13 pts more within 30 min (p75 +48),
// 47% ≥ +15 pts; would have caught DSY (+77 after alert), CUPR (+76),
// ASBP (+39) on 2026-06-12. To trade alert volume for conviction, raise
// rvol_fast_min — but 15000 already loses DSY (first read 11231).
const FRESH_BURST = {
  // Only the first minutes after a ticker's first sight today (union of
  // screens, restart-safe via the DB-seeded firstSeenAt). After this window
  // the normal columns/score paths have caught up and this alert is just noise.
  window_ms: 180_000,
  // max(rel_vol_1min, rel_vol_5min) — the fastest read available (~20–40s
  // after first sight with the 1-min cold-start). DSY-class first reads run
  // 10k–50k; MASK-class non-starters sit ~600.
  rvol_fast_min: 8000,
  // OR an instant first-cycle day-RVol this high. Day-RVol is meaningless in
  // premarket (DSY printed 0.14–1.05× during its entire vertical — PM volume
  // is tiny vs a full average day), so this branch is regular-session only.
  rvol_day_min: 30,
  float_max_m: 5,   // every measured vertical was ≤ 4.4M float
  chg_min: 10,      // flat volume-led names haven't committed yet
  // Above the cap the start is already missed — GMM alerted at +64 with zero
  // upside left; the sim's winners entered at +28..57.
  chg_max: 80,
};

// New-ignition heads-up (2026-06-16). The operator wants a ping when a fresh
// ignition shows up, but the ≥65 alert fires hours late (fresh names score
// 15–30 — float/volume aren't populated on a ticker's first cycles), and the
// 🚀 fresh-burst alert only covers nano-floats (≤5M). This fills the middle:
// a name *recently appeared* in the ignition set that has built into the
// 40–64 band (below the high-conviction line) while still young. Catches the
// 5–25M movers (post the cap raise) early. ~6–8/day; dial = alert_score.
const NEW_IGNITION = {
  alert_score: 40,             // floor; the ≥65 IGNITION alert owns 65+
  window_ms: 15 * 60 * 1000,   // "recently appeared" — first 15 min in the set today
  chg_min: 10,
  chg_max: 100,
};

// Swing screener — multi-day setups. Runs inside the same 20s poll loop but
// on a much slower cadence (every `cadence_cycles` cycles ≈ 20 min) since
// daily-bar signals don't change intraday. See docs/swing-screener-spec.md.
const SWING = {
  // Universe: $2–$50, avg-vol ≥ 500K (real liquidity), today's RVol ≥ 1.5
  // (real interest today). Float bounds and mcap floor are post-filtered in
  // code since Finviz drops null-field rows when those gates are in-filter.
  filter: 'ind_stocksonly,sh_price_o2,sh_price_u50,sh_avgvol_o500,sh_relvol_o1.5',
  float_min_m: 5,
  float_max_m: 100,
  mcap_min_m: 50,
  top_n: 100,
  broadcast_n: 25,
  cadence_cycles: 60,                  // ~20 min at the 20s interval
  // When the swing list is empty during a session (restart wiped it, or a
  // fetch failed), retry at most this often — NOT every cycle, so a Finviz
  // 429 in the after-hours burst isn't sustained by us hammering every 20s.
  empty_retry_ms: 2 * 60 * 1000,       // 2 min
  // Alert threshold on the recalibrated v2 swing score (2026-06-13, "early
  // volatile breakout"). Validated by reconstruction on 508 full-horizon
  // outcomes: v2 ≥60 → peak_5d +12.1 (17% reach +20, 7% reach +40, ~3.5
  // det/day) vs the old ≥65 set's +2.8 / 0% / 0%. Day-1 fresh crosses at
  // this line peaked +14.4 with the shallowest drawdowns.
  alert_score: 60,
  // Force a refresh once per ET day at/after 16:30 ET — that's when today's
  // close has landed in Finviz quote_export, so the daily-bars service can
  // populate today's complete bar and we can score `close_in_top_q`.
  post_close_minute_et: 16 * 60 + 30,
};

// Continuation list — every Nth cycle re-runs the SQL aggregation. 30 cycles
// at the 20 s base interval ≈ 10 min, well inside the "days seen" signal's
// natural change rate. See services/continuation.ts for the query cost.
const CONTINUATION_REFRESH_CYCLES = 30;

// Dual-signal alert — fires when a ticker on the Continuation list (≥ 2 days
// of Ignition history) also has a meaningful Ignition score *this* cycle.
// That's the CODX-day-2/3 trigger: not the first day's spike (caught by the
// vanilla Ignition alert), but the *confirmation* that the multi-day move is
// real. Score floor is lower than Ignition's 58 because the multi-day prior
// already de-risks the signal. Bullish-only — a continuation candidate that
// also has bearish news landing today is a fade in progress, not a runner.
const DUAL_SIGNAL = {
  min_ignition_score: 40,
};

// A live tick-feed catch surfaced in the dashboard (the 🛰️ section of the
// Ignition sidebar) — a name flagged BEFORE (or as) the move develops. The
// ladder (2026-07-02, +accum 2026-07-05): 'accum' = 🤫 quiet accumulation
// (volume arriving, price still <10% — see ACCUM), 'watch' = 👀 price-led
// early flag (+10% cross, confirmation pending), 'confirmed' = 🛰️
// volume-confirmed ignition (surge rule / sustain read / screen pickup),
// 'faded' = watch expired/gave back (grey, lingers briefly, then pruned).
// See onTickEvent and scanAccumulation.
export type TickCatchStatus = 'accum' | 'watch' | 'confirmed' | 'faded';

export interface TickCatch {
  ticker: string;
  price: number;
  change_pct: number;
  rel_vol: number;
  mom_pct: number;
  status: TickCatchStatus;
  caught_at: string;               // ISO of the first flag (the watch, when there was one)
  confirmed_at: string | null;     // ISO of promotion to confirmed
  watch_change_pct: number | null; // chg% at the watch flag — shows the lead on confirm
}

// News radar — a fresh catalyst landing on a KNOWN runner (a ticker from our
// momentum/ignition history) that is NOT currently on any screen. Measured on
// 30 days of detections: when a headline precedes an ignition, the move
// typically starts minutes after the wire (median news→detection lag 7.9 min,
// p75 91 min). The radar surfaces the name inside that window, arms the tick
// feed (TickFeedService subscribes payload.news_radar tickers), and escalates
// to "moving" the moment the tick detector or a screen picks the name up.
// Display-first; Telegram only for strong/major non-bearish catalysts.
const NEWS_RADAR = {
  history_days: 30,   // "known runner" = seen on momentum/ignition within this window
  ttl_min: 90,        // entry lifetime (p75 of the news→detection lag ≈ 91 min)
  max_display: 12,    // sidebar cap — keep the section glanceable
};

// Quiet-accumulation tier (🤫) — the earliest state in the LIVE TICKS ladder
// (accum → 👀 watch → 🛰️ confirmed). Measured 2026-07-05 (55d cohort study, see
// HANDOVER entry QVOL): a name arriving on a screen still QUIET on price
// (chg 0..10%) but with strong early volume (fast RVol ≥ 10× within its first
// minutes) is ~3–7× likelier to put in a ≥+20pt move than quiet names without
// the volume (AH: 20–25% vs 3%; PM/REG: 12–14% vs 3–12%), and the state
// precedes the +10% tick-watch line by minutes-to-hours (USDE 2026-07-01:
// flagged +6.97% / 21× day-RVol at 16:04 ET, launched 17:48). This is the
// operator's "EMA cross + rising MACD on flat candles" observation reduced to
// the measurable thing that carries it: volume before price.
const ACCUM = {
  chg_min: 0,           // % — non-negative...
  chg_max: 10,          // ...but still under the tick-watch line
  fast_rv_min: 1000,    // % — max(rv1m, rv5m) ≥ 10× (the measured cohort cut)
  // Persistence gate (2026-07-07 feature study, 55d cohort): requiring the
  // hot-volume state on ≥3 cycles within the window lifts promotion 53%→65%
  // and the ≥+20pt rate 17%→24% while cutting flags ~40% — what it cuts is
  // the one-print blips (35%/7%). Day-1 live agreed: USEA's transient 223×
  // spike fizzled, BJDX's sustained 12× ran +68pts.
  min_hot_cycles: 3,
  window_min: 10,       // only within the first N min after first sight today
                        // (the cohort was measured at first appearance — a
                        // pulled-back spike at +8% later in the day is NOT
                        // quiet accumulation)
  ttl_min: 120,         // display TTL; expiry is logged for outcome grading
  // Telegram: sustained accumulation WITH a bullish catalyst — the
  // highest-conviction measurable slice (72% promote / 30% ≥+20pts, ~1.6/day).
  // The original fastRV≥3000 gate was measured backwards on day 1 (magnitude
  // beyond the threshold doesn't rank winners) and is retired.
};

// Evidence gate for the 👀 watch tier (2026-07-07, operator report + day-1
// scorecard): a +10% cross reached by an hours-long drift (mid/large caps on
// a sector day, multi-day grinders — VSTM/ADCT/FBRX/BZFD all crossed at ≤2×
// rv and ~0%/60s) is not an ignition start; it polluted the LIVE TICKS list
// and the push channel. A watch must show evidence AT the cross: relative
// volume vs the name's own quiet baseline, OR the move happening right now.
// Every watch that mattered on day 1 passed (JLHL 5.3×/+5%, NIVF 63×, LGPS
// 45×…); the drift class had neither and faded. Gated in the POLLER so the
// detector's anchor still plants — surge/sustain confirms stay fully live
// for suppressed names (suppressions are logged for grading the cost).
const TICK_WATCH_EVIDENCE = {
  rel_vol_min: 3,   // × quiet baseline at the cross, OR…
  mom_min: 3,       // …%/60s — the cross is happening NOW
};

export interface NewsRadarItem {
  ticker: string;
  source: NewsSource;
  title: string;
  url: string;
  published_at: string | null;
  first_seen_at: string;          // when the radar picked it up
  impact: number;
  hype: number;
  direction: CatalystDirection;
  urgency: CatalystUrgency;
  catalyst_type: string;
  classifier: Classifier;
  status: 'news' | 'moving';
  escalated_at: string | null;
  escalated_via: 'tick' | 'screen' | null;
  // Prior-session close (daily_bars) — lets TickFeedService arm the detector
  // for names outside the structural universe. Plumbing; the UI ignores it.
  prior_close: number | null;
}

// 📈 EMA-cross layer — an EMA(6/50) bullish crossover on 5m bars nominated a
// known runner; it shows as 'observing' for the ~30-min window and flips to
// 'confirmed' when volume expands vs its sibling candles with price holding
// (the operator's manual TV loop, automated). Unconfirmed nominations are
// pruned silently. See services/ema-cross.ts + onEmaCrossEvent.
export interface EmaCrossItem {
  ticker: string;
  status: 'observing' | 'confirmed';
  price: number;
  cross_price: number;
  vol_ratio: number;      // latest bar volume / sibling median
  cross_at: string;
  confirmed_at: string | null;
}

export interface CyclePayload {
  cycle_id: string;
  polled_at: string;
  session: TradingSession;
  config: ScreenerFilterSnapshot;
  rows: EnrichedRow[];
  banners: {
    new_with_catalyst: string[];
    fresh_news: string[];
  };
  fresh_news: NewsHeadline[];
  ignition: IgnitionRow[];
  swing: SwingRow[];
  continuation: ContinuationCandidate[];
  tick_catches: TickCatch[];
  news_radar: NewsRadarItem[];
  ema_crosses: EmaCrossItem[];
}

export interface EnrichedRow extends ScreenerRow {
  status: RowStatus;
  prev_change_pct: number | null;
  accel_delta: number | null;
  // ISO timestamp of when this ticker first appeared in any screen today
  // (cleared at midnight ET). Drives the Momentum table's "appeared" column.
  first_seen_at: string;
  // Composite "activity now" score (0..100) — freshness + acceleration + VWAP
  // reclaim + above-VWAP + 5m-RVol + fresh news. Drives the optional Heat sort
  // so fresh/rising names surface above stale big-Chg% leaders.
  heat: number;
  // True the cycle price crosses from below VWAP to at/above it — the timed
  // "bad → good" reclaim. Drives a ↑VWAP badge.
  vwap_reclaim: boolean;
  vol_5min: number | null;          // 5-min-equivalent traded volume (extrapolated during a ticker's first ~5 min)
  rel_vol_5min: number | null;      // (vol_5min / (avg_volume / 78)) * 100
  // 1-min relative volume — "is the burst live RIGHT NOW". Same construction
  // on a 60s window (baseline = avg_volume / 390 one-min slices). Faster and
  // choppier than the 5-min read; the two carry independent signal (see the
  // 2026-06-12 RVol study in docs/web-dashboard.md). Cold-start extrapolated
  // from ~20s of samples (a fresh ripper is measurable on its second cycle);
  // null on a ticker's very first cycle and after an on-screen gap.
  rel_vol_1min: number | null;
  // Change% now minus change% ~1 min ago — the local price direction that
  // gives the (direction-blind) 1-min RVol its sign in the UI: a hot burst
  // with this ≤ −2 is sell-side pressure (distribution/shakeout prints).
  // Null until a ticker has ~60s of samples or after an on-screen gap.
  chg_delta_1min: number | null;
  // Anchored VWAP since the ticker first appeared *today*. Computed in-memory
  // from cycle-to-cycle volume deltas × the per-cycle price; restart-safe
  // (rebuilt from today's persisted cycles on boot). Persists across
  // PM → regular → AH within a single ET day so a pre-market spike's volume
  // keeps weighting the indicator into the regular session. ≈ a chart's
  // "Session" VWAP only when the name has been screening since the session
  // start — a name first sighted mid-move gets an anchored-at-detection VWAP
  // (pre-sight volume is unknowable from the screen exports). Null on the
  // first cycle (no delta yet) and whenever price or volume is missing.
  vwap: number | null;
  above_vwap: boolean | null;
  is_fresh_news: boolean;
  has_today_news: boolean;
  news_title: string | null;
  news_source: NewsSource | null;
  news_url: string | null;
  finviz_url: string;
  catalyst: CatalystInfo | null;
  // Effective-shelf / dilution status from a 12-month SEC submissions lookback.
  // The runner's kill-switch — see services/shelf.ts.
  shelf: ShelfInfo | null;
}

// A Momentum-style enriched row plus its Ignition-screener runner-score.
export interface IgnitionRow extends EnrichedRow {
  runner_score: number;
  score_breakdown: RunnerScoreBreakdown;
  // True for the first ~2 minutes a ticker is in the Ignition set — drives the
  // sidebar's pinned "New" section so a fresh low-score name isn't buried.
  is_new: boolean;
}

// A Momentum-style enriched row plus its Swing-screener score and the
// daily-bar context snapshot the score was computed from.
export interface SwingRow extends EnrichedRow {
  swing_score: number;
  score_breakdown: SwingScoreBreakdown;
  setup_flags: SwingSetupFlags;
  daily_context: SwingDailyContext;
}

export interface CatalystInfo {
  score: number;
  hype: number;
  urgency: CatalystUrgency;
  direction: CatalystDirection;
  type: string;
  reason: string;
  risk_flags: string[];
  classifier: Classifier;
}

export interface NewsHeadline {
  ticker: string;
  source: NewsSource;
  title: string;
  url: string;
  published_at: string | null;
  secForm?: string;     // SEC form type — set only when source === 'sec'
  haltReason?: string;  // Nasdaq halt reason code — set only when source === 'halt'
}

class PollerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private firstPoll = true;
  private config: ScreenerFilterSnapshot = { ...DEFAULTS };

  // Cross-cycle state (the equivalents of PREV_FILE / BZ_HEADLINE_CACHE / BZ_TS_FILE).
  private prevChange = new Map<string, number>();      // ticker -> last seen change%
  // First time (epoch ms) each ticker appeared in *any* screen today. Surfaced
  // as EnrichedRow.first_seen_at so the Momentum table can show when a name
  // first showed up — a +600% name that ripped at 01:00 ET shouldn't read the
  // same as a fresh mover. Cleared at midnight ET (NOT at session boundaries —
  // "first seen today" spans PM → regular → AH).
  private firstSeenAt = new Map<string, number>();
  // Per-ticker rolling volume samples (timestamp seconds, cumulative day volume).
  // Used to compute the last-5-minutes volume diff. Trimmed to ~10 minutes deep.
  private volHistory = new Map<string, Array<{ ts: number; volume: number }>>();
  // Short rolling change% history per ticker — feeds chg_delta_1min (the
  // local price direction paired with the 1-min RVol). Same lifecycle as
  // volHistory: appended per enriched cycle, trimmed, cleared at session
  // boundaries (the change% basis swaps there).
  private chgHistory = new Map<string, Array<{ ts: number; chg: number }>>();
  // Per-ticker anchored VWAP tallies. cumPxVol and cumVol accumulate
  // (Δvolume × price) across cycles since first detection *today*; lastVolume
  // is the previous cycle's cumulative day volume, used to derive the delta.
  // Persists across PM → regular → AH so a pre-market spike's volume keeps
  // weighting the VWAP into regular hours. Reset at midnight ET only, and
  // rebuilt from today's persisted cycles on boot (seedVwapState) so deploys
  // don't re-anchor every VWAP mid-day.
  private vwapState = new Map<string, { cumPxVol: number; cumVol: number; lastVolume: number }>();
  // Previous cycle's above-VWAP state per ticker, for detecting a reclaim
  // (below → above) the cycle it happens. Same lifecycle as vwapState.
  private prevAboveVwap = new Map<string, boolean>();
  private bzHeadlineCache = new Map<string, NewsHeadline>(); // ticker -> latest headline (any source merged)
  private bzWatermark = Math.floor(Date.now() / 1000) - DELTA_LOOKBACK_SEC;
  // SEC EDGAR + Nasdaq halts are delta feeds too — a watermark per source
  // tells us which filings/halts are new this cycle (i.e. audio-worthy).
  private secWatermark = Math.floor(Date.now() / 1000) - DELTA_LOOKBACK_SEC;
  private haltWatermark = Math.floor(Date.now() / 1000) - DELTA_LOOKBACK_SEC;
  private lastEtDate = '';
  // News-day marker — rolls at 04:00 ET, not midnight (see runCycle).
  private lastNewsDayEt = '';
  private lastSession: TradingSession | null = null;
  // Per-article-URL classification cache. Lets the LLM classifier
  // overwrite the rule-based score in-place; the next cycle's payload
  // automatically picks up the refined verdict without a DB read.
  // `needsLLM` is set when the rule-based result is written and
  // cleared once OpenAI has refined (or once we've tried and failed).
  private classificationCache = new Map<string, {
    classification: Classification;
    classifier: Classifier;
    articleId?: string;
    needsLLM: boolean;
    input: ClassifierInput;
  }>();
  private llmInFlight = false;
  // Article URLs already pushed to Telegram — alert once per article.
  // Cleared at midnight ET.
  private alertedUrls = new Set<string>();
  // Tickers already Telegram-alerted from the Ignition screener today.
  private alertedIgnition = new Set<string>();
  // First-seen time (epoch ms) per ticker currently in the Ignition set —
  // drives the sidebar's "New" section. Self-maintaining: only currently
  // present tickers are kept, so a ticker that leaves and returns re-counts
  // as new, and no daily/session clear is needed.
  private ignitionFirstSeen = new Map<string, number>();
  // Last successfully-scored Ignition list + when it was computed. Reused for
  // up to IGNITION.reuse_max_ms when a cycle's Finviz ignition fetch comes back
  // empty (a transient hiccup) so the sidebar doesn't blank and the "new" flags
  // don't all reset on recovery.
  private lastIgnition: IgnitionRow[] = [];
  private lastIgnitionAt = 0;
  // Swing screener cadence — fetch + score every SWING.cadence_cycles cycles
  // (~20 min) plus a forced 16:30 ET post-close refresh. Between scans we
  // re-broadcast lastSwingRows unchanged.
  private swingCounter = 0;
  private lastSwingRows: SwingRow[] = [];
  private lastSwingComputedAt = 0;
  // When we last *attempted* a swing scan (epoch ms). Bounds the empty-list
  // recovery retry so a persistently-empty swing (e.g. Finviz 429 in the AH
  // burst) doesn't re-fire the multi-call fetch every 20s and sustain the
  // rate-limit. See SWING.empty_retry_ms.
  private lastSwingAttemptMs = 0;
  private lastForcedSwingPostCloseDate = '';
  // ET date the daily outcome-tracking job last ran. Fired once per ET day from
  // the post-close window (after the daily-bars refresh, so today's close has
  // landed). Reset at midnight ET. See services/outcomes.ts.
  private lastOutcomesDate = '';
  // Tickers already Telegram-alerted from the Swing screener today.
  private alertedSwing = new Set<string>();
  // Tickers already Telegram-alerted from the Continuation dual-signal today.
  private alertedDualSignal = new Set<string>();
  // Tickers already Telegram-alerted as a fresh burst today. See FRESH_BURST.
  private alertedFreshBurst = new Set<string>();
  // Tickers already Telegram-alerted as a new ignition today. See NEW_IGNITION.
  private alertedNewIgnition = new Set<string>();
  // Tickers already Telegram-alerted as a CONFIRMED tick catch today (🛰️).
  // Separate from `tickCatches` (15-min display TTL) so a re-catch after the
  // dashboard row ages out doesn't re-ping — once per ticker per ET day.
  private alertedTickCatch = new Set<string>();
  // Tickers already Telegram-alerted as a tick WATCH today (👀). Independent of
  // the confirm dedup — a real runner gets exactly two pings: flag + confirm.
  private alertedTickWatch = new Set<string>();
  // Live tick-feed catches today, keyed by ticker. Surfaced in the dashboard's
  // 🛰️ section; pruned by status-aware TTLs in the payload build. last_event_ms
  // tracks the latest transition (watch/confirm/fade) for those TTLs;
  // screened_at_watch records whether a screen ALREADY held the name when the
  // watch was flagged — if so, screen presence is not fresh volume evidence
  // and must not promote the watch (only surge/sustain can). accum_entry_chg /
  // accum_peak carry the 🤫 tier's grading telemetry (entry vs peak while
  // flagged) for the expiry/promotion logs.
  private tickCatches = new Map<string, TickCatch & {
    last_event_ms: number;
    screened_at_watch?: boolean;
    accum_entry_chg?: number;
    accum_peak?: number;
  }>();
  // Quiet-accumulation dedup — once per ticker per ET day (see ACCUM), plus
  // the Telegram-side dedup for the tight-gate 🤫 push, plus the persistence
  // counter (cycles observed hot within the first-sight window).
  private accumSeen = new Set<string>();
  private alertedAccum = new Set<string>();
  private accumHotCycles = new Map<string, number>();
  // 📈 EMA-cross layer entries (observing/confirmed), keyed by ticker.
  // Display-only; graded via tier_events (tier='cross'). Cleared at midnight.
  private emaCrosses = new Map<string, EmaCrossItem & { last_event_ms: number }>();
  // Tickers that have traded in an Ignition pre-market cycle today. Feeds the
  // runner-score's pre-market-exhaustion penalty (a name that already ran in PM
  // gives back into the close). ET-day concept — cleared at midnight.
  private seenInPremarketToday = new Set<string>();
  // News radar (📰) — see NEWS_RADAR. Active entries keyed by ticker; article
  // URLs already radar'd today; tickers already Telegram-alerted today; and
  // the "known runner" set (DB-seeded from 30d of momentum/ignition history,
  // grown live as names screen).
  private newsRadar = new Map<string, NewsRadarItem & { first_seen_ms: number }>();
  private radarSeenUrls = new Set<string>();
  private alertedNewsRadar = new Set<string>();
  private radarHistory = new Set<string>();
  // Continuation list cache. The SQL aggregation over 5 days of ignition_results
  // costs ~1.5 s on the prod-sized dataset — too much for every 20 s cycle.
  // Refresh every CONTINUATION_REFRESH_CYCLES cycles (~10 min) and re-broadcast
  // the cached value in between. The signal updates on the scale of days, so
  // the cache freshness is more than enough.
  private continuationCounter = 0;
  private lastContinuation: ContinuationCandidate[] = [];
  private lastContinuationComputedAt = 0;
  // Runtime mute for Telegram alerts — toggled by the bot's /alerts command.
  // Resets to false on restart by design (no persistence — the dashboard +
  // sidebar still surface everything, this only quiets the push channel).
  private alertsMuted = false;

  // Last full payload, served by /api/screener/latest for new clients.
  private lastPayload: CyclePayload | null = null;

  status() {
    return {
      running: this.running,
      first_poll: this.firstPoll,
      session: this.lastSession,
      tracked_tickers: this.prevChange.size,
      cached_headlines: this.bzHeadlineCache.size,
      bz_watermark: this.bzWatermark,
      sec_watermark: this.secWatermark,
      halt_watermark: this.haltWatermark,
      swing: {
        cycle_counter: this.swingCounter,
        cached_rows: this.lastSwingRows.length,
        last_computed_at: this.lastSwingComputedAt
          ? new Date(this.lastSwingComputedAt).toISOString()
          : null,
        last_post_close_refresh: this.lastForcedSwingPostCloseDate || null,
      },
      continuation: {
        cycle_counter: this.continuationCounter,
        cached_rows: this.lastContinuation.length,
        last_computed_at: this.lastContinuationComputedAt
          ? new Date(this.lastContinuationComputedAt).toISOString()
          : null,
      },
      telegram_enabled: telegramEnabled(),
      config: this.config,
    };
  }

  setConfig(partial: Partial<ScreenerFilterSnapshot>) {
    this.config = { ...this.config, ...partial };
    void this.persistConfig();
  }

  getConfig(): ScreenerFilterSnapshot {
    return { ...this.config };
  }

  // Restore the persisted config (screener_settings holds a single row).
  // Falls back to the code DEFAULTS when nothing has been saved yet.
  private async loadConfig() {
    try {
      const row = await getDb()
        .selectFrom('screener_settings')
        .select('config')
        .where('id', '=', 1)
        .executeTakeFirst();
      if (row?.config) {
        this.config = { ...DEFAULTS, ...row.config };
        console.log(`[poller] restored saved config — filter: ${this.config.filter}`);
      }
    } catch (err) {
      console.error('[poller] could not load saved config, using defaults:', err);
    }
  }

  // Upsert the single global config row so the live filter survives restarts.
  private async persistConfig() {
    try {
      await getDb()
        .insertInto('screener_settings')
        .values({ id: 1, config: JSON.stringify(this.config), updated_at: new Date() })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            config: JSON.stringify(this.config),
            updated_at: new Date(),
          }),
        )
        .execute();
    } catch (err) {
      console.error('[poller] could not persist config:', err);
    }
  }

  getLastPayload(): CyclePayload | null {
    return this.lastPayload;
  }

  // Is the ticker in the known-runner set (30d momentum/ignition history)?
  // Used by the tick feed to scope the 📈 EMA-cross layer.
  isKnownRunner(ticker: string): boolean {
    return this.radarHistory.has(ticker);
  }

  // 📈 EMA-cross layer events (see services/ema-cross.ts): a 6/50 bullish
  // cross on 5m bars nominates a known runner for a ~30-min observation;
  // volume expansion vs sibling candles confirms it; no expansion → silent
  // prune. Display-only (dashboard soft ping on confirm via the web hook);
  // no Telegram until tier_events grades the layer. Names already in the
  // LIVE TICKS ladder skip display — the ladder outranks a nomination.
  onEmaCrossEvent(e: import('./ema-cross.js').EmaCrossEvent): void {
    const nowMs = Date.now();
    if (e.type === 'nominate' || (e.type === 'confirm' && !this.emaCrosses.has(e.ticker))) {
      const inLadder = this.tickCatches.has(e.ticker);
      recordTierEvent('cross', e.type, e.ticker, {
        price: e.price, cross_price: e.cross_price, vol_ratio: e.vol_ratio,
        bars: e.bars_since_cross, in_ladder: inLadder,
      });
      console.log(
        `[ema-cross] ${e.type === 'confirm' ? '📈✅ instant-confirm' : '📈 nominate'} ${e.ticker} ` +
        `$${e.price.toFixed(2)} · ${e.vol_ratio}x sibling vol${inLadder ? ' · (in ladder — display skipped)' : ''}`,
      );
      if (inLadder) return;
      // Timestamps use the BAR's close time, not processing wall-clock, so
      // the row's "ago" matches what the operator sees on a TV chart
      // (2026-07-15, the OPTX confusion — TV labels bars by OPEN time, we
      // close them; don't add processing skew on top).
      const barIso = new Date(e.ts_sec * 1000).toISOString();
      this.emaCrosses.set(e.ticker, {
        ticker: e.ticker,
        status: e.type === 'confirm' ? 'confirmed' : 'observing',
        price: e.price,
        cross_price: e.cross_price,
        vol_ratio: e.vol_ratio,
        cross_at: barIso,
        confirmed_at: e.type === 'confirm' ? barIso : null,
        last_event_ms: nowMs,
      });
      return;
    }
    const existing = this.emaCrosses.get(e.ticker);
    if (e.type === 'confirm') {
      recordTierEvent('cross', 'confirm', e.ticker, {
        price: e.price, cross_price: e.cross_price, vol_ratio: e.vol_ratio, bars: e.bars_since_cross,
      });
      console.log(
        `[ema-cross] 📈✅ confirm ${e.ticker} $${e.price.toFixed(2)} · ${e.vol_ratio}x sibling vol · ` +
        `${e.bars_since_cross} bars after the cross ($${e.cross_price.toFixed(2)})`,
      );
      if (existing) {
        existing.status = 'confirmed';
        existing.price = e.price;
        existing.vol_ratio = e.vol_ratio;
        existing.confirmed_at = new Date(e.ts_sec * 1000).toISOString();
        existing.last_event_ms = nowMs;
      }
      return;
    }
    // expire — the observation window ran out without expansion.
    recordTierEvent('cross', 'expire', e.ticker, {
      cross_price: e.cross_price, peak_ratio: e.peak_ratio ?? null, peak_price: e.peak_price ?? null,
    });
    console.log(
      `[ema-cross] 📉 expire ${e.ticker} — no expansion in ${e.bars_since_cross} bars ` +
      `(peak ${e.peak_ratio ?? '?'}x vol)`,
    );
    if (existing && existing.status === 'observing') this.emaCrosses.delete(e.ticker);
  }

  // Is the ticker in the latest broadcast's Momentum or Ignition lists? Used
  // to suppress redundant tick-feed WATCH flags (see onTickEvent).
  private isCurrentlyScreened(ticker: string): boolean {
    const p = this.lastPayload;
    if (!p) return false;
    return p.rows.some((r) => r.ticker === ticker) || p.ignition.some((r) => r.ticker === ticker);
  }

  // News radar matching — fresh articles/halts against the known-runner set,
  // excluding names already on a screen (those flow through the existing
  // fresh-news paths). See NEWS_RADAR for the why + the measured lag numbers.
  private updateNewsRadar(
    candidates: Array<{ source: NewsSource; ticker: string; title: string; url: string; published_at: Date | null; haltReason?: string }>,
    onScreen: Set<string>,
  ): void {
    const nowMs = Date.now();
    for (const c of candidates) {
      const tk = c.ticker.toUpperCase();
      if (onScreen.has(tk)) continue;
      if (!this.radarHistory.has(tk)) continue;
      if (this.radarSeenUrls.has(c.url)) continue;
      this.radarSeenUrls.add(c.url);
      if (this.newsRadar.has(tk)) {
        console.log(`[news-radar] extra article for active entry ${tk} (kept first): "${c.title.slice(0, 80)}"`);
        continue;
      }
      // Classify via the same cache-or-rules path as screen rows. No market
      // context (the name isn't screening — no live float/mcap), which skews
      // hype slightly low; the async LLM refinement upgrades scores in place.
      let cached = this.classificationCache.get(c.url);
      if (!cached) {
        const input: ClassifierInput = {
          ticker: tk,
          title: c.title,
          source: c.source,
          haltReason: c.haltReason ?? null,
          marketContext: null,
        };
        const cls = classifyByRules(input);
        cached = {
          classification: cls,
          classifier: 'rules',
          needsLLM: !!process.env.ANTHROPIC_API_KEY && c.source !== 'sec' && c.source !== 'halt',
          input,
        };
        this.classificationCache.set(c.url, cached);
      }
      const cls = cached.classification;
      // Bearish catalysts (offerings, probes) are why a stock FALLS — not a
      // pre-move opportunity. Neutral (e.g. T1 halt) and bullish both radar.
      if (cls.direction === 'bearish') {
        console.log(`[news-radar] skip ${tk} — bearish (${cls.catalyst_type}): "${c.title.slice(0, 80)}"`);
        continue;
      }
      const item: NewsRadarItem & { first_seen_ms: number } = {
        ticker: tk,
        source: c.source,
        title: c.title,
        url: c.url,
        published_at: c.published_at?.toISOString() ?? null,
        first_seen_at: new Date(nowMs).toISOString(),
        first_seen_ms: nowMs,
        impact: cls.impact_score,
        hype: cls.hype_score,
        direction: cls.direction,
        urgency: cls.urgency,
        catalyst_type: cls.catalyst_type,
        classifier: cached.classifier,
        status: 'news',
        escalated_at: null,
        escalated_via: null,
        prior_close: null,
      };
      this.newsRadar.set(tk, item);
      console.log(
        `[news-radar] 📰 hit ${tk} — impact ${cls.impact_score} · hype ${cls.hype_score} · ${cls.catalyst_type} (${c.source}): "${c.title.slice(0, 100)}"`,
      );
      recordTierEvent('radar', 'hit', tk, {
        impact: cls.impact_score, hype: cls.hype_score, type: cls.catalyst_type,
        source: c.source, url: c.url, title: c.title.slice(0, 140),
      });
      // Prior close for tick-feed arming (best-effort, async — TickFeedService
      // picks it up from the payload on its next 30s sync).
      void this.lookupPriorClose(tk).then((pc) => {
        const e = this.newsRadar.get(tk);
        if (e && e.url === c.url && pc != null) e.prior_close = pc;
      });
      // Telegram — same conviction gate as the fresh-news path: strong/major,
      // non-bearish (already ensured), once per ticker per ET day.
      if (
        telegramEnabled() && !this.alertsMuted &&
        (cls.urgency === 'strong' || cls.urgency === 'major') &&
        !this.alertedNewsRadar.has(tk)
      ) {
        this.alertedNewsRadar.add(tk);
        void sendTelegram(formatNewsRadarAlert(item));
      }
    }
  }

  // Latest stored daily close for a ticker — the prior-session close the tick
  // detector measures change% against. Names in our 30d history almost always
  // have daily_bars coverage (outcome tracking backfills them). Public: the
  // tick feed uses it to anchor after-hours screen-row subscriptions too.
  async lookupPriorClose(ticker: string): Promise<number | null> {
    try {
      const row = await getDb()
        .selectFrom('daily_bars')
        .select('close')
        .where('ticker', '=', ticker)
        .orderBy('date', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row?.close != null && Number(row.close) > 0 ? Number(row.close) : null;
    } catch {
      return null;
    }
  }

  areAlertsMuted(): boolean {
    return this.alertsMuted;
  }

  setAlertsMuted(muted: boolean): void {
    this.alertsMuted = muted;
  }

  // Rebuild firstSeenAt from the DB so a restart/deploy doesn't reset every
  // ticker's "appeared today" to the restart time (the in-memory map is
  // process-local). The authoritative first-appearance is the earliest
  // persisted cycle for the ticker today, across BOTH screens. Without this,
  // every deploy makes the Appeared column read "just now" for names that
  // actually ripped hours earlier.
  private async seedFirstSeen() {
    try {
      const rows = await sql<{ ticker: string; first_ms: number }>`
        select ticker, min(extract(epoch from polled_at) * 1000)::bigint as first_ms
        from (
          select s.ticker, c.polled_at
          from screener_results s join screener_cycles c on c.id = s.cycle_id
          where (c.polled_at at time zone 'America/New_York')::date
                = (now() at time zone 'America/New_York')::date
          union all
          select i.ticker, c.polled_at
          from ignition_results i join screener_cycles c on c.id = i.cycle_id
          where (c.polled_at at time zone 'America/New_York')::date
                = (now() at time zone 'America/New_York')::date
        ) u
        group by ticker
      `.execute(getDb());
      for (const r of rows.rows) {
        this.firstSeenAt.set(r.ticker, Number(r.first_ms));
      }
      console.log(`[poller] seeded first-seen for ${rows.rows.length} tickers from today's history`);
    } catch (err) {
      console.error('[poller] could not seed first-seen (continuing):', err);
    }
  }

  // Rebuild the per-ticker anchored-VWAP tallies from today's persisted cycles
  // so a restart/deploy doesn't silently re-anchor every VWAP at the restart
  // minute. Measured on UBXG after the 2026-06-12 deploys: the live VWAP read
  // 7.36 (anchored at the last restart) vs 8.06 from the true day anchor —
  // price sat on the WRONG side of the ▲/▼ flag, and Heat's above-VWAP/reclaim
  // points ran on the shallow anchor. screener_results stores per-cycle
  // volume + price, so Σ(Δvol × price) over today's rows reproduces the live
  // tally exactly for Momentum-screened tickers. Ignition-only names aren't
  // recoverable (ignition_results carries no volume column) — they cold-start
  // like before.
  private async seedVwapState() {
    try {
      const rows = await sql<{
        ticker: string;
        cum_px_vol: number;
        cum_vol: number;
        last_volume: number;
        last_price: number | null;
      }>`
        with s as (
          select r.ticker, c.polled_at, r.price, r.volume,
                 lag(r.volume) over (partition by r.ticker order by c.polled_at) as pv
          from screener_results r
          join screener_cycles c on c.id = r.cycle_id
          where (c.polled_at at time zone 'America/New_York')::date
                = (now() at time zone 'America/New_York')::date
            and r.volume is not null and r.price > 0
        )
        select ticker,
          coalesce(sum((volume - pv) * price) filter (where volume > pv), 0)::float8 as cum_px_vol,
          coalesce(sum(volume - pv) filter (where volume > pv), 0)::float8 as cum_vol,
          (array_agg(volume order by polled_at desc))[1]::float8 as last_volume,
          (array_agg(price order by polled_at desc))[1]::float8 as last_price
        from s
        group by ticker
      `.execute(getDb());
      let withTally = 0;
      for (const r of rows.rows) {
        const cumPxVol = Number(r.cum_px_vol);
        const cumVol = Number(r.cum_vol);
        // Seed lastVolume even when no delta accumulated yet (single stored
        // row) — the first live cycle then diffs against the stored snapshot
        // instead of burning a cycle re-seeding.
        this.vwapState.set(r.ticker, { cumPxVol, cumVol, lastVolume: Number(r.last_volume) });
        if (cumVol > 0) {
          withTally += 1;
          // Seed the above/below side too, so a genuine below→above cross on
          // the first live cycle still registers as a ↑VWAP reclaim.
          if (r.last_price != null) {
            this.prevAboveVwap.set(r.ticker, Number(r.last_price) >= cumPxVol / cumVol);
          }
        }
      }
      console.log(
        `[poller] seeded VWAP for ${rows.rows.length} tickers (${withTally} with accumulated volume) from today's history`,
      );
    } catch (err) {
      console.error('[poller] could not seed VWAP (continuing):', err);
    }
  }

  // Rebuild ignition cross-cycle state from today's persisted ignition_results
  // so a restart/deploy doesn't (a) flash every current ignition as "new" (the
  // is_new flag keyed off the in-memory ignitionFirstSeen, which reset to the
  // restart time), or (b) re-blast Telegram alerts for names that already
  // alerted today (the dedup sets are in-memory too). Mirrors seedFirstSeen /
  // seedVwapState. Per ticker today: earliest cycle → ignitionFirstSeen; mark
  // every already-seen ticker as new-ignition-alerted (it appeared earlier, so
  // it is NOT new); mark ≥65-peak tickers as ignition-alerted (they had their
  // high-conviction shot — but a name that hasn't crossed 65 yet can still fire
  // post-deploy).
  private async seedIgnitionState() {
    try {
      const rows = await sql<{ ticker: string; first_ms: number; peak_score: number }>`
        select i.ticker,
          min(extract(epoch from c.polled_at) * 1000)::bigint as first_ms,
          max(i.runner_score)::int as peak_score
        from ignition_results i join screener_cycles c on c.id = i.cycle_id
        where (c.polled_at at time zone 'America/New_York')::date
              = (now() at time zone 'America/New_York')::date
        group by i.ticker
      `.execute(getDb());
      for (const r of rows.rows) {
        this.ignitionFirstSeen.set(r.ticker, Number(r.first_ms));
        // Already appeared today → not "new", so it must not re-fire the
        // new-ignition heads-up after a deploy.
        this.alertedNewIgnition.add(r.ticker);
        if (Number(r.peak_score) >= IGNITION.alert_score) this.alertedIgnition.add(r.ticker);
      }
      console.log(
        `[poller] seeded ignition state for ${rows.rows.length} tickers from today's history`,
      );
    } catch (err) {
      console.error('[poller] could not seed ignition state (continuing):', err);
    }
  }

  // Seed the news-radar "known runner" set — every ticker seen on the momentum
  // or ignition screens in the last NEWS_RADAR.history_days. Grown live each
  // cycle as new names screen; also re-radar'd names that already alerted
  // today are seeded so a deploy doesn't re-ping them (mirrors the other
  // restart-safe seeds).
  private async seedRadarHistory() {
    try {
      const rows = await sql<{ ticker: string }>`
        select distinct ticker from (
          select r.ticker from screener_results r
            join screener_cycles c on c.id = r.cycle_id
            where c.polled_at > now() - make_interval(days => ${NEWS_RADAR.history_days}::int)
          union all
          select i.ticker from ignition_results i
            join screener_cycles c on c.id = i.cycle_id
            where c.polled_at > now() - make_interval(days => ${NEWS_RADAR.history_days}::int)
        ) t
      `.execute(getDb());
      for (const r of rows.rows) this.radarHistory.add(r.ticker);
      console.log(`[news-radar] seeded ${this.radarHistory.size} known runners (last ${NEWS_RADAR.history_days}d)`);
    } catch (err) {
      console.error('[news-radar] could not seed history (continuing):', err);
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.loadConfig();
    // Initialise lastEtDate to today BEFORE the first cycle. Otherwise it starts
    // '' and the first runCycle() sees todayEt !== '' → fires the midnight-
    // rollover block, which clears firstSeenAt — wiping the seed we're about to
    // load and re-stamping every ticker to the restart time (the 14:12-on-
    // everything bug). A genuine midnight rollover during runtime still fires
    // normally because lastEtDate will then differ from the new day.
    this.lastEtDate = etDateString(new Date());
    await this.seedFirstSeen();
    await this.seedVwapState();
    await this.seedIgnitionState();
    await this.seedRadarHistory();
    console.log(`[poller] starting (every ${this.config.interval_sec}s)`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.interval_sec * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  private async tick() {
    if (this.inFlight) return; // skip overlap if previous still running
    this.inFlight = true;
    try {
      await this.runCycle();
    } catch (err) {
      console.error('[poller] cycle error:', err);
    } finally {
      this.inFlight = false;
    }
  }

  private async runCycle() {
    const now = new Date();
    const todayEt = etDateString(now);
    const session = currentEtSession(now);
    // The NEWS day rolls at 04:00 ET (premarket start), not midnight. The
    // closed session (00:00–04:00 ET) belongs to the trading day that just
    // finished — the board still shows that day's change%, so stripping its
    // news context at midnight left +100% rows with no 🔥 while the operator
    // (UTC+5, for whom this is late morning) reviews the day (VRAX,
    // 2026-07-10: with_catalyst went 174/174 at 23h ET → 0/174 at 00h ET).
    // Alert dedups and per-day trading state stay midnight-anchored below.
    const newsDayEt = etDateString(new Date(now.getTime() - 4 * 3600_000));
    if (newsDayEt !== this.lastNewsDayEt) {
      this.bzHeadlineCache.clear();
      this.classificationCache.clear();
      this.lastNewsDayEt = newsDayEt;
    }
    if (todayEt !== this.lastEtDate) {
      this.alertedUrls.clear();
      this.alertedIgnition.clear();
      this.alertedSwing.clear();
      this.alertedDualSignal.clear();
      this.alertedFreshBurst.clear();
      this.alertedNewIgnition.clear();
      this.alertedTickCatch.clear();
      this.alertedTickWatch.clear();
      this.tickCatches.clear();
      this.accumSeen.clear();
      this.alertedAccum.clear();
      this.accumHotCycles.clear();
      this.emaCrosses.clear();
      this.newsRadar.clear();
      this.radarSeenUrls.clear();
      this.alertedNewsRadar.clear();
      this.seenInPremarketToday.clear();
      this.lastForcedSwingPostCloseDate = '';
      this.lastOutcomesDate = '';
      // "First seen today" is an ET-day concept — reset with the day.
      this.firstSeenAt.clear();
      // Anchored VWAP must reset across days so yesterday's tallies don't
      // contaminate today's. Session-boundary changes inside a day deliberately
      // *don't* clear it (see lastSession block below).
      this.vwapState.clear();
      this.prevAboveVwap.clear();
      // Reset the SEC/halt delta watermarks so the new day's first cycle
      // doesn't replay the whole backlog as "fresh".
      this.secWatermark = Math.floor(now.getTime() / 1000);
      this.haltWatermark = Math.floor(now.getTime() / 1000);
      // Mark every cached daily-bar ticker stale so yesterday's just-closed
      // bar gets fetched today. The actual fetches happen on the daily-bars
      // service's own drain loop — this is just an invalidation signal.
      dailyBars.invalidateAll();
      this.lastEtDate = todayEt;
    }
    // A session boundary (notably the 4pm regular→after-hours flip) swaps the
    // change basis entirely. Drop per-ticker movement state so the jump isn't
    // misread as a huge acceleration on the new session's first cycle.
    if (session !== this.lastSession) {
      this.prevChange.clear();
      this.volHistory.clear();
      this.chgHistory.clear();
      // vwapState is *not* cleared here. The Finviz `volume` field is cumulative
      // for the whole day, so volume deltas keep accumulating coherently across
      // PM → regular → AH. Keeping the tally lets the anchored VWAP match a
      // chart's "Session" VWAP that includes the extended-hours move (e.g. a
      // pre-market spike still weights the regular-session VWAP). Reset at
      // midnight ET below.
      this.lastSession = session;
    }

    // Swing cadence — fetch + score on the first cycle, every Nth cycle
    // (~20 min), and once after the 16:30 ET close. On non-trigger cycles
    // we re-broadcast the cached lastSwingRows so the SSE payload still
    // carries the most-recent computed swing list.
    this.swingCounter += 1;
    const etMin = etMinuteOfDay(now);
    const isPostCloseTrigger =
      etMin >= SWING.post_close_minute_et &&
      session !== 'closed' &&
      this.lastForcedSwingPostCloseDate !== todayEt;
    // Empty-list recovery: if swing is blank during a session (restart wiped
    // the process-local lastSwingRows, or a fetch failed), retry — but BOUNDED
    // to once per empty_retry_ms, not every cycle. Retrying the up-to-9-call
    // AH burst every 20s would sustain a Finviz 429 and never recover.
    const emptyRetry =
      this.lastSwingRows.length === 0 &&
      session !== 'closed' &&
      now.getTime() - this.lastSwingAttemptMs >= SWING.empty_retry_ms;
    const shouldRefreshSwing =
      this.swingCounter === 1 ||
      this.swingCounter % SWING.cadence_cycles === 0 ||
      isPostCloseTrigger ||
      emptyRetry;

    // Forward outcome tracking — once per ET day, in the same post-close window
    // as the Swing refresh. Fire-and-forget so it never blocks the cycle; the
    // job is idempotent and revisits each row until its 5-day horizon fills, so
    // exact timing vs the daily-bars refresh doesn't matter. Skipped while
    // 'closed' (weekends/holidays) — nothing new to score.
    if (
      etMin >= SWING.post_close_minute_et &&
      session !== 'closed' &&
      this.lastOutcomesDate !== todayEt
    ) {
      this.lastOutcomesDate = todayEt;
      void outcomes.computeOutcomes();
    }

    // Continuation cadence — independent of Swing. The SQL aggregation
    // (5-day window over ignition_results) costs ~1.5 s, so we cache and
    // refresh on a slow drumbeat. Errors keep the previous list rather than
    // emptying the tab on a transient DB blip.
    this.continuationCounter += 1;
    const shouldRefreshContinuation =
      this.continuationCounter === 1 ||
      this.continuationCounter % CONTINUATION_REFRESH_CYCLES === 0;
    if (shouldRefreshContinuation) {
      try {
        this.lastContinuation = await getContinuationCandidates(todayEt);
        this.lastContinuationComputedAt = Date.now();
      } catch (err) {
        console.error('[poller] continuation refresh failed:', err);
      }
    }

    // 1) screener — Momentum + Ignition every cycle, Swing only on the
    // cadence-trigger cycles. The two intraday screens fetch as a pair; the
    // Swing fetch (a third concurrent Finviz export) is deliberately fired
    // *after* they resolve rather than alongside them. Firing all three at
    // once made Finviz rate-limit the burst, and the Ignition call was the
    // one that lost — it fell into its .catch() and returned empty on every
    // swing-refresh cycle (~once per 20 min), blanking the sidebar and
    // resetting its "new" flags. Sequencing the swing fetch keeps the
    // every-cycle pair at two concurrent calls.
    const ignitionFilter = session === 'premarket' ? IGNITION.premarket_filter : IGNITION.filter;
    const [rows, ignitionRaw] = await Promise.all([
      fetchScreener({
        filter: this.config.filter,
        floatMaxM: this.config.float_max_m,
        topN: this.config.top_n,
        session,
      }),
      fetchScreener({
        filter: ignitionFilter,
        floatMaxM: IGNITION.float_max_m,
        topN: IGNITION.top_n,
        session,
      }).catch(() => [] as ScreenerRow[]),
    ]);
    let swingFetchErr = '';
    const swingRaw = shouldRefreshSwing
      ? await fetchScreener({
          filter: SWING.filter,
          floatMaxM: SWING.float_max_m,
          topN: SWING.top_n,
          session,
        }).catch((e) => { swingFetchErr = e instanceof Error ? e.message : String(e); return [] as ScreenerRow[]; })
      : ([] as ScreenerRow[]);
    // sh_price_u10 has no lower bound — drop sub-dime junk.
    const ignitionRows = ignitionRaw.filter(
      (r) => r.price != null && r.price >= IGNITION.min_price,
    );
    // Swing post-filters (Finviz can't gate float min, mcap min in-string
    // without dropping null-field rows). Apply both in code.
    const swingRows = swingRaw.filter(
      (r) =>
        r.float_m != null &&
        r.float_m >= SWING.float_min_m &&
        r.float_m <= SWING.float_max_m &&
        r.mcap_m != null &&
        r.mcap_m >= SWING.mcap_min_m,
    );

    // Enrich the union of all active screens once; derive each view afterward.
    const screenRows = new Map<string, ScreenerRow>();
    for (const r of rows) screenRows.set(r.ticker, r);
    for (const r of ignitionRows) if (!screenRows.has(r.ticker)) screenRows.set(r.ticker, r);
    for (const r of swingRows) if (!screenRows.has(r.ticker)) screenRows.set(r.ticker, r);
    const tickers = [...screenRows.keys()];
    // Queue this cycle's tickers for a SEC shelf/dilution lookup. The result
    // lands asynchronously in the shelf cache and is read below via shelf.get.
    shelf.track(tickers);

    // 2) news — five sources in parallel
    const [finvizNews, yahooNews, bzDelta, edgarDelta, haltDelta] = await Promise.all([
      fetchFinvizNews(tickers, newsDayEt).catch(() => []),
      fetchYahooNews(tickers, newsDayEt).catch(() => []),
      fetchBenzingaDelta(this.bzWatermark, newsDayEt).catch(() => null),
      fetchEdgarFilings(new Set(tickers), this.secWatermark).catch(() => null),
      fetchHalts(this.haltWatermark, newsDayEt).catch(() => null),
    ]);

    // Build per-cycle ticker → headline map. Precedence, low → high:
    //   Finviz < Yahoo < Benzinga < SEC filing < trade halt.
    const cycleNews = new Map<string, NewsHeadline>();
    for (const n of finvizNews) {
      cycleNews.set(n.ticker, {
        ticker: n.ticker,
        source: 'finviz',
        title: n.title,
        url: n.url,
        published_at: parseEtNaiveAsIso(n.date),
      });
    }
    for (const n of yahooNews) {
      cycleNews.set(n.ticker, {
        ticker: n.ticker,
        source: 'yahoo',
        title: n.title,
        url: n.url,
        published_at: n.published_at.toISOString(),
      });
    }

    // Benzinga: persist articles + update cumulative cache + freshness set.
    const bzPrevWatermark = this.bzWatermark; // pre-cycle mark — article-level freshness for the news radar
    if (bzDelta) {
      this.bzWatermark = bzDelta.newWatermark;
      for (const a of bzDelta.articles) {
        for (const tk of a.tickers) {
          const headline: NewsHeadline = {
            ticker: tk,
            source: 'benzinga',
            title: a.title,
            url: a.url,
            published_at: a.published_at.toISOString(),
          };
          this.bzHeadlineCache.set(tk, headline);
          // Benzinga overrides any same-cycle Finviz/Yahoo entry for the same ticker.
          cycleNews.set(tk, headline);
        }
      }
    }

    // SEC EDGAR filings — a primary-source catalyst (offerings, 8-Ks, M&A,
    // 13D stakes). Outranks the aggregators: the filing IS the news. Filings
    // arrive newest-first, so the first one per ticker wins.
    if (edgarDelta) {
      this.secWatermark = edgarDelta.newWatermark;
      for (const f of edgarDelta.filings) {
        if (cycleNews.get(f.ticker)?.source === 'sec') continue;
        cycleNews.set(f.ticker, {
          ticker: f.ticker,
          source: 'sec',
          title: f.title,
          url: f.url,
          published_at: f.published_at.toISOString(),
          secForm: f.form,
        });
      }
    }

    // Trade halts — highest precedence. A frozen tape is the loudest signal
    // there is. The feed is market-wide; surface only screener tickers.
    if (haltDelta) {
      this.haltWatermark = haltDelta.newWatermark;
      const onScreen = new Set(tickers);
      for (const h of haltDelta.halts) {
        if (!onScreen.has(h.ticker)) continue;
        if (cycleNews.get(h.ticker)?.source === 'halt') continue;
        cycleNews.set(h.ticker, {
          ticker: h.ticker,
          source: 'halt',
          title: h.title,
          url: h.url,
          published_at: h.haltedAt.toISOString(),
          haltReason: h.reasonCode,
        });
      }
    }

    // Apply persistent Benzinga cache as a base layer for tickers we've seen
    // before — even if they didn't return Finviz/Yahoo this cycle.
    for (const [tk, hl] of this.bzHeadlineCache) {
      if (!cycleNews.has(tk)) cycleNews.set(tk, hl);
    }

    // "Fresh this cycle" = audio-worthy. Any delta source can contribute: a
    // new Benzinga article, a just-disseminated SEC filing, or a new halt.
    const freshTickers = new Set<string>([
      ...(bzDelta?.freshTickers ?? []),
      ...(edgarDelta?.freshTickers ?? []),
      ...(haltDelta?.freshTickers ?? []),
    ]);

    // News radar — fresh catalysts on known runners that are NOT on any screen
    // yet. The Benzinga delta is market-wide, so this is pure matching, no
    // extra fetches. Halts ride along (a halt on a known runner is the loudest
    // possible pre-move signal). Skipped while the market is closed — an
    // overnight radar entry would expire before anyone could act on it.
    // History grows from momentum + ignition only (matches the DB seed).
    for (const r of rows) this.radarHistory.add(r.ticker);
    for (const r of ignitionRows) this.radarHistory.add(r.ticker);
    if (session !== 'closed') {
      const radarCandidates: Array<{ source: NewsSource; ticker: string; title: string; url: string; published_at: Date | null; haltReason?: string }> = [];
      for (const a of bzDelta?.articles ?? []) {
        if (a.updated_ts <= bzPrevWatermark) continue;
        for (const tk of a.tickers) {
          radarCandidates.push({ source: 'benzinga', ticker: tk, title: a.title, url: a.url, published_at: a.published_at });
        }
      }
      for (const h of haltDelta?.halts ?? []) {
        if (!haltDelta?.freshTickers.has(h.ticker)) continue;
        // News-type halts only (T1 news pending / T2 released / T12 info
        // requested). LULD volatility pauses (LUDP/M) are mid-move mechanics —
        // often on DOWN moves — not pre-move catalysts: on 2026-07-06 they
        // were 8 of the radar's 11 hits and all expired as noise.
        if (!/^T\d/i.test(h.reasonCode)) continue;
        radarCandidates.push({ source: 'halt', ticker: h.ticker, title: h.title, url: h.url, published_at: h.haltedAt, haltReason: h.reasonCode });
      }
      this.updateNewsRadar(radarCandidates, new Set(tickers));
    }

    // 3) classify rows + compute 5-min relative volume + build payload
    const nowSec = Math.floor(Date.now() / 1000);
    const FIVE_MIN_SEC = 300;
    const ONE_MIN_SEC = 60;
    // The 1-min rate is only honest with a recent anchor — after an on-screen
    // gap, a stale anchor would smear minutes of history into a "1-min" read.
    const ONE_MIN_MAX_AGE_SEC = 150;
    // 1-min cold start: a fresh ripper must be measurable on its SECOND cycle
    // (~20s after first sight), not after a full minute — the fresh-burst
    // alert and the first Heat reads ride on it. One inter-cycle delta on an
    // active name is real data (volume updates on ~88% of 20s polls).
    const ONE_MIN_COLDSTART_SEC = 15;
    // Before a 5-min-old anchor exists, the burst is extrapolated from the
    // oldest sample once the window is at least this wide — so a fresh
    // ignition is measurable in ~80s, not 5 min (see the CNEY post-mortem).
    const MIN_WINDOW_SEC = 75;
    const HISTORY_MAX_SEC = 600;
    // Trading day = 6.5h × 60min ÷ 5min = 78 five-min slices. The 5-min "rate %"
    // baseline is the volume that would flow in a typical such slice.
    const SLICES_PER_DAY = 78;

    const enrichRow = (r: ScreenerRow): EnrichedRow => {
      const prev = this.prevChange.get(r.ticker);
      const cur = r.change_pct ?? 0;
      let status: RowStatus = null;
      let accelDelta: number | null = null;

      if (prev === undefined) {
        status = 'NEW';
      } else if (cur !== prev) {
        const d = +(cur - prev).toFixed(2);
        accelDelta = d;
        if (d > this.config.accel_threshold) status = 'ACC';
        else if (d > 0) status = 'UP';
      }

      // First-appearance-today timestamp. Stamped once, on the cycle a ticker
      // first shows up; stable thereafter (cleared only at midnight ET).
      let firstSeenMs = this.firstSeenAt.get(r.ticker);
      if (firstSeenMs === undefined) {
        firstSeenMs = nowSec * 1000;
        this.firstSeenAt.set(r.ticker, firstSeenMs);
      }

      // Rolling volume rates. Diff cumulative-day-volume against the YOUNGEST
      // anchor sample >= window old, dt-scaled to the exact window. (Until
      // 2026-06-12 the 5-min anchor was the OLDEST retained sample, unscaled —
      // for any name tracked >5 min that silently stretched the window toward
      // the 600s history cap, inflating rel_vol_5min ~2× (measured median
      // 2.04× on 8 days of prod series). Historical rows before that date
      // carry the inflated scale.) Before a window-old sample exists, the
      // 5-min rate falls back to extrapolating the short window — so a fresh
      // ignition's volume burst is measurable within ~80s of first appearing.
      let vol5min: number | null = null;
      let relVol5min: number | null = null;
      let relVol1min: number | null = null;
      if (r.volume != null) {
        const volNow = r.volume;
        let h = this.volHistory.get(r.ticker);
        if (!h) {
          h = [];
          this.volHistory.set(r.ticker, h);
        }
        // Volume traded over the trailing `windowSec`, from the youngest
        // sample at least that old; null when the youngest qualifying sample
        // is older than `maxAgeSec` (e.g. after an off-screen gap — an old
        // anchor would be a stale average masquerading as a current rate).
        const windowRate = (windowSec: number, maxAgeSec: number): number | null => {
          for (let i = h.length - 1; i >= 0; i--) {
            const age = nowSec - h[i].ts;
            if (age >= windowSec) {
              if (age > maxAgeSec) return null;
              const diff = volNow - h[i].volume;
              return diff >= 0 ? Math.round(diff * (windowSec / age)) : null;
            }
          }
          return null;
        };
        vol5min = windowRate(FIVE_MIN_SEC, HISTORY_MAX_SEC);
        if (vol5min == null && h.length > 0 && nowSec - h[0].ts >= MIN_WINDOW_SEC) {
          // Cold start — extrapolate the short window to a 5-min-equivalent.
          const dt = nowSec - h[0].ts;
          const diff = volNow - h[0].volume;
          if (diff >= 0) vol5min = Math.round(diff * (FIVE_MIN_SEC / dt));
        }
        let vol1min = windowRate(ONE_MIN_SEC, ONE_MIN_MAX_AGE_SEC);
        if (vol1min == null && h.length > 0) {
          // Cold start — extrapolate the short window to a 1-min-equivalent.
          const dt = nowSec - h[0].ts;
          if (dt >= ONE_MIN_COLDSTART_SEC && dt < ONE_MIN_SEC) {
            const diff = volNow - h[0].volume;
            if (diff >= 0) vol1min = Math.round(diff * (ONE_MIN_SEC / dt));
          }
        }
        if (r.avg_volume && r.avg_volume > 0) {
          const expected5min = r.avg_volume / SLICES_PER_DAY;
          if (vol5min != null && expected5min > 0) {
            relVol5min = +((vol5min / expected5min) * 100).toFixed(2);
          }
          const expected1min = r.avg_volume / (SLICES_PER_DAY * 5);
          if (vol1min != null && expected1min > 0) {
            relVol1min = +((vol1min / expected1min) * 100).toFixed(2);
          }
        }
        // Append current sample, trim history.
        h.push({ ts: nowSec, volume: volNow });
        while (h.length > 0 && nowSec - h[0].ts > HISTORY_MAX_SEC) h.shift();
      }

      // Local 1-min price direction — pairs with the direction-blind 1-min
      // RVol (a hot burst while this is ≤ −2 reads as sell-side pressure).
      // Youngest sample ≥ 1 min old, same staleness bound as the RVol anchor.
      let chgDelta1min: number | null = null;
      if (r.change_pct != null) {
        let ch = this.chgHistory.get(r.ticker);
        if (!ch) {
          ch = [];
          this.chgHistory.set(r.ticker, ch);
        }
        for (let i = ch.length - 1; i >= 0; i--) {
          const age = nowSec - ch[i].ts;
          if (age >= ONE_MIN_SEC) {
            if (age <= ONE_MIN_MAX_AGE_SEC) {
              chgDelta1min = +(r.change_pct - ch[i].chg).toFixed(2);
            }
            break;
          }
        }
        ch.push({ ts: nowSec, chg: r.change_pct });
        while (ch.length > 0 && nowSec - ch[0].ts > ONE_MIN_MAX_AGE_SEC) ch.shift();
      }

      // Anchored VWAP — see EnrichedRow.vwap doc. First cycle seeds lastVolume
      // and returns null (no delta yet); subsequent cycles accumulate
      // Δvolume × current price. Cleared at midnight ET only (sessions share
      // the day's anchor) and rebuilt from today's persisted cycles on boot
      // (seedVwapState), so a deploy doesn't re-anchor every VWAP mid-day.
      let vwap: number | null = null;
      let aboveVwap: boolean | null = null;
      let vwapReclaim = false;
      if (r.price != null && r.price > 0 && r.volume != null) {
        const st = this.vwapState.get(r.ticker);
        if (!st) {
          this.vwapState.set(r.ticker, { cumPxVol: 0, cumVol: 0, lastVolume: r.volume });
        } else {
          const dv = r.volume - st.lastVolume;
          if (dv > 0) {
            st.cumPxVol += dv * r.price;
            st.cumVol += dv;
          }
          st.lastVolume = r.volume;
          if (st.cumVol > 0) {
            vwap = +(st.cumPxVol / st.cumVol).toFixed(4);
            aboveVwap = r.price >= vwap;
            // Reclaim = was below VWAP last cycle, now at/above it. The timed
            // "bad → good" turn the operator enters on but keeps missing.
            const prevAbove = this.prevAboveVwap.get(r.ticker);
            if (aboveVwap && prevAbove === false) vwapReclaim = true;
            this.prevAboveVwap.set(r.ticker, aboveVwap);
          }
        }
      }

      const headline = cycleNews.get(r.ticker) ?? null;
      const hasNews = !!headline;
      const isFresh = freshTickers.has(r.ticker);

      // If no movement classification but has news, mark NEWS.
      if (status == null && hasNews) status = 'NEWS';

      // Catalyst score — read from the URL cache, or compute fresh via rules.
      let catalyst: CatalystInfo | null = null;
      if (headline) {
        let cached = this.classificationCache.get(headline.url);
        if (!cached) {
          const input: ClassifierInput = {
            ticker: r.ticker,
            title: headline.title,
            source: headline.source,
            secForm: headline.secForm,
            haltReason: headline.haltReason,
            marketContext: {
              change_pct: r.change_pct,
              float_m: r.float_m,
              mcap_m: r.mcap_m,
              rel_volume: r.rel_volume,
              country: r.country,
            },
          };
          const cls = classifyByRules(input);
          cached = {
            classification: cls,
            classifier: 'rules',
            // SEC filings and halts are classified deterministically from
            // their form/reason code — the rule verdict is final, not a
            // baseline for the LLM to refine.
            needsLLM: !!process.env.ANTHROPIC_API_KEY
              && headline.source !== 'sec' && headline.source !== 'halt',
            input,
          };
          this.classificationCache.set(headline.url, cached);
        }
        catalyst = {
          score: cached.classification.impact_score,
          hype: cached.classification.hype_score,
          urgency: cached.classification.urgency,
          direction: cached.classification.direction,
          type: cached.classification.catalyst_type,
          reason: cached.classification.reason,
          risk_flags: cached.classification.risk_flags,
          classifier: cached.classifier,
        };
      }

      // ── Heat: "what's worth looking at RIGHT NOW", not "who's already won".
      // A composite of timed/activity signals so fresh + rising names rank
      // above stale leaders that just sit at the top on a big Chg%. Heuristic;
      // weights to be tuned against outcomes later. Capped 0..100.
      //   • freshness   — appeared in the last ~15 min (decays)
      //   • acceleration— change% rising cycle-to-cycle (ACC/UP)
      //   • VWAP reclaim— the timed below→above cross (big, brief boost)
      //   • above VWAP  — tradeable-side bonus
      //   • 5m RVol     — live volume surge
      //   • fresh news  — catalyst landed this cycle
      let heat = 0;
      const ageMin = (nowSec * 1000 - firstSeenMs) / 60000;
      if (ageMin <= 2) heat += 30;
      else if (ageMin <= 5) heat += 22;
      else if (ageMin <= 15) heat += 12;
      else if (ageMin <= 30) heat += 5;
      if (accelDelta != null && accelDelta > 0) {
        heat += Math.min(25, 6 + accelDelta * 1.5); // bigger jump → more heat
      }
      if (vwapReclaim) heat += 25;
      else if (aboveVwap === true) heat += 8;
      // RVol tiers re-anchored 2026-06-12: the old cuts (150/300/800/2000) sat
      // on the inflated pre-fix scale AND were saturated anyway — 80% of
      // regular-session rows cleared 300 and 45% cleared 2000, so the
      // component awarded near-constant points. New cuts ≈ p57/p73/p85/p93 of
      // the true-5-min distribution on 8 days of prod momentum rows.
      if (relVol5min != null) {
        if (relVol5min >= 30000) heat += 20;
        else if (relVol5min >= 9000) heat += 14;
        else if (relVol5min >= 3000) heat += 8;
        else if (relVol5min >= 800) heat += 4;
      }
      // Burst-live bonus: BOTH the 1-min and 5-min windows elevated (≈p80 of
      // each). Measured P(+4 pts within 10 min) = 59.5% vs 30.7% base — the
      // two windows carry independent signal; either alone is only ~43%.
      if (relVol1min != null && relVol5min != null
        && relVol1min >= 4000 && relVol5min >= 5000) heat += 6;
      if (isFresh) heat += 10; // fresh news this cycle
      heat = Math.max(0, Math.min(100, Math.round(heat)));

      return {
        ...r,
        status,
        prev_change_pct: prev ?? null,
        accel_delta: accelDelta,
        first_seen_at: new Date(firstSeenMs).toISOString(),
        heat,
        vwap_reclaim: vwapReclaim,
        vol_5min: vol5min,
        rel_vol_5min: relVol5min,
        rel_vol_1min: relVol1min,
        chg_delta_1min: chgDelta1min,
        vwap,
        above_vwap: aboveVwap,
        is_fresh_news: isFresh,
        has_today_news: hasNews,
        news_title: headline?.title ?? null,
        news_source: headline?.source ?? null,
        news_url: headline?.url ?? null,
        finviz_url: `https://elite.finviz.com/quote?t=${r.ticker}&ty=c&p=h&b=1`,
        catalyst,
        shelf: shelf.get(r.ticker),
      };
    };

    // Enrich every ticker once (volHistory side-effects fire once per ticker),
    // then split into the two screen views.
    const enrichedByTicker = new Map<string, EnrichedRow>();
    for (const r of screenRows.values()) enrichedByTicker.set(r.ticker, enrichRow(r));
    const enriched = rows.map((r) => enrichedByTicker.get(r.ticker)!);

    // Track Ignition-set membership so just-arrived names can be surfaced
    // separately. Register first-sightings, then prune any ticker no longer
    // present — this keeps each survivor's firstSeen stable while letting a
    // ticker that leaves and returns re-count as new.
    const nowMs = Date.now();
    // A single empty Ignition fetch used to blank the sidebar *and* wipe
    // ignitionFirstSeen via the prune below — so on recovery every surviving
    // ticker re-counted as "new" and the whole list flashed back as a fresh
    // NEW group. When this cycle produced no ignition rows but we have a
    // recent good list, treat it as a transient hiccup: reuse the last list
    // and leave firstSeen untouched. Bounded by reuse_max_ms so a genuine
    // clear (market close / quiet overnight) still empties the sidebar.
    const ignitionHiccup =
      ignitionRows.length === 0 &&
      this.lastIgnition.length > 0 &&
      nowMs - this.lastIgnitionAt < IGNITION.reuse_max_ms;

    let ignition: IgnitionRow[];
    let ignitionFreshlyScored = false;
    if (ignitionHiccup) {
      ignition = this.lastIgnition;
    } else {
      for (const r of ignitionRows) {
        if (!this.ignitionFirstSeen.has(r.ticker)) this.ignitionFirstSeen.set(r.ticker, nowMs);
        // Mark anything igniting in pre-market so its score carries the
        // exhaustion penalty all day (outcomes: PM-touched names give back).
        if (session === 'premarket') this.seenInPremarketToday.add(r.ticker);
      }
      const ignitionPresent = new Set(ignitionRows.map((r) => r.ticker));
      for (const t of this.ignitionFirstSeen.keys()) {
        if (!ignitionPresent.has(t)) this.ignitionFirstSeen.delete(t);
      }

      const scoredIgnition: IgnitionRow[] = ignitionRows
        .map((r) => {
          const e = enrichedByTicker.get(r.ticker)!;
          const rs = scoreRunner({
            float_m: e.float_m,
            rel_vol_5min: e.rel_vol_5min,
            rel_volume: e.rel_volume,
            catalyst_type: e.catalyst?.type ?? null,
            catalyst_direction: e.catalyst?.direction ?? null,
            change_pct: e.change_pct,
            seen_in_premarket: this.seenInPremarketToday.has(r.ticker),
            shelf_level: e.shelf?.level ?? null,
          });
          const firstSeen = this.ignitionFirstSeen.get(r.ticker) ?? nowMs;
          return {
            ...e,
            runner_score: rs.score,
            score_breakdown: rs.breakdown,
            is_new: nowMs - firstSeen <= IGNITION.new_window_ms,
          };
        })
        .sort((a, b) => b.runner_score - a.runner_score);

      // Drop rows the runner-score has already disqualified (clamped to 0).
      // The volume-led Finviz filter has no change% gate by design, so it lets
      // through crashes and low-quality dilution-flagged names — the score
      // tags them as non-ignitions; the broadcast shouldn't carry them. This
      // does NOT hide cold-start fresh entries (they score ≥ float-component
      // ≈ 15-30) or volume-led turnaround setups (they score 48+).
      const candidates = scoredIgnition.filter((r) => r.runner_score > 0);
      // New rows bypass the score cutoff entirely — a fresh low-score name (its
      // 5-min RVol not yet measurable) must never be buried. Top rows are the
      // established names, ranked and capped. The payload carries both.
      const newIgnition = candidates.filter((r) => r.is_new);
      let established = candidates.filter((r) => !r.is_new);
      // After-hours: the Finviz relvol gate is dropped (frozen at the 4pm close),
      // so re-impose the volume discriminator on ESTABLISHED rows using our own
      // AH-aware RVol. New rows are exempt — cold-start, their RVol isn't
      // measurable in the first ~75s, comfortably inside the 2-min new window.
      if (session === 'afterhours') {
        established = established.filter(
          (r) => Math.max(r.rel_vol_5min ?? 0, r.rel_vol_1min ?? 0) >= IGNITION.ah_rvol_min,
        );
      }
      const topIgnition = established.slice(0, IGNITION.broadcast_n);
      ignition = [...newIgnition, ...topIgnition];
      this.lastIgnition = ignition;
      this.lastIgnitionAt = nowMs;
      ignitionFreshlyScored = true;
    }

    // 3b) Swing scoring — only on the cadence-trigger cycles. Reads daily
    // bars from the daily_bars table (populated by the DailyBarsService);
    // scores each ticker in the post-filtered Swing universe; sorts desc;
    // truncates to SWING.broadcast_n. On non-trigger cycles we keep the
    // previous cached list (lastSwingRows) so the SSE clients still see it.
    let scoredSwing: SwingRow[] = this.lastSwingRows;
    let swingFreshlyScored = false;
    if (shouldRefreshSwing) {
      // Stamp the attempt up front so the empty-retry backoff measures from
      // when we tried, not when we succeeded — a failed/empty fetch still
      // pushes the next retry out by empty_retry_ms.
      this.lastSwingAttemptMs = now.getTime();
      const swingTickers = swingRows.map((r) => r.ticker);
      // Queue every swing-universe ticker for daily-bar backfill — tickers
      // already fresh in the service are no-ops, new ones get queued.
      dailyBars.trackUniverse(swingTickers);
      const barsByTicker = await getRecentBarsForTickers(swingTickers, 252);
      const scored: SwingRow[] = [];
      for (const r of swingRows) {
        const e = enrichedByTicker.get(r.ticker)!;
        const result = scoreSwing({
          price: e.price,
          volume: e.volume,
          bars: barsByTicker.get(r.ticker) ?? [],
          catalyst_score: e.catalyst?.score ?? null,
          catalyst_direction: e.catalyst?.direction ?? null,
          catalyst_urgency: e.catalyst?.urgency ?? null,
          catalyst_type: e.catalyst?.type ?? null,
          shelf_level: e.shelf?.level ?? null,
        });
        if (!result) continue;
        scored.push({
          ...e,
          swing_score: result.score,
          score_breakdown: result.breakdown,
          setup_flags: result.flags,
          daily_context: result.context,
        });
      }
      scored.sort((a, b) => b.swing_score - a.swing_score);
      const truncated = scored.slice(0, SWING.broadcast_n);
      // Only log the funnel when the scan came up empty — that's the
      // debuggable case (raw=0 → fetch/429; filtered=0 → post-filter; scored=0
      // → scoring). A healthy scan stays quiet.
      if (scored.length === 0) {
        console.warn(`[poller] swing scan empty — raw=${swingRaw.length} filtered=${swingRows.length} scored=0${swingFetchErr ? ` fetchErr=${swingFetchErr}` : ''}`);
      }
      // Replace only if the new scan actually produced rows — a transient
      // Finviz hiccup shouldn't blank out the swing list.
      if (truncated.length > 0) {
        this.lastSwingRows = truncated;
        this.lastSwingComputedAt = Date.now();
        scoredSwing = truncated;
        swingFreshlyScored = true;
      }
      if (isPostCloseTrigger) this.lastForcedSwingPostCloseDate = todayEt;
    }

    // 4) update memory state for next cycle
    for (const r of screenRows.values()) {
      if (r.change_pct != null) this.prevChange.set(r.ticker, r.change_pct);
    }

    // 5) persist — Swing rows only on the cycles that re-scored, so the
    // swing_results table holds one snapshot per ~20 min, not per 20 s.
    const cycleId = await this.persistCycle(
      session, enriched, ignitionFreshlyScored ? ignition : [], swingFreshlyScored ? scoredSwing : [],
      bzDelta?.articles, finvizNews, yahooNews,
      edgarDelta?.filings, haltDelta?.halts,
    );

    // 6) broadcast
    const newWithCatalyst = enriched
      .filter((r) => r.status === 'NEW' && r.has_today_news)
      .map((r) => r.ticker);
    const freshList = enriched.filter((r) => r.is_fresh_news).map((r) => r.ticker);

    // Quiet-accumulation scan (🤫) — flag screened names still quiet on price
    // with strong early volume. Must run BEFORE the tick-catch payload block
    // so a fresh flag shows this cycle, not next.
    this.scanAccumulation([...enriched, ...ignition], session, this.firstPoll);

    // Tick-feed catches for the dashboard 🛰️ section — kept as a rolling
    // "recent catches" feed so they're actually VISIBLE. We deliberately do
    // NOT drop a catch the moment a screen picks the name up: the volume-led
    // Ignition screen catches the same surge within a cycle or two, and
    // pruning on that made every catch flash for only seconds → the section
    // looked permanently empty (operator "never saw it work", 2026-06-23).
    // A screen picking up a WATCH-state name is instead treated as its volume
    // CONFIRMATION — the Finviz relvol gates are exactly the evidence the
    // watch was waiting for — so the entry promotes rather than prunes.
    const TICK_CATCH_TTL_MS = 15 * 60 * 1000;   // watch/confirmed display TTL
    const TICK_FADE_LINGER_MS = 3 * 60 * 1000;  // faded rows linger briefly, then prune
    const nowMsTick = Date.now();
    const screenRowByTicker = new Map<string, EnrichedRow>();
    for (const r of ignition) screenRowByTicker.set(r.ticker, r);
    for (const r of enriched) screenRowByTicker.set(r.ticker, r);
    const tickCatchList: TickCatch[] = [];
    for (const [t, tc] of this.tickCatches) {
      const row = screenRowByTicker.get(t);
      // A screen returning the name only counts as volume confirmation when
      // the screen did NOT already hold it at watch time — otherwise it's
      // pre-existing state, and the watch waits for surge/sustain instead.
      if (tc.status === 'watch' && !tc.screened_at_watch && row) {
        tc.status = 'confirmed';
        tc.confirmed_at = new Date(nowMsTick).toISOString();
        tc.last_event_ms = nowMsTick;
        // Same anchor rule as the refresh below: AH row change is today-close
        // anchored — don't mix it with the prior-day-anchored ⚑ flag.
        const chg = (session !== 'afterhours' ? row.change_pct : null) ?? tc.change_pct;
        console.log(
          `[tickfeed] 🛰️ confirm(screen) ${t} ` +
          `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%` +
          (tc.watch_change_pct != null ? ` (watched at +${tc.watch_change_pct.toFixed(1)}%)` : ''),
        );
        recordTierEvent('tick', 'confirm', t, { via: 'screen', chg, watch_chg: tc.watch_change_pct });
        if (telegramEnabled() && !this.alertsMuted && !this.alertedTickCatch.has(t)) {
          this.alertedTickCatch.add(t);
          void sendTelegram(formatTickConfirmAlert(
            t, row.price ?? tc.price, chg, tc.rel_vol, tc.mom_pct, tc.watch_change_pct, 'screen',
          ));
        }
      }
      // Accum backstop: if the row itself crosses the +10% line while the
      // tick detector stayed silent (not subscribed / no prior close), the
      // ladder still advances — dashboard-only, no extra push (the detector
      // path is the alerting one when it's live).
      if (tc.status === 'accum' && row?.change_pct != null && row.change_pct >= ACCUM.chg_max) {
        const mins = Math.round((nowMsTick - Date.parse(tc.caught_at)) / 60000);
        tc.status = 'watch';
        tc.watch_change_pct = row.change_pct;
        tc.last_event_ms = nowMsTick;
        console.log(
          `[accum] ↗ 👀 watch(screen) ${t} +${row.change_pct.toFixed(1)}% — ${mins}min after the 🤫 flag` +
          (tc.accum_entry_chg != null ? ` (+${(row.change_pct - tc.accum_entry_chg).toFixed(1)}pts)` : ''),
        );
        recordTierEvent('accum', 'promote', t, {
          via: 'screen', chg: row.change_pct, minutes: mins,
          pts: tc.accum_entry_chg != null ? +(row.change_pct - tc.accum_entry_chg).toFixed(1) : null,
        });
      }
      // Keep displayed price/chg live for names the screens also carry — a
      // watch row frozen at its flag values reads as broken next to an
      // Ignition row showing +106% (the CETX case). The flag point itself
      // stays in watch_change_pct (the ⚑ marker). In AFTER-HOURS the row's
      // change is the AH overlay (anchored to today's close) while the
      // detector's ⚑ is prior-day-anchored — mixing them read as a pullback
      // that never happened (UPC: "⚑ +56%" beside "+29.11%"), so only the
      // anchor-free price refreshes there. Accum entries are row-anchored by
      // birth, so their change refreshes in any session — and tracks the
      // grading peak.
      if (row && tc.status !== 'faded') {
        if (row.price != null) tc.price = row.price;
        if (row.change_pct != null && (session !== 'afterhours' || tc.status === 'accum')) {
          tc.change_pct = row.change_pct;
        }
        if (tc.status === 'accum' && row.change_pct != null) {
          tc.accum_peak = Math.max(tc.accum_peak ?? row.change_pct, row.change_pct);
        }
      }
      const ttl = tc.status === 'faded' ? TICK_FADE_LINGER_MS
        : tc.status === 'accum' ? ACCUM.ttl_min * 60_000
        : TICK_CATCH_TTL_MS;
      if (nowMsTick - tc.last_event_ms > ttl) {
        if (tc.status === 'accum') {
          const pts = tc.accum_entry_chg != null && tc.accum_peak != null
            ? (tc.accum_peak - tc.accum_entry_chg).toFixed(1) : '?';
          console.log(`[accum] 💤 expired ${t} after ${ACCUM.ttl_min}min (peak +${pts}pts from flag)`);
          recordTierEvent('accum', 'expire', t, { peak_pts: pts === '?' ? null : +pts, minutes: ACCUM.ttl_min });
        } else if (tc.status === 'watch') {
          // Grading gap found 2026-07-07: fades log, but watches that simply
          // age out never did — ~35 of Monday's ~80 watches vanished silently.
          console.log(`[tickfeed] ⌛ watch expired ${t} — no confirm within TTL (last at ${tc.change_pct >= 0 ? '+' : ''}${tc.change_pct.toFixed(1)}%${tc.watch_change_pct != null ? `, flagged +${tc.watch_change_pct.toFixed(1)}%` : ''})`);
          recordTierEvent('tick', 'watch_expired', t, { chg: tc.change_pct, watch_chg: tc.watch_change_pct });
        }
        this.tickCatches.delete(t);
        continue;
      }
      tickCatchList.push({
        ticker: tc.ticker, price: tc.price, change_pct: tc.change_pct,
        rel_vol: tc.rel_vol, mom_pct: tc.mom_pct, status: tc.status,
        caught_at: tc.caught_at, confirmed_at: tc.confirmed_at,
        watch_change_pct: tc.watch_change_pct,
      });
    }
    // Confirmed on top, then watches, then quiet accumulation, faded last;
    // newest transition first within each group.
    const tickStatusRank: Record<TickCatchStatus, number> = { confirmed: 0, watch: 1, accum: 2, faded: 3 };
    tickCatchList.sort((a, b) =>
      tickStatusRank[a.status] - tickStatusRank[b.status]
      || (b.confirmed_at ?? b.caught_at).localeCompare(a.confirmed_at ?? a.caught_at));

    // News radar — escalate entries whose ticker started moving (tick catch or
    // a screen returned it), refresh scores from the classification cache (the
    // async LLM pass may have upgraded the rule verdict), prune expired ones.
    // Every transition is logged — the precision study reads these logs.
    const radarList: NewsRadarItem[] = [];
    for (const [tk, item] of this.newsRadar) {
      const ageMin = Math.round((nowMsTick - item.first_seen_ms) / 60000);
      if (ageMin > NEWS_RADAR.ttl_min) {
        console.log(`[news-radar] ${item.status === 'moving' ? '✅ expired (moved)' : '💤 expired (no move)'} ${tk} after ${ageMin}min`);
        recordTierEvent('radar', 'expired', tk, {
          outcome: item.status === 'moving' ? 'moved' : 'no_move',
          via: item.escalated_via, minutes: ageMin, impact: item.impact, type: item.catalyst_type,
        });
        this.newsRadar.delete(tk);
        continue;
      }
      const cached = this.classificationCache.get(item.url);
      if (cached) {
        if (cached.classification.direction === 'bearish') {
          // The LLM refinement flipped the rule verdict bearish — not an
          // opportunity after all; drop the entry.
          console.log(`[news-radar] dropped ${tk} — LLM reclassified bearish (${cached.classification.catalyst_type})`);
          recordTierEvent('radar', 'dropped', tk, { reason: 'llm_bearish', type: cached.classification.catalyst_type });
          this.newsRadar.delete(tk);
          continue;
        }
        item.impact = cached.classification.impact_score;
        item.hype = cached.classification.hype_score;
        item.direction = cached.classification.direction;
        item.urgency = cached.classification.urgency;
        item.catalyst_type = cached.classification.catalyst_type;
        item.classifier = cached.classifier;
      }
      if (item.status === 'news') {
        // 'tick' escalation requires actual price movement (watch/confirmed) —
        // an 🤫 accum entry is volume-only and mislabeled NVVE "moving" on
        // 2026-07-06 while its price went nowhere.
        const tickStatus = this.tickCatches.get(tk)?.status;
        const via = screenRowByTicker.has(tk) ? 'screen'
          : (tickStatus === 'watch' || tickStatus === 'confirmed') ? 'tick' : null;
        if (via) {
          item.status = 'moving';
          item.escalated_at = new Date(nowMsTick).toISOString();
          item.escalated_via = via;
          console.log(`[news-radar] ↗ moving ${tk} via ${via} — ${ageMin}min after the news`);
          recordTierEvent('radar', 'moving', tk, { via, minutes: ageMin, impact: item.impact, type: item.catalyst_type });
        }
      }
      radarList.push({ ...item });
    }
    // Moving first (actionable NOW), then newest news first; capped for the UI.
    radarList.sort((a, b) =>
      (a.status === 'moving' ? 0 : 1) - (b.status === 'moving' ? 0 : 1)
      || b.first_seen_at.localeCompare(a.first_seen_at));
    const radarDisplay = radarList.slice(0, NEWS_RADAR.max_display);

    // 📈 EMA-cross layer — the tracker expires observations by BAR count, but
    // a sparse tape can stall bars; safety-prune on wall clock too. Confirmed
    // entries show 30 min from confirmation.
    const CROSS_OBSERVE_SAFETY_MS = 45 * 60 * 1000;
    const CROSS_CONFIRMED_TTL_MS = 30 * 60 * 1000;
    const emaCrossList: EmaCrossItem[] = [];
    for (const [t, xc] of this.emaCrosses) {
      const ttl = xc.status === 'confirmed' ? CROSS_CONFIRMED_TTL_MS : CROSS_OBSERVE_SAFETY_MS;
      if (nowMsTick - xc.last_event_ms > ttl) {
        this.emaCrosses.delete(t);
        continue;
      }
      emaCrossList.push({
        ticker: xc.ticker, status: xc.status, price: xc.price, cross_price: xc.cross_price,
        vol_ratio: xc.vol_ratio, cross_at: xc.cross_at, confirmed_at: xc.confirmed_at,
      });
    }
    emaCrossList.sort((a, b) =>
      (a.status === 'confirmed' ? 0 : 1) - (b.status === 'confirmed' ? 0 : 1)
      || (b.confirmed_at ?? b.cross_at).localeCompare(a.confirmed_at ?? a.cross_at));
    const emaCrossDisplay = emaCrossList.slice(0, 12);

    // After-hours: re-impose a volume gate on the momentum list. Finviz drops
    // its relvol filter at the close, so names that ticked >5% on a few AH
    // shares (BLIV on 5, GRAN on 90) otherwise flood it. Keep a row only if it
    // shows real AH volume by our own metric, or it just appeared (cold-start,
    // RVol not yet measurable). Regular/PM keep Finviz's live relvol gate.
    const momentumRows = session === 'afterhours'
      ? enriched.filter((r) => {
          const firstSeenMs = Date.parse(r.first_seen_at);
          const fresh = Number.isFinite(firstSeenMs) && nowMs - firstSeenMs <= AH_MOMENTUM.cold_start_ms;
          return fresh || Math.max(r.rel_vol_5min ?? 0, r.rel_vol_1min ?? 0) >= AH_MOMENTUM.rvol_min;
        })
      : enriched;

    const payload: CyclePayload = {
      cycle_id: cycleId,
      polled_at: new Date().toISOString(),
      session,
      config: this.config,
      rows: momentumRows,
      ignition,
      swing: scoredSwing,
      continuation: this.lastContinuation,
      tick_catches: tickCatchList,
      news_radar: radarDisplay,
      ema_crosses: emaCrossDisplay,
      banners: { new_with_catalyst: newWithCatalyst, fresh_news: freshList },
      fresh_news: enriched
        .filter((r) => r.is_fresh_news && r.news_title)
        .map((r) => ({
          ticker: r.ticker,
          source: r.news_source!,
          title: r.news_title!,
          url: r.news_url!,
          published_at: cycleNews.get(r.ticker)?.published_at ?? null,
        })),
    };

    this.lastPayload = payload;
    const wasFirstPoll = this.firstPoll;
    this.firstPoll = false;
    broadcast('cycle', payload);
    console.log(
      `[poller] ${nowHms()} — ${enriched.length} rows, ${ignition.length} ignition${ignitionHiccup ? ' (reused)' : ''}, ${scoredSwing.length} swing${swingFreshlyScored ? ' (refreshed)' : ''}, ${this.lastContinuation.length} continuation${shouldRefreshContinuation ? ' (refreshed)' : ''}, ${newWithCatalyst.length} new+catalyst, ${freshList.length} fresh`,
    );

    // Telegram alerts — fresh high-impact rows + Ignition runner-score hits.
    // Skipped on the first poll so a restart's news backfill and cold-start
    // ignition set don't blast a burst of alerts. Swing alerts only fire on
    // cycles where the swing scan freshly ran (otherwise we'd re-walk the
    // cached list every cycle, doing no work but for no reason).
    if (!wasFirstPoll) {
      this.pushAlerts(enriched);
      this.pushIgnitionAlerts(ignition);
      if (swingFreshlyScored) this.pushSwingAlerts(scoredSwing);
      this.pushDualSignalAlerts(ignition);
      // Telegram is reserved for high-conviction (above): ≥65 ignition, fresh
      // strong/major catalyst, dual-signal, swing. The high-frequency EARLY
      // signals — tick-feed 🛰️, fresh-burst 🚀, new-ignition 🆕 — moved to the
      // DASHBOARD (2026-06-17 operator call): too noisy as pushes, glanceable
      // on screen. pushFreshBurstAlerts / pushNewIgnitionAlerts kept dormant
      // for easy re-enable; the tick feed surfaces via payload.tick_catches.
    }

    // Fire-and-forget LLM refinement of any rule-classified articles.
    // Completes in the background; the next cycle's payload picks up the
    // refined scores via the in-memory cache.
    void this.refineWithLLM();
  }

  // Run the LLM classifier on every article still flagged needsLLM (i.e.
  // classified by rules and persisted, but not yet refined). Bounded
  // concurrency keeps us from hammering the API. Skipped entirely if a
  // previous run is still in flight, so a slow API doesn't queue up
  // infinite work.
  private async refineWithLLM() {
    if (this.llmInFlight) return;
    if (!process.env.ANTHROPIC_API_KEY) return;

    const pending = [...this.classificationCache.values()].filter(
      (v) => v.needsLLM && v.articleId,
    );
    if (pending.length === 0) return;

    this.llmInFlight = true;
    try {
      const concurrency = 5;
      for (let i = 0; i < pending.length; i += concurrency) {
        const batch = pending.slice(i, i + concurrency);
        await Promise.all(batch.map((entry) => this.refineOne(entry)));
      }
    } finally {
      this.llmInFlight = false;
    }
  }

  private async refineOne(entry: {
    classification: Classification;
    classifier: Classifier;
    articleId?: string;
    needsLLM: boolean;
    input: ClassifierInput;
  }): Promise<void> {
    const result = await classifyByClaude(entry.input);
    if (!result || !entry.articleId) {
      // Give up after one failure — don't burn tokens retrying every cycle.
      entry.needsLLM = false;
      return;
    }
    entry.classification = result;
    entry.classifier = 'anthropic_sonnet';
    entry.needsLLM = false;

    try {
      await getDb()
        .updateTable('news_classifications')
        .set({
          impact_score: result.impact_score,
          hype_score: result.hype_score,
          direction: result.direction,
          urgency: result.urgency,
          catalyst_type: result.catalyst_type,
          materiality: result.materiality,
          confidence: result.confidence,
          reason: result.reason,
          risk_flags: JSON.stringify(result.risk_flags) as unknown as never,
          classifier: 'anthropic_sonnet',
          updated_at: new Date(),
        })
        .where('article_id', '=', entry.articleId)
        .execute();
    } catch (err) {
      console.error('[poller] failed to persist Claude classification:', err);
    }
  }

  private async persistCycle(
    session: TradingSession,
    rows: EnrichedRow[],
    ignitionRows: IgnitionRow[],
    swingRows: SwingRow[],
    bzArticles: import('./benzinga.js').BenzingaArticle[] | undefined,
    finvizNews: Awaited<ReturnType<typeof fetchFinvizNews>>,
    yahooNews: Awaited<ReturnType<typeof fetchYahooNews>>,
    edgarFilings: EdgarFiling[] | undefined,
    halts: TradeHalt[] | undefined,
  ): Promise<string> {
    const db = getDb();
    return db.transaction().execute(async (trx) => {
      const cycle = await trx
        .insertInto('screener_cycles')
        .values({
          filter_snapshot: JSON.stringify(this.config),
          row_count: rows.length,
          session,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      if (rows.length > 0) {
        await trx
          .insertInto('screener_results')
          .values(
            rows.map((r) => ({
              cycle_id: cycle.id,
              ticker: r.ticker,
              change_pct: r.change_pct,
              float_m: r.float_m,
              float_is_proxy: r.float_is_proxy,
              price: r.price,
              volume: r.volume,
              avg_volume: r.avg_volume,
              rel_volume: r.rel_volume,
              vol_5min: r.vol_5min,
              rel_vol_5min: r.rel_vol_5min,
              rel_vol_1min: r.rel_vol_1min,
              mcap_m: r.mcap_m,
              country: r.country,
              company: r.company,
              sector: r.sector,
              industry: r.industry,
              short_float_pct: r.short_float_pct,
              short_ratio: r.short_ratio,
              insider_own_pct: r.insider_own_pct,
              insider_trans_pct: r.insider_trans_pct,
              inst_own_pct: r.inst_own_pct,
              inst_trans_pct: r.inst_trans_pct,
              shares_out_m: r.shares_out_m,
              status: r.status,
              prev_change_pct: r.prev_change_pct,
              accel_delta: r.accel_delta,
              heat: r.heat,
              vwap: r.vwap,
              above_vwap: r.above_vwap,
              vwap_reclaim: r.vwap_reclaim,
            })),
          )
          .execute();
      }

      if (ignitionRows.length > 0) {
        await trx
          .insertInto('ignition_results')
          .values(
            ignitionRows.map((r) => ({
              cycle_id: cycle.id,
              ticker: r.ticker,
              runner_score: r.runner_score,
              score_breakdown: JSON.stringify(r.score_breakdown) as unknown as never,
              price: r.price,
              change_pct: r.change_pct,
              float_m: r.float_m,
              rel_volume: r.rel_volume,
              rel_vol_5min: r.rel_vol_5min,
              rel_vol_1min: r.rel_vol_1min,
              catalyst_score: r.catalyst?.score ?? null,
              news_source: r.news_source,
              shelf_level: r.shelf?.level ?? null,
            })),
          )
          .execute();
      }

      if (swingRows.length > 0) {
        await trx
          .insertInto('swing_results')
          .values(
            swingRows.map((r) => ({
              cycle_id: cycle.id,
              ticker: r.ticker,
              swing_score: r.swing_score,
              score_breakdown: JSON.stringify(r.score_breakdown) as unknown as never,
              price: r.price,
              change_pct: r.change_pct,
              float_m: r.float_m,
              mcap_m: r.mcap_m,
              volume: r.volume,
              avg_volume_20: r.daily_context.avg_volume_20,
              sma_20: r.daily_context.sma_20,
              sma_50: r.daily_context.sma_50,
              sma_200: r.daily_context.sma_200,
              high_52w: r.daily_context.high_52w,
              atr_14: r.daily_context.atr_14,
              in_base: r.setup_flags.in_base,
              broke_out: r.setup_flags.broke_out,
              close_in_top_q: r.setup_flags.close_in_top_q,
              catalyst_score: r.catalyst?.score ?? null,
              catalyst_type: r.catalyst?.type ?? null,
              shelf_level: r.shelf?.level ?? null,
            })),
          )
          .execute();
      }

      // News persistence — dedup by URL via ON CONFLICT DO NOTHING.
      type Pending = { source: NewsSource; url: string; title: string; published_at: Date | null; raw: unknown; tickers: string[] };
      const pending: Pending[] = [];

      for (const a of bzArticles ?? []) {
        if (!a.url) continue;
        pending.push({
          source: 'benzinga',
          url: a.url,
          title: a.title,
          published_at: a.published_at,
          raw: a.raw,
          tickers: a.tickers,
        });
      }
      for (const n of finvizNews) {
        if (!n.url) continue;
        pending.push({
          source: 'finviz',
          url: n.url,
          title: n.title,
          published_at: parseEtNaiveAsDate(n.date),
          raw: n,
          tickers: [n.ticker],
        });
      }
      for (const n of yahooNews) {
        if (!n.url) continue;
        pending.push({
          source: 'yahoo',
          url: n.url,
          title: n.title,
          published_at: n.published_at,
          raw: n,
          tickers: [n.ticker],
        });
      }
      for (const f of edgarFilings ?? []) {
        if (!f.url) continue;
        pending.push({
          source: 'sec',
          url: f.url,
          title: f.title,
          published_at: f.published_at,
          raw: f.raw,
          tickers: [f.ticker],
        });
      }
      for (const h of halts ?? []) {
        if (!h.url) continue;
        pending.push({
          source: 'halt',
          url: h.url,
          title: h.title,
          published_at: h.haltedAt,
          raw: h.raw,
          tickers: [h.ticker],
        });
      }

      for (const p of pending) {
        const inserted = await trx
          .insertInto('news_articles')
          .values({
            source: p.source,
            url: p.url,
            title: p.title,
            published_at: p.published_at,
            raw: JSON.stringify(p.raw) as unknown as never,
          })
          .onConflict((oc) => oc.column('url').doNothing())
          .returning('id')
          .executeTakeFirst();

        const articleId = inserted?.id
          ?? (await trx.selectFrom('news_articles').select('id').where('url', '=', p.url).executeTakeFirst())?.id;

        if (!articleId) continue;

        for (const tk of p.tickers) {
          await trx
            .insertInto('news_ticker_links')
            .values({ article_id: articleId, ticker: tk })
            .onConflict((oc) => oc.columns(['article_id', 'ticker']).doNothing())
            .execute();
        }

        // Persist the rule-based classification once per article. The OpenAI
        // pass writes the same row later via UPDATE — `do nothing` here means
        // we never clobber a refined verdict with the cached rule one.
        const cached = this.classificationCache.get(p.url);
        if (cached) {
          cached.articleId = articleId; // unlock LLM refinement for this article
          await trx
            .insertInto('news_classifications')
            .values({
              article_id: articleId,
              impact_score: cached.classification.impact_score,
              hype_score: cached.classification.hype_score,
              direction: cached.classification.direction,
              urgency: cached.classification.urgency,
              catalyst_type: cached.classification.catalyst_type,
              materiality: cached.classification.materiality,
              confidence: cached.classification.confidence,
              reason: cached.classification.reason,
              risk_flags: JSON.stringify(cached.classification.risk_flags) as unknown as never,
              classifier: cached.classifier,
            })
            .onConflict((oc) => oc.column('article_id').doNothing())
            .execute();
        }
      }

      return cycle.id;
    });
  }

  // Push a Telegram alert for any fresh, high-impact, non-bearish row — once
  // per article URL. `is_fresh_news` is already a near one-shot signal (true
  // only while the article is newer than the source watermark); alertedUrls
  // guards the rest.
  private pushAlerts(rows: EnrichedRow[]): void {
    if (!telegramEnabled() || this.alertsMuted) return;
    for (const r of rows) {
      if (!r.is_fresh_news || !r.catalyst || !r.news_url) continue;
      if (r.catalyst.urgency !== 'strong' && r.catalyst.urgency !== 'major') continue;
      // Direction-aware, like the Ignition path: a bearish strong/major
      // catalyst (dilutive offering, SEC probe, regulatory halt) is why a
      // stock falls — not a runner to chase. Neutral signals such as a T1
      // "news pending" halt still alert.
      if (r.catalyst.direction === 'bearish') continue;
      if (this.alertedUrls.has(r.news_url)) continue;
      this.alertedUrls.add(r.news_url);
      void sendTelegram(formatTelegramAlert(r));
    }
  }

  // Telegram alert for an Ignition row — once per ticker per ET day. Fires on
  // either trigger: the runner-score clearing the threshold (a mechanical
  // ignition), OR a bullish strong/major catalyst (catches a catalyst-led move
  // before the volume burst lifts the score). Bearish catalysts never alert.
  private pushIgnitionAlerts(rows: IgnitionRow[]): void {
    if (!telegramEnabled() || this.alertsMuted) return;
    for (const r of rows) {
      // A premium catalyst — the type-aware catalyst component scoring ≥8, i.e.
      // FDA/clinical or a news-pending / news-released halt — alerts even below
      // the score threshold: it catches a catalyst-led move before the volume
      // burst lifts the score. The old "any bullish strong/major" bypass fired
      // for exactly the types the outcome data flagged as faders (M&A,
      // partnership), so the bypass is now keyed to what the data rewards.
      const b = r.score_breakdown;
      const premiumCatalyst = b.catalyst >= 8;
      // Test the threshold against the score with the shelf penalty removed:
      // dilution risk ranks the sidebar and rides as the ⚠️ in the message,
      // but it must not *hide* an ignition from the alert. Detection and risk
      // are separate concerns.
      const detectionScore = b.float + b.volume + b.catalyst + b.maturity + b.premarket;
      if (detectionScore < IGNITION.alert_score && !premiumCatalyst) continue;
      if (this.alertedIgnition.has(r.ticker)) continue;
      // Entry change% cap — see IGNITION.alert_entry_chg_max comment. We skip
      // *without* adding to alertedIgnition, so a pullback under the cap on a
      // later cycle still earns a fresh alert (the second-leg setup).
      if (r.change_pct != null && r.change_pct > IGNITION.alert_entry_chg_max) continue;
      this.alertedIgnition.add(r.ticker);
      void sendTelegram(formatIgnitionAlert(r));
    }
  }

  // New-ignition heads-up — see the NEW_IGNITION block. Fires once per ticker
  // per ET day when a *recently-appeared* ignition (within window_ms of its
  // first sighting today — restart-safe via the DB-seeded ignitionFirstSeen)
  // has built into the 40–64 score band. The middle ground between the 🚀
  // fresh-burst alert (nano-floats, ≤5M) and the ≥65 high-conviction alert
  // (which fresh names don't reach for hours). Skips names already pinged by
  // either neighbour so a ticker isn't triple-alerted.
  private pushNewIgnitionAlerts(rows: IgnitionRow[], nowMs: number): void {
    if (!telegramEnabled() || this.alertsMuted) return;
    for (const r of rows) {
      if (this.alertedNewIgnition.has(r.ticker)) continue;
      if (this.alertedFreshBurst.has(r.ticker)) continue;   // already 🚀'd
      // The ≥65 alert owns the high-conviction band; this is the build-up ping.
      if (r.runner_score >= IGNITION.alert_score || r.runner_score < NEW_IGNITION.alert_score) continue;
      const firstSeen = this.ignitionFirstSeen.get(r.ticker);
      if (firstSeen === undefined || nowMs - firstSeen > NEW_IGNITION.window_ms) continue;
      if (r.change_pct == null || r.change_pct < NEW_IGNITION.chg_min || r.change_pct > NEW_IGNITION.chg_max) continue;
      if (r.catalyst?.direction === 'bearish') continue;
      this.alertedNewIgnition.add(r.ticker);
      void sendTelegram(formatNewIgnitionAlert(r, Math.round((nowMs - firstSeen) / 1000)));
    }
  }

  // Quiet-accumulation scan (🤫) — see ACCUM for the measured evidence. Flags
  // a screened name within its first minutes on screen when price is still
  // quiet (chg 0..10%) but our fast RVol shows strong participation. The flag
  // is an entry in the LIVE TICKS ladder (status 'accum'); it promotes to 👀
  // via the tick detector's watch event (or the screen backstop when the row
  // itself crosses +10%), and confirms via the normal surge/sustain paths.
  // Dashboard + soft ping for every flag; Telegram only for the violent tail
  // (fast RVol ≥ telegram_rv_min) or when a bullish catalyst rides along.
  private scanAccumulation(rows: Iterable<EnrichedRow>, session: TradingSession, firstPoll: boolean): void {
    const nowMs = Date.now();
    for (const r of rows) {
      if (this.accumSeen.has(r.ticker) || this.tickCatches.has(r.ticker)) continue;
      if (r.change_pct == null || r.change_pct < ACCUM.chg_min || r.change_pct >= ACCUM.chg_max) continue;
      const fast = Math.max(r.rel_vol_1min ?? 0, r.rel_vol_5min ?? 0);
      if (fast < ACCUM.fast_rv_min) continue;
      // The cohort was measured at FIRST appearance — a name that spiked and
      // pulled back under 10% later in the day is not quiet accumulation.
      const firstMs = Date.parse(r.first_seen_at);
      if (!Number.isFinite(firstMs) || nowMs - firstMs > ACCUM.window_min * 60_000) continue;
      // Persistence: flag only once the hot-volume state has held across
      // min_hot_cycles polls (~1 min) — kills the one-print blips.
      const hotCount = (this.accumHotCycles.get(r.ticker) ?? 0) + 1;
      this.accumHotCycles.set(r.ticker, hotCount);
      if (hotCount < ACCUM.min_hot_cycles) continue;
      this.accumSeen.add(r.ticker);
      this.tickCatches.set(r.ticker, {
        ticker: r.ticker,
        price: r.price ?? 0,
        change_pct: r.change_pct,
        rel_vol: +(fast / 100).toFixed(1),   // display in ×, like detector rel-vol
        mom_pct: 0,
        status: 'accum',
        caught_at: new Date(nowMs).toISOString(),
        confirmed_at: null,
        watch_change_pct: null,
        last_event_ms: nowMs,
        screened_at_watch: true,             // born from a screen — screen presence ≠ confirmation
        accum_entry_chg: r.change_pct,
        accum_peak: r.change_pct,
      });
      console.log(
        `[accum] 🤫 ${r.ticker} $${(r.price ?? 0).toFixed(2)} +${r.change_pct.toFixed(1)}% · ` +
        `fastRV ${Math.round(fast)}% · dayRV ${r.rel_volume?.toFixed(1) ?? '?'}x · ${session}`,
      );
      const bullishNews = !!r.has_today_news && r.catalyst?.direction === 'bullish';
      recordTierEvent('accum', 'flag', r.ticker, {
        source: 'screen', chg: r.change_pct, price: r.price, fast_rv: Math.round(fast),
        day_rv: r.rel_volume, float_m: r.float_m, session, bullish_news: bullishNews,
      });
      if (
        !firstPoll && telegramEnabled() && !this.alertsMuted &&
        !this.alertedAccum.has(r.ticker) && bullishNews
      ) {
        this.alertedAccum.add(r.ticker);
        void sendTelegram(formatAccumAlert(r, fast, bullishNews));
      }
    }
  }

  // Live tick-feed state-machine event (👀/🛰️) — TickFeedService's detector
  // flagged, confirmed, or faded a name on the Databento per-second tape.
  // WATCH (price-led, baseline-free) typically lands 20–40 chg-points before
  // the old volume-confirmed rule; CONFIRM is the conviction ping (the
  // validated surge rule, the baseline-free sustain read, or — handled in the
  // payload build — a Finviz screen picking the name up). Both tiers push to
  // Telegram + dashboard, deduped once per ticker per ET day PER TIER, so a
  // real runner gives exactly two pings: early flag, then confirmation.
  onTickEvent(e: TickEvent): void {
    const nowMs = Date.now();
    const existing = this.tickCatches.get(e.ticker);
    // Detector-side 🤫 (2026-07-08, the SLS case) — sub-10% accumulation on
    // the per-second tape, screen-independent. Enters the same ladder as the
    // screen-side accum scan; `accumSeen` is shared so a name flags once per
    // day regardless of which side saw it first. Dashboard-only (no Telegram)
    // until tier_events grades this source's precision.
    if (e.type === 'accum') {
      if (existing || this.accumSeen.has(e.ticker)) return;
      this.accumSeen.add(e.ticker);
      this.tickCatches.set(e.ticker, {
        ticker: e.ticker,
        price: e.price,
        change_pct: e.change_pct,
        rel_vol: e.rel_vol,
        mom_pct: e.mom_pct,
        status: 'accum',
        caught_at: new Date(nowMs).toISOString(),
        confirmed_at: null,
        watch_change_pct: null,
        last_event_ms: nowMs,
        screened_at_watch: false,   // not from a screen — a later screen pickup IS fresh evidence
        accum_entry_chg: e.change_pct,
      });
      console.log(
        `[accum] 🤫 ${e.ticker} $${e.price.toFixed(2)} +${e.change_pct.toFixed(1)}% · ` +
        `${e.rel_vol}x quiet-baseline · +${e.mom_pct.toFixed(0)}%/60s · tick-detector (sub-screen)`,
      );
      recordTierEvent('accum', 'flag', e.ticker, {
        source: 'tick', chg: e.change_pct, price: e.price, rel_vol: e.rel_vol, mom: e.mom_pct,
      });
      return;
    }
    if (e.type === 'watch') {
      // An accumulation flag graduating to a price watch — the ladder's first
      // promotion. The accum tier already vetted the name (quiet + volume on
      // a screen), so the stale/on-screen suppression below doesn't apply.
      if (existing?.status === 'accum') {
        const mins = Math.round((nowMs - Date.parse(existing.caught_at)) / 60000);
        const pts = existing.accum_entry_chg != null ? e.change_pct - existing.accum_entry_chg : null;
        existing.status = 'watch';
        existing.price = e.price;
        existing.change_pct = e.change_pct;
        existing.rel_vol = e.rel_vol;
        existing.mom_pct = e.mom_pct;
        existing.watch_change_pct = e.change_pct;
        existing.last_event_ms = nowMs;
        console.log(
          `[accum] ↗ 👀 watch ${e.ticker} +${e.change_pct.toFixed(1)}% — ` +
          `${mins}min after the 🤫 flag${pts != null ? ` (+${pts.toFixed(1)}pts)` : ''}`,
        );
        recordTierEvent('accum', 'promote', e.ticker, { via: 'tick', chg: e.change_pct, minutes: mins, pts });
        if (telegramEnabled() && !this.alertsMuted && !this.alertedTickWatch.has(e.ticker)) {
          this.alertedTickWatch.add(e.ticker);
          void sendTelegram(formatTickWatchAlert(e));
        }
        return;
      }
      if (existing) return; // shouldn't happen (detector watches once/day) — keep idempotent
      // Evidence gate — see TICK_WATCH_EVIDENCE. Drift-crossers (slow grind
      // to +10% with no volume and no momentum) don't earn a watch; the
      // detector keeps its anchor, so surge/sustain can still confirm later.
      if (e.rel_vol < TICK_WATCH_EVIDENCE.rel_vol_min && e.mom_pct < TICK_WATCH_EVIDENCE.mom_min) {
        console.log(
          `[tickfeed] 👀 watch ${e.ticker} suppressed — low evidence at cross ` +
          `(${e.rel_vol}x rv, +${e.mom_pct.toFixed(0)}%/60s); confirm paths stay live`,
        );
        recordTierEvent('tick', 'watch_suppressed', e.ticker, {
          reason: 'low_evidence', chg: e.change_pct, rel_vol: e.rel_vol, mom: e.mom_pct,
        });
        return;
      }
      // Suppress only STALE watches on already-screened names: first sight was
      // already above the watch line (restart re-seeing an old move, mid-move
      // subscribe) AND the screens already show it — a 👀 there is old news.
      // A FRESH cross (we observed the name trade below the line, then cross
      // it) alerts even when the name is on a screen: a non-catalyst screen
      // row generates no push of its own, so the watch ping IS the operator's
      // early warning (the missed-AUID case, 2026-07-02).
      // Before the first poll cycle broadcasts, screen state is UNKNOWN
      // (lastPayload null) — treat that as screened for stale watches, else
      // every deploy re-pings the names already running (CWD +87% at boot).
      const payloadReady = this.lastPayload !== null;
      const onScreen = this.isCurrentlyScreened(e.ticker);
      if (!e.fresh_cross && (onScreen || !payloadReady)) {
        console.log(
          `[tickfeed] 👀 watch ${e.ticker} suppressed — stale (first sight already +${e.change_pct.toFixed(0)}%), ` +
          (payloadReady ? 'on a screen' : 'boot, screens unknown'),
        );
        recordTierEvent('tick', 'watch_suppressed', e.ticker, {
          reason: payloadReady ? 'stale_on_screen' : 'stale_boot', chg: e.change_pct,
        });
        return;
      }
      this.tickCatches.set(e.ticker, {
        ticker: e.ticker,
        price: e.price,
        change_pct: e.change_pct,
        rel_vol: e.rel_vol,
        mom_pct: e.mom_pct,
        status: 'watch',
        caught_at: new Date(nowMs).toISOString(),
        confirmed_at: null,
        watch_change_pct: e.change_pct,
        last_event_ms: nowMs,
        screened_at_watch: onScreen,
      });
      console.log(
        `[tickfeed] 👀 watch ${e.ticker} $${e.price.toFixed(2)} ` +
        `${e.change_pct >= 0 ? '+' : ''}${e.change_pct.toFixed(1)}% · ${e.rel_vol}x rv · +${e.mom_pct.toFixed(0)}%/60s` +
        ` · ${e.fresh_cross ? 'fresh cross' : 'seen mid-move'}${onScreen ? ', on screen' : ''}`,
      );
      recordTierEvent('tick', 'watch', e.ticker, {
        chg: e.change_pct, price: e.price, rel_vol: e.rel_vol, mom: e.mom_pct,
        fresh_cross: !!e.fresh_cross, on_screen: onScreen,
      });
      if (telegramEnabled() && !this.alertsMuted && !this.alertedTickWatch.has(e.ticker)) {
        this.alertedTickWatch.add(e.ticker);
        void sendTelegram(formatTickWatchAlert(e));
      }
      return;
    }
    if (e.type === 'confirm') {
      const watchChg = e.watch_change_pct ?? existing?.watch_change_pct ?? null;
      this.tickCatches.set(e.ticker, {
        ticker: e.ticker,
        price: e.price,
        change_pct: e.change_pct,
        rel_vol: e.rel_vol,
        mom_pct: e.mom_pct,
        status: 'confirmed',
        caught_at: existing?.caught_at ?? new Date(nowMs).toISOString(),
        confirmed_at: new Date(nowMs).toISOString(),
        watch_change_pct: watchChg,
        last_event_ms: nowMs,
      });
      console.log(
        `[tickfeed] 🛰️ confirm(${e.via ?? 'surge'}) ${e.ticker} $${e.price.toFixed(2)} ` +
        `${e.change_pct >= 0 ? '+' : ''}${e.change_pct.toFixed(1)}%` +
        (watchChg != null ? ` (watched at +${watchChg.toFixed(1)}%)` : '') +
        ` · ${e.rel_vol}x rv · +${e.mom_pct.toFixed(0)}%/60s` +
        (e.notional != null ? ` · $${Math.round(e.notional / 1000)}k since flag` : ''),
      );
      recordTierEvent('tick', 'confirm', e.ticker, {
        via: e.via ?? 'surge', chg: e.change_pct, price: e.price, watch_chg: watchChg,
        rel_vol: e.rel_vol, mom: e.mom_pct, notional: e.notional ?? null,
      });
      if (telegramEnabled() && !this.alertsMuted && !this.alertedTickCatch.has(e.ticker)) {
        this.alertedTickCatch.add(e.ticker);
        void sendTelegram(formatTickConfirmAlert(e.ticker, e.price, e.change_pct, e.rel_vol, e.mom_pct, watchChg, e.via ?? 'surge'));
      }
      return;
    }
    // fade — mark for the grey linger; the payload build prunes it shortly.
    if (existing && existing.status === 'watch') {
      existing.status = 'faded';
      existing.price = e.price;
      existing.change_pct = e.change_pct;
      existing.last_event_ms = nowMs;
      console.log(
        `[tickfeed] 💤 fade ${e.ticker} ${e.change_pct >= 0 ? '+' : ''}${e.change_pct.toFixed(1)}%` +
        (e.watch_change_pct != null ? ` (watched at +${e.watch_change_pct.toFixed(1)}%)` : ''),
      );
      recordTierEvent('tick', 'fade', e.ticker, { chg: e.change_pct, watch_chg: e.watch_change_pct ?? null });
    }
  }

  // Fresh-burst alert — see the FRESH_BURST block for the evidence and tuning.
  // Iterates the enriched UNION (a fresh runner is usually ignition-first by
  // 40s–2min, less extended than when Momentum catches it), gated to the first
  // window_ms after a ticker's first sight today. Volume evidence is the
  // fastest read available: the cold-start 1-min/5-min RVol, or — outside
  // premarket, where day-RVol actually means something — an instant day-RVol
  // on the very first cycle. PM + regular sessions only: an after-hours burst
  // alert read hours later is noise, and the standard alerts cover AH.
  private pushFreshBurstAlerts(rows: Iterable<EnrichedRow>, session: TradingSession): void {
    if (!telegramEnabled() || this.alertsMuted) return;
    if (session !== 'premarket' && session !== 'regular') return;
    const nowMs = Date.now();
    for (const r of rows) {
      if (this.alertedFreshBurst.has(r.ticker)) continue;
      const firstMs = this.firstSeenAt.get(r.ticker);
      if (firstMs === undefined || nowMs - firstMs > FRESH_BURST.window_ms) continue;
      if (r.float_m == null || r.float_m > FRESH_BURST.float_max_m) continue;
      if (r.change_pct == null || r.change_pct < FRESH_BURST.chg_min) continue;
      // Over the cap = the start is already missed. Skip WITHOUT dedup so a
      // pullback under the cap later in the window still earns the alert.
      if (r.change_pct > FRESH_BURST.chg_max) continue;
      if (r.catalyst?.direction === 'bearish') continue;
      const fast = Math.max(r.rel_vol_1min ?? 0, r.rel_vol_5min ?? 0);
      const instantDay =
        session !== 'premarket' && (r.rel_volume ?? 0) >= FRESH_BURST.rvol_day_min;
      if (fast < FRESH_BURST.rvol_fast_min && !instantDay) continue;
      this.alertedFreshBurst.add(r.ticker);
      void sendTelegram(formatFreshBurstAlert(r, Math.round((nowMs - firstMs) / 1000)));
    }
  }

  // Dual-signal alert — fires the first time a Continuation ticker (≥ 2 days
  // of Ignition history) also clears the live Ignition score floor on the
  // same cycle. The CODX-day-2/3 trigger: the *confirmation* that the move
  // is multi-day, not just a one-session pump. Dedup once per ticker per ET
  // day. Bullish-only: a continuation candidate with a fresh bearish
  // catalyst is a fade-in-progress, not a runner. No entry-change% cap here
  // because the multi-day prior is itself the entry-quality filter (these
  // names are already extended *by design* — we want to alert the trader
  // anyway so they can read the chart and decide).
  private pushDualSignalAlerts(rows: IgnitionRow[]): void {
    if (!telegramEnabled() || this.alertsMuted) return;
    if (this.lastContinuation.length === 0) return;
    // Index the continuation list once per cycle for O(1) ticker lookup.
    const contBy = new Map<string, ContinuationCandidate>();
    for (const c of this.lastContinuation) contBy.set(c.ticker, c);
    for (const r of rows) {
      const cont = contBy.get(r.ticker);
      if (!cont) continue;
      if (this.alertedDualSignal.has(r.ticker)) continue;
      if (r.runner_score < DUAL_SIGNAL.min_ignition_score) continue;
      // Skip bearish catalysts and crashing moves — same direction-awareness
      // as the Ignition alert path.
      if (r.catalyst?.direction === 'bearish') continue;
      if (r.change_pct != null && r.change_pct < 0) continue;
      this.alertedDualSignal.add(r.ticker);
      void sendTelegram(formatDualSignalAlert(r, cont));
    }
  }

  // Telegram alert for a Swing row — once per ticker per ET day. Trigger:
  // swing_score ≥ SWING.alert_score AND either the 10-day breakout flag is
  // set OR a bullish strong/major catalyst landed this cycle. The catalyst
  // clause matches the alert criteria in docs/swing-screener-spec.md §7 —
  // a fresh durable catalyst is alert-worthy even on a clean trend without
  // a textbook breakout. Bearish catalysts never alert.
  private pushSwingAlerts(rows: SwingRow[]): void {
    if (!telegramEnabled() || this.alertsMuted) return;
    for (const r of rows) {
      if (this.alertedSwing.has(r.ticker)) continue;
      if (r.swing_score < SWING.alert_score) continue;
      const c = r.catalyst;
      const freshBullishCatalyst =
        r.is_fresh_news &&
        c != null &&
        c.direction === 'bullish' &&
        (c.urgency === 'strong' || c.urgency === 'major');
      // broke_out / broke_out_5d = day-1 / day-2 of a fresh cross of the
      // prior 15-bar high (v2 semantics) — the *starting* breakout. A stale
      // "still above the range" no longer alerts; that was the old flag's
      // alerted-into-the-parabola failure mode.
      if (!r.setup_flags.broke_out && !r.setup_flags.broke_out_5d && !freshBullishCatalyst) continue;
      this.alertedSwing.add(r.ticker);
      void sendTelegram(formatSwingAlert(r));
    }
  }
}

export const poller = new PollerService();

// Render a screener row as a Telegram HTML-mode message.
function formatTelegramAlert(r: EnrichedRow): string {
  const c = r.catalyst!;
  const emoji = r.news_source === 'halt' ? '🛑' : c.urgency === 'major' ? '🔥' : '🚨';
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(1)}%`;

  const meta: string[] = [];
  if (r.float_m != null) meta.push(`float ${r.float_m.toFixed(1)}M`);
  if (r.rel_volume != null) meta.push(`RVol ${Math.round(r.rel_volume)}x`);
  if (r.status) meta.push(r.status);

  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.ticker)}`;
  const links = [`<a href="${escapeHtml(r.finviz_url)}">Finviz</a>`, `<a href="${tv}">TradingView</a>`];
  if (r.news_url) links.unshift(`<a href="${escapeHtml(r.news_url)}">News</a>`);

  const lines = [
    `${emoji} <b>${escapeHtml(r.ticker)}</b>  ${price}  ${chg}`.trimEnd(),
    meta.join(' · '),
    `<b>${c.urgency.toUpperCase()}</b> catalyst · score ${c.score} · ${escapeHtml(c.type)} (${c.direction})`,
    r.news_title ? `“${escapeHtml(r.news_title)}”${r.news_source ? ` — ${r.news_source}` : ''}` : '',
    c.risk_flags.length > 0 ? `⚠️ ${escapeHtml(c.risk_flags.join(', '))}` : '',
    shelfAlertLine(r.shelf),
    links.join(' · '),
  ];
  return lines.filter(Boolean).join('\n');
}

// One-line dilution warning for a Telegram alert. Empty when no shelf is on
// file — the kill-switch line only shows when there is something to flag.
function shelfAlertLine(s: ShelfInfo | null): string {
  if (!s) return '';
  const label =
    s.level === 'active' ? 'ACTIVE OFFERING'
    : s.level === 'effective' ? 'EFFECTIVE SHELF'
    : 'SHELF ON FILE';
  return `⚠️ ${label} · dilution risk — ${escapeHtml(s.latest_form)}, ${s.days_since}d ago`;
}

// Render an Ignition row as a Telegram HTML-mode message.
function formatIgnitionAlert(r: IgnitionRow): string {
  const b = r.score_breakdown;
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(1)}%`;
  const meta: string[] = [];
  if (r.float_m != null) meta.push(`float ${r.float_m.toFixed(1)}M`);
  if (r.rel_vol_5min != null) meta.push(`RVol5m ${Math.round(r.rel_vol_5min)}%`);
  if (r.rel_vol_1min != null) meta.push(`RVol1m ${Math.round(r.rel_vol_1min)}%`);
  if (r.catalyst) meta.push(`catalyst ${r.catalyst.score}`);
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.ticker)}`;
  const lines = [
    `⚡ <b>${escapeHtml(r.ticker)}</b>  ${price}  ${chg}`.trimEnd(),
    `<b>Ignition ${r.runner_score}</b> · float ${b.float} / vol ${b.volume} / cat ${b.catalyst} / mat ${b.maturity} / pm ${b.premarket} / shelf ${b.shelf}`,
    meta.join(' · '),
    r.news_title ? `“${escapeHtml(r.news_title)}”` : '',
    shelfAlertLine(r.shelf),
    `<a href="${escapeHtml(r.finviz_url)}">Finviz</a> · <a href="${tv}">TradingView</a>`,
  ];
  return lines.filter(Boolean).join('\n');
}

// Render a new-ignition heads-up — a freshly-appeared ignition building into
// the 40–64 band (see NEW_IGNITION). Same shape as the ignition alert but
// flagged as a building/early signal, not high-conviction.
function formatNewIgnitionAlert(r: IgnitionRow, ageSec: number): string {
  const b = r.score_breakdown;
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(1)}%`;
  const age = ageSec < 60 ? `${ageSec}s` : `${Math.round(ageSec / 60)}m`;
  const meta: string[] = [`seen ${age} ago`];
  if (r.float_m != null) meta.push(`float ${r.float_m.toFixed(1)}M`);
  if (r.rel_vol_1min != null) meta.push(`RVol1m ${Math.round(r.rel_vol_1min)}%`);
  if (r.rel_vol_5min != null) meta.push(`RVol5m ${Math.round(r.rel_vol_5min)}%`);
  if (r.catalyst) meta.push(`catalyst ${r.catalyst.score}`);
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.ticker)}`;
  const lines = [
    `🆕 <b>${escapeHtml(r.ticker)}</b>  ${price}  ${chg}`.trimEnd(),
    `<b>New ignition ${r.runner_score}</b> (building) · float ${b.float} / vol ${b.volume} / cat ${b.catalyst} / mat ${b.maturity}`,
    meta.join(' · '),
    r.news_title ? `“${escapeHtml(r.news_title)}”` : '',
    shelfAlertLine(r.shelf),
    `<a href="${escapeHtml(r.finviz_url)}">Finviz</a> · <a href="${tv}">TradingView</a>`,
  ];
  return lines.filter(Boolean).join('\n');
}

// Render a news-radar hit (📰) — a strong/major catalyst just landed on a
// known runner that is NOT moving yet. The measured edge: moves typically
// start minutes after the wire, so this is the "get eyes on the chart before
// the crowd" ping. Deliberately headline-forward.
function formatNewsRadarAlert(item: NewsRadarItem): string {
  const finviz = `https://finviz.com/quote.ashx?t=${encodeURIComponent(item.ticker)}`;
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(item.ticker)}`;
  const meta = [`impact ${item.impact}`, `hype ${item.hype}`, item.catalyst_type];
  const lines = [
    `📰 <b>${escapeHtml(item.ticker)}</b>  fresh catalyst, not moving yet`,
    `<b>NEWS RADAR</b> — known runner; moves often start minutes after the wire`,
    meta.join(' · '),
    `“${escapeHtml(item.title)}”`,
    `<a href="${finviz}">Finviz</a> · <a href="${tv}">TradingView</a>`,
  ];
  return lines.join('\n');
}

// Render a quiet-accumulation flag (🤫) — the earliest tier: volume arriving
// while price is still flat. Only the violent tail (or accumulation with a
// bullish catalyst riding along) reaches Telegram; the dashboard shows all.
function formatAccumAlert(r: EnrichedRow, fastRv: number, bullishNews: boolean): string {
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `+${r.change_pct.toFixed(1)}%`;
  const finviz = `https://finviz.com/quote.ashx?t=${encodeURIComponent(r.ticker)}`;
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.ticker)}`;
  const meta: string[] = [`fastRV ${Math.round(fastRv / 100)}×`];
  if (r.rel_volume != null) meta.push(`dayRV ${r.rel_volume.toFixed(1)}×`);
  if (r.float_m != null) meta.push(`float ${r.float_m.toFixed(1)}M`);
  const lines = [
    `🤫 <b>${escapeHtml(r.ticker)}</b>  ${price}  ${chg}`.trimEnd(),
    `<b>QUIET ACCUMULATION</b> — volume arriving, price still flat`,
    meta.join(' · '),
    bullishNews && r.news_title ? `“${escapeHtml(r.news_title)}”` : '',
    `<a href="${finviz}">Finviz</a> · <a href="${tv}">TradingView</a>`,
  ];
  return lines.filter(Boolean).join('\n');
}

// Render a tick-feed WATCH flag (👀) — the price-led early tier: the name just
// crossed the watch line on the per-second tape, volume confirmation pending.
// Deliberately minimal: the value is getting eyes on the chart 20–40 chg-points
// before the volume-confirmed ping.
function formatTickWatchAlert(e: TickEvent): string {
  const price = `$${e.price.toFixed(2)}`;
  const chg = `${e.change_pct >= 0 ? '+' : ''}${e.change_pct.toFixed(1)}%`;
  const finviz = `https://finviz.com/quote.ashx?t=${encodeURIComponent(e.ticker)}`;
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(e.ticker)}`;
  const evidence = [`+${e.mom_pct.toFixed(0)}%/60s`];
  if (e.rel_vol > 0) evidence.unshift(`RVol ${e.rel_vol.toFixed(1)}x`);
  const lines = [
    `👀 <b>${escapeHtml(e.ticker)}</b>  ${price}  ${chg}`,
    `<b>TICK WATCH</b> — price-led early flag, confirmation pending`,
    evidence.join(' · '),
    `<a href="${finviz}">Finviz</a> · <a href="${tv}">TradingView</a>`,
  ];
  return lines.join('\n');
}

// Render a CONFIRMED tick catch (🛰️) — the conviction tier. `via` says what
// confirmed it: the validated relvol surge rule, the baseline-free sustain
// read, or a Finviz screen returning the name. Shows the watch-flag chg% so
// the lead the early tier bought is visible in the alert itself.
function formatTickConfirmAlert(
  ticker: string, price: number, changePct: number, relVol: number, momPct: number,
  watchChangePct: number | null, via: 'surge' | 'sustain' | 'screen',
): string {
  const chg = `${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%`;
  const finviz = `https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}`;
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(ticker)}`;
  const viaLabel = via === 'surge' ? 'volume surge' : via === 'sustain' ? 'sustained tape' : 'hit the screens';
  const evidence: string[] = [];
  if (relVol > 0) evidence.push(`RVol ${relVol.toFixed(1)}x`);
  evidence.push(`+${momPct.toFixed(0)}%/60s`);
  if (watchChangePct != null) evidence.push(`flagged at +${watchChangePct.toFixed(0)}%`);
  const lines = [
    `🛰️ <b>${escapeHtml(ticker)}</b>  $${price.toFixed(2)}  ${chg}`,
    `<b>LIVE TICK CONFIRMED</b> — ${viaLabel}`,
    evidence.join(' · '),
    `<a href="${finviz}">Finviz</a> · <a href="${tv}">TradingView</a>`,
  ];
  return lines.join('\n');
}

// Render a fresh-burst alert — a just-appeared nano-float with a violent
// early volume read (see FRESH_BURST). Deliberately light on score context:
// the whole point is speed — the operator opens the chart and decides.
function formatFreshBurstAlert(r: EnrichedRow, ageSec: number): string {
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(1)}%`;
  const meta: string[] = [`seen ${ageSec}s ago`];
  if (r.float_m != null) meta.push(`float ${r.float_m.toFixed(1)}M`);
  if (r.rel_vol_1min != null) meta.push(`RVol1m ${Math.round(r.rel_vol_1min)}%`);
  if (r.rel_vol_5min != null) meta.push(`RVol5m ${Math.round(r.rel_vol_5min)}%`);
  if (r.rel_volume != null) meta.push(`RVolDay ${r.rel_volume.toFixed(1)}x`);
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.ticker)}`;
  const lines = [
    `🚀 <b>${escapeHtml(r.ticker)}</b>  ${price}  ${chg}`.trimEnd(),
    `<b>FRESH BURST</b> — just hit the screens on violent volume`,
    meta.join(' · '),
    r.news_title ? `“${escapeHtml(r.news_title)}”` : '',
    shelfAlertLine(r.shelf),
    `<a href="${escapeHtml(r.finviz_url)}">Finviz</a> · <a href="${tv}">TradingView</a>`,
  ];
  return lines.filter(Boolean).join('\n');
}

// Render a dual-signal alert — a Continuation candidate (≥ 2 days of
// Ignition history) that also has a meaningful live Ignition score this
// cycle. The narrative is "this isn't day 1 — the move is confirming";
// the message leads with the day count + score trajectory rather than
// the raw runner-score, then folds in the live Ignition meta + catalyst.
function formatDualSignalAlert(r: IgnitionRow, c: ContinuationCandidate): string {
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(1)}%`;
  const firstSeenMd = c.first_seen.slice(5);  // MM-DD
  // Lead with the multi-day context: active days in the run + cumulative move
  // off the base, then the live runner-score. screen_days < days_in_run means
  // the daily bar carried some of the run that the screens didn't re-flag.
  const fromBase =
    c.from_base_pct != null
      ? ` · ${c.from_base_pct >= 0 ? '+' : ''}${c.from_base_pct.toFixed(0)}% from base`
      : '';
  const screenNote = c.screen_days < c.days_in_run ? ` (${c.screen_days} on screen)` : '';
  const trajectory = `Day ${c.days_in_run}${screenNote} · ignition ${Math.round(r.runner_score)} now${fromBase}`;
  const meta: string[] = [];
  if (r.float_m != null) meta.push(`float ${r.float_m.toFixed(1)}M`);
  if (r.rel_vol_5min != null) meta.push(`RVol5m ${Math.round(r.rel_vol_5min)}%`);
  if (r.rel_vol_1min != null) meta.push(`RVol1m ${Math.round(r.rel_vol_1min)}%`);
  if (r.catalyst) meta.push(`catalyst ${r.catalyst.score}`);
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.ticker)}`;
  const lines = [
    `🎯 <b>${escapeHtml(r.ticker)}</b>  ${price}  ${chg}`.trimEnd(),
    `<b>${trajectory}</b> · first seen ${firstSeenMd} · multi-day setup confirming`,
    meta.join(' · '),
    r.news_title ? `“${escapeHtml(r.news_title)}”` : '',
    shelfAlertLine(r.shelf),
    `<a href="${escapeHtml(r.finviz_url)}">Finviz</a> · <a href="${tv}">TradingView</a>`,
  ];
  return lines.filter(Boolean).join('\n');
}

// Render a Swing row as a Telegram HTML-mode message. The flag strip
// surfaces the trigger reason at a glance — 📈 base/breakout pattern,
// 🔥 fresh catalyst — and the daily-context line carries the
// swing-trader's eye-line metrics (vs 52WH, vs 20-SMA, Vol×Avg).
function formatSwingAlert(r: SwingRow): string {
  const b = r.score_breakdown;
  const ctx = r.daily_context;
  const flags = r.setup_flags;
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(1)}%`;

  // Eye-line metrics — empty when the daily-bar context wasn't deep enough.
  const eyes: string[] = [];
  if (ctx.dist_52w_high_pct != null) {
    eyes.push(`52WH ${ctx.dist_52w_high_pct >= 0 ? '+' : ''}${ctx.dist_52w_high_pct.toFixed(1)}%`);
  }
  if (ctx.sma_20 != null && r.price != null && ctx.sma_20 > 0) {
    const pct = ((r.price - ctx.sma_20) / ctx.sma_20) * 100;
    eyes.push(`20SMA ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`);
  }
  if (r.volume != null && ctx.avg_volume_20 != null && ctx.avg_volume_20 > 0) {
    eyes.push(`Vol×Avg ${(r.volume / ctx.avg_volume_20).toFixed(1)}×`);
  }

  // Trigger label — what got this past the gate.
  const trigger = flags.broke_out
    ? '📈 fresh breakout (day 1)'
    : flags.broke_out_5d
      ? '📈 breakout day 2'
      : '🔥 fresh catalyst';

  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.ticker)}`;
  const lines = [
    `📊 <b>${escapeHtml(r.ticker)}</b>  ${price}  ${chg}`.trimEnd(),
    `<b>Swing ${r.swing_score}</b> · ${trigger} · volat ${b.volatility} / room ${b.room} / trig ${b.trigger} / vol ${b.volume} / ext ${b.extension} / shelf ${b.shelf}`,
    eyes.join(' · '),
    r.catalyst && r.news_title ? `“${escapeHtml(r.news_title)}”` : '',
    shelfAlertLine(r.shelf),
    `<a href="${escapeHtml(r.finviz_url)}">Finviz</a> · <a href="${tv}">TradingView</a>`,
  ];
  return lines.filter(Boolean).join('\n');
}

function nowHms(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function etDateString(dt: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt);
}

// Minute-of-day in ET (0–1439). Used for the Swing post-close trigger
// (16:30 ET = 990); cheaper than re-running the full Intl parse twice.
function etMinuteOfDay(at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;
  return hour * 60 + parseInt(parts.minute, 10);
}

// Maps a moment to its US-equities trading session by ET wall-clock:
//   premarket   04:00–09:30 ET
//   regular     09:30–16:00 ET
//   afterhours  16:00–20:00 ET
//   closed      everything else (overnight + weekends)
// Holidays are not special-cased — on a holiday Finviz simply returns no
// movers, so the session label is cosmetically off but the screen is empty.
function currentEtSession(at: Date): TradingSession {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'closed';
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // some ICU builds emit '24' for midnight
  const mins = hour * 60 + parseInt(parts.minute, 10);
  if (mins >= 240 && mins < 570) return 'premarket';   // 04:00–09:30
  if (mins >= 570 && mins < 960) return 'regular';     // 09:30–16:00
  if (mins >= 960 && mins < 1200) return 'afterhours'; // 16:00–20:00
  return 'closed';
}

// Finviz news dates look like "2026-05-03 09:31:00" with no TZ — they're ET-local.
// Convert to a Date by treating as ET wall-clock time.
function parseEtNaiveAsDate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  // Build an ISO string with -05:00 / -04:00 offset depending on DST.
  // Cheapest correct approach: build a UTC time from ET wall-clock by asking
  // Intl what the offset is on that date.
  const utcGuess = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const offsetMs = etOffsetMs(utcGuess);
  return new Date(utcGuess.getTime() - offsetMs);
}

function parseEtNaiveAsIso(s: string): string | null {
  const dt = parseEtNaiveAsDate(s);
  return dt ? dt.toISOString() : null;
}

function etOffsetMs(at: Date): number {
  // Get ET clock components for `at`, then compute the difference between
  // that clock and UTC clock.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  const etMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return etMs - at.getTime();
}

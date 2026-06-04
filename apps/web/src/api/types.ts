export interface User {
  id: string;
  username: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}

// ─── screener ──────────────────────────────────────────────────────────────
export type RowStatus = 'NEW' | 'ACC' | 'UP' | 'NEWS' | null;
export type NewsSource = 'finviz' | 'yahoo' | 'benzinga' | 'sec' | 'halt';
export type CatalystDirection = 'bullish' | 'bearish' | 'mixed' | 'neutral';
export type CatalystUrgency = 'ignore' | 'watch' | 'strong' | 'major';
export type Classifier = 'rules' | 'openai_nano' | 'openai_mini' | 'openai';

export interface CatalystInfo {
  score: number;
  urgency: CatalystUrgency;
  direction: CatalystDirection;
  type: string;
  reason: string;
  risk_flags: string[];
  classifier: Classifier;
}

// Effective-shelf / dilution status from a 12-month SEC submissions lookback.
//   'shelf'     — a registration statement on file, not yet known-effective
//   'effective' — the loaded gun: an effective shelf, no recent takedown
//   'active'    — a 424B* prospectus within 90d: shares are being sold now
export type ShelfLevel = 'shelf' | 'effective' | 'active';

export interface ShelfInfo {
  level: ShelfLevel;
  latest_form: string;
  latest_filed_at: string;
  days_since: number;
  forms: string[];
}

export interface ScreenerFilterSnapshot {
  filter: string;
  float_max_m: number;
  top_n: number;
  accel_threshold: number;
  interval_sec: number;
}

export interface EnrichedRow {
  ticker: string;
  change_pct: number | null;
  float_m: number | null;
  float_is_proxy: boolean;
  price: number | null;
  volume: number | null;
  avg_volume: number | null;
  rel_volume: number | null;
  vol_5min: number | null;
  rel_vol_5min: number | null;
  mcap_m: number | null;
  country: string | null;
  company: string | null;
  sector: string | null;
  industry: string | null;
  short_float_pct: number | null;
  short_ratio: number | null;
  insider_own_pct: number | null;
  insider_trans_pct: number | null;
  inst_own_pct: number | null;
  inst_trans_pct: number | null;
  shares_out_m: number | null;
  status: RowStatus;
  prev_change_pct: number | null;
  accel_delta: number | null;
  // Anchored VWAP since first detection today. Persists across PM → regular →
  // AH so a pre-market spike's volume keeps weighting the indicator (matches a
  // chart's day-session VWAP). Null on cycle 1 (no delta yet) and whenever
  // price/volume is missing. Resets at midnight ET.
  vwap: number | null;
  above_vwap: boolean | null;
  is_fresh_news: boolean;
  has_today_news: boolean;
  news_title: string | null;
  news_source: NewsSource | null;
  news_url: string | null;
  finviz_url: string;
  catalyst: CatalystInfo | null;
  shelf: ShelfInfo | null;
}

export interface RunnerScoreBreakdown {
  float: number;
  volume: number;
  catalyst: number;
  earliness: number;
  halt: number;
  shelf: number;
}

// An enriched row from the Ignition screener — Momentum row fields + runner-score.
export interface IgnitionRow extends EnrichedRow {
  runner_score: number;
  score_breakdown: RunnerScoreBreakdown;
  // True for the first ~2 minutes a ticker is in the Ignition set — drives the
  // sidebar's pinned "New" section.
  is_new: boolean;
}

export interface SwingScoreBreakdown {
  trend: number;
  strength: number;
  setup: number;        // composite: base + breakout + close strength
  volume: number;
  catalyst: number;
  shelf: number;        // ≤ 0 — penalty
}

export interface SwingSetupFlags {
  in_base: boolean;
  broke_out: boolean;       // the 10-day breakout — the alert trigger
  broke_out_5d: boolean;    // smaller 5-day breakout
  close_in_top_q: boolean;
}

export interface SwingDailyContext {
  sma_20: number | null;
  sma_50: number | null;
  sma_200: number | null;
  high_52w: number | null;
  atr_14: number | null;
  avg_volume_20: number | null;
  dist_52w_high_pct: number | null;  // (price - high_52w) / high_52w * 100
}

// A Momentum-style enriched row plus its Swing-screener score and the daily-
// bar context snapshot the score was computed from. See docs/swing-screener-spec.md.
export interface SwingRow extends EnrichedRow {
  swing_score: number;
  score_breakdown: SwingScoreBreakdown;
  setup_flags: SwingSetupFlags;
  daily_context: SwingDailyContext;
}

// One row of the History-by-day endpoint — per-(ticker, session) aggregation
// of one ET trading day's worth of either the Ignition or Momentum screen.
// `peak_score` is populated for Ignition rows; `status` is populated for
// Momentum rows. Catalyst fields are the day's most-impactful classification
// for the ticker (left-joined, null when none).
export interface HistoryByDayRow {
  ticker: string;
  session: TradingSession;
  ticks: number;
  first_at: string;
  last_at: string;
  peak_score: number | null;
  status: RowStatus;
  min_chg: number | null;
  max_chg: number | null;
  min_price: number | null;
  max_price: number | null;
  catalyst_score: number | null;
  catalyst_direction: string | null;
  catalyst_urgency: string | null;
  catalyst_type: string | null;
  news_title: string | null;
  news_source: string | null;
}

export type HistoryByDayScreen = 'ignition' | 'momentum';

// ─── outcomes / backtest view ────────────────────────────────────────────────
export type OutcomesGroupBy =
  | 'catalyst_direction'
  | 'catalyst_urgency'
  | 'shelf_level'
  | 'score_bucket'
  | 'extension_bucket'
  | 'screen';
export type OutcomesHorizon = 1 | 3 | 5;
export type OutcomesScreen = 'all' | 'momentum' | 'ignition' | 'swing';

export interface OutcomeSummaryBucket {
  bucket: string;
  n: number;
  avg_chg: number | null;       // avg chg over the selected horizon (%)
  avg_peak: number | null;      // avg peak_5d (best case, %)
  avg_drawdown: number | null;  // avg drawdown_5d (worst case, %)
  win_rate: number | null;      // % of rows with chg > 0
}

// Auto-detected pump-and-dump offender (from screener_outcomes). A ticker that
// spiked then closed deeply red in-window at least once. Global, not per-user.
export interface BurnedTicker {
  ticker: string;
  events: number;          // # of pump-and-dump events on record
  last_event: string;      // YYYY-MM-DD of the most recent event
  max_peak: number | null;
  worst_chg: number | null;
  avg_drawdown: number | null;
}

export interface OutcomeSummaryResponse {
  group_by: OutcomesGroupBy;
  horizon: OutcomesHorizon;
  screen: OutcomesScreen;
  coverage: { total: number; ready: number };
  buckets: OutcomeSummaryBucket[];
}

// Continuation candidate — a ticker in the middle of a *multi-day* move.
// Seeded from either screen (Momentum ∪ Ignition) on any day in the window,
// then forward-tracked via daily_bars so a quiet day-2 grind that re-triggers
// no screen still counts. days_in_run = distinct active days (screen OR a real
// daily-bar move) from the trigger onward; multi-day confirmed (≥ 2) and gated
// on liveness. See services/continuation.ts.
export interface ContinuationRow {
  ticker: string;
  days_in_run: number;          // distinct active days (screen OR bar) from trigger
  screen_days: number;          // of those, how many actually hit a screen
  first_seen: string;           // YYYY-MM-DD — trigger (first screen day)
  last_seen: string;            // YYYY-MM-DD — last screen day
  from_base_pct: number | null; // cumulative move from base close to latest close
  off_peak_pct: number | null;  // latest close vs run peak close (≤ 0); liveness
  last_close: number | null;
  last_day_change_pct: number | null;
  today_peak: number | null;    // peak Ignition score today; null if absent / Momentum-only
  peak_window_score: number | null; // peak Ignition score in window; null for Momentum-only
  min_price: number;
  max_price: number;
  // Most recent news landing within the last ~3 days, joined with its
  // catalyst classification. catalyst_* fields stay null when the article
  // hasn't been classified yet — the CatalystBadge then renders ✨.
  news_title: string | null;
  news_url: string | null;
  news_source: string | null;
  news_published_at: string | null;
  catalyst_score: number | null;
  catalyst_direction: string | null;
  catalyst_urgency: string | null;
  catalyst_type: string | null;
  catalyst_reason: string | null;
}

export interface NewsHeadline {
  ticker: string;
  source: NewsSource;
  title: string;
  url: string;
  published_at: string | null;
}

// ET trading session a cycle was polled in. During 'afterhours' the row
// change_pct/price/volume reflect after-hours figures, not the regular close.
export type TradingSession = 'premarket' | 'regular' | 'afterhours' | 'closed';

export interface CyclePayload {
  cycle_id: string;
  polled_at: string | null;
  session: TradingSession;
  config: ScreenerFilterSnapshot;
  rows: EnrichedRow[];
  ignition: IgnitionRow[];
  swing: SwingRow[];
  continuation: ContinuationRow[];
  banners: { new_with_catalyst: string[]; fresh_news: string[] };
  fresh_news: NewsHeadline[];
}

export interface HistoryRow {
  id: string;
  ticker: string;
  change_pct: number | null;
  float_m: number | null;
  float_is_proxy: boolean;
  price: number | null;
  volume: number | null;
  avg_volume: number | null;
  rel_volume: number | null;
  vol_5min: number | null;
  rel_vol_5min: number | null;
  mcap_m: number | null;
  country: string | null;
  company: string | null;
  sector: string | null;
  industry: string | null;
  short_float_pct: number | null;
  short_ratio: number | null;
  insider_own_pct: number | null;
  insider_trans_pct: number | null;
  inst_own_pct: number | null;
  inst_trans_pct: number | null;
  shares_out_m: number | null;
  status: RowStatus;
  prev_change_pct: number | null;
  accel_delta: number | null;
  polled_at: string;
  cycle_id: string;
}

// One persisted Ignition-screener row joined with its cycle. Returned by
// /api/screener/ignition-history?ticker=X — used by the Quote Details
// "Ignition" tab to show how runner_score evolved cycle-by-cycle.
export interface IgnitionHistoryRow {
  id: string;
  ticker: string;
  runner_score: number;
  score_breakdown: RunnerScoreBreakdown;
  price: number | null;
  change_pct: number | null;
  float_m: number | null;
  rel_volume: number | null;
  rel_vol_5min: number | null;
  catalyst_score: number | null;
  news_source: NewsSource | null;
  shelf_level: ShelfLevel | null;
  polled_at: string;
  session: TradingSession;
  cycle_id: string;
}

// ─── news ──────────────────────────────────────────────────────────────────
export interface NewsClassification {
  impact_score: number;
  urgency: CatalystUrgency;
  direction: CatalystDirection;
  catalyst_type: string;
  materiality: 'high' | 'medium' | 'low' | 'unknown';
  confidence: number;
  reason: string | null;
  risk_flags: string[];
  classifier: Classifier;
}

export interface NewsArticle {
  id: string;
  source: NewsSource;
  url: string;
  title: string;
  published_at: string | null;
  fetched_at: string;
  // Every ticker tagged to the article, alphabetical. Same article appears
  // once in the feed regardless of how many tickers it covers.
  tickers: string[];
  classification: NewsClassification | null;
}

export interface ClassifyArticleResponse extends NewsClassification {
  cached: boolean;
}

// ─── prefs ─────────────────────────────────────────────────────────────────
export interface ChartPref {
  user_id: string;
  slot: number;
  ticker: string | null;
  interval: string;
  follow_selection: boolean;
}

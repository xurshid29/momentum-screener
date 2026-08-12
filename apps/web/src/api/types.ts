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
  // Crowd/pump potential (0..100), orthogonal to `score` (catalyst quality).
  // Optional — old payloads / deterministic paths may omit it.
  hype?: number | null;
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
  // 1-min relative volume — the fast "is the burst live right now" companion
  // to rel_vol_5min (same % construction on a 60s window). Cold-start
  // extrapolated from ~20s of samples; null on a ticker's first cycle and
  // after an on-screen gap.
  rel_vol_1min: number | null;
  // Change% now minus change% ~1 min ago — gives the direction-blind 1-min
  // RVol its sign in the UI (hot burst + this ≤ −2 = sell-side pressure).
  chg_delta_1min: number | null;
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
  // ISO timestamp the ticker first appeared in any screen today (ET-day scoped).
  first_seen_at: string;
  // Composite "activity now" score (0..100) — drives the optional Heat sort.
  heat: number;
  // True the cycle price reclaims VWAP (below → at/above) — drives a ↑VWAP badge.
  vwap_reclaim: boolean;
  // Anchored VWAP since first detection today (restart-safe — rebuilt from
  // persisted cycles on boot). Persists across PM → regular → AH so a
  // pre-market spike's volume keeps weighting the indicator. ≈ a chart's
  // session VWAP only when the name has been screening since the session
  // start; a name first sighted mid-move gets an anchored-at-detection VWAP.
  // Null on cycle 1 (no delta yet) and whenever price/volume is missing.
  // Resets at midnight ET.
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
  maturity: number;
  premarket: number;
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

// v2 ("early volatile breakout", 2026-06-13): volatility = ATR% of price,
// room = distance below the 52w high, trigger = fresh range-high cross +
// base + close strength, extension = stretched-above-20-SMA penalty (≤ 0).
export interface SwingScoreBreakdown {
  volatility: number;
  room: number;
  trigger: number;
  volume: number;
  trend: number;
  catalyst: number;
  extension: number;    // ≤ 0 — penalty
  shelf: number;        // ≤ 0 — penalty
}

export interface SwingSetupFlags {
  in_base: boolean;         // prior-15-close range ≤ 15%
  broke_out: boolean;       // DAY-1 fresh cross of the prior 15-bar high — the alert trigger
  broke_out_5d: boolean;    // day-2 of that cross
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

// A live tick-feed catch — flagged before (or as) the move develops. The
// ladder: 'accum' = 🤫 quiet accumulation (volume arriving, price still <10%,
// teal), 'watch' = 👀 price-led early flag (amber, confirmation pending),
// 'confirmed' = volume-confirmed (blue), 'faded' = expired/gave back (grey,
// lingers briefly). Shown in the 🛰️ section of the Ignition sidebar. See
// poller.ts onTickEvent / scanAccumulation.
export type TickCatchStatus = 'accum' | 'watch' | 'confirmed' | 'faded';

export interface TickCatch {
  ticker: string;
  price: number;
  change_pct: number;
  rel_vol: number;
  mom_pct: number;
  status: TickCatchStatus;
  caught_at: string;
  confirmed_at: string | null;
  watch_change_pct: number | null;
}

// A news-radar hit — a fresh catalyst on a known runner (momentum/ignition
// history) that is NOT on any screen yet. Moves typically start minutes after
// the wire; 'moving' = the tick feed or a screen has since picked the name up.
export interface NewsRadarItem {
  ticker: string;
  source: NewsSource;
  title: string;
  url: string;
  published_at: string | null;
  first_seen_at: string;
  impact: number;
  hype: number;
  direction: CatalystDirection;
  urgency: CatalystUrgency;
  catalyst_type: string;
  classifier: Classifier;
  status: 'news' | 'moving';
  escalated_at: string | null;
  escalated_via: 'tick' | 'screen' | null;
}

// 📈 EMA-cross layer — a 10/65 bullish cross nominated a known runner
// ('observing'); volume expansion vs sibling candles with price holding
// flips it to 'confirmed'. Two timeframes share the section: 5m (intraday;
// unconfirmed entries vanish fast) and 4h (the operator's swing-timing
// tool — rows linger ~6h, the nomination itself is the signal).
export interface EmaCrossItem {
  ticker: string;
  tf: '5m' | '15m' | '1h' | '4h' | '1d';
  // Nomination channel: the EMA10×EMA65 crossover, or the price-reclaims-
  // both-EMAs channel (↗, parallel A/B trial since 2026-07-24).
  signal: 'cross' | 'reclaim';
  // 'moving' = an in-flight reclaim already up ≥3% from its reclaim price.
  // Descriptive, NOT a forecast of the confirm (nothing in-flight predicts
  // it — see the poller-side note).
  status: 'observing' | 'moving' | 'confirmed';
  price: number;
  cross_price: number;
  vol_ratio: number;
  // Live % move since the reclaim bar while observing (null once confirmed).
  pct_since_reclaim?: number | null;
  // Live day change vs the prior close (null when the prior close is unknown).
  change_pct?: number | null;
  // 5m attention tier (confirmed 5m reclaims only): 'A+' = an HTF reclaim
  // co-confirmed within ±2 min AND ratio ≥20×; 'A' = co-confirm alone;
  // 'B' = 5m-only. Attention ranking, not expectancy — see
  // docs/ema-list-optimization-2026-08-01.md.
  priority?: 'A+' | 'A' | 'B';
  co_tfs?: string[];
  cross_at: string;
  confirmed_at: string | null;
  // Our feed sees a sliver of this name's tape (sibling-median notional at
  // the cross < ~$5k) — the EMAs may legitimately diverge from TV's. ⚠️.
  thin_tape: boolean;
  // Today's freshest article + classification, enriched async server-side
  // (null until the lookup lands / when the name has no news today).
  news_title: string | null;
  news_url: string | null;
  news_published_at: string | null;
  catalyst: CatalystInfo | null;
}

// ⤴ MACD MOMO — one row per top gainer of the session with its live MACD
// 3/10/8 (all-SMA, 5m) geometry. The second-leg tab: the operator misses a
// leader's first move (day job) and enters when the line turns up toward
// its signal after the pullback reset.
export interface MacdMomoItem {
  ticker: string;
  // Which MACD lane: 2m/15m/1h/4h = 3/15/8, 5m = 3/10/8; ascending lanes.
  variant: '5m' | '2m' | '15m' | '1h' | '4h';
  // curling = SETUP live (line rising toward the signal, most of the gap
  // closed — the entry moment) · crossed = line above the signal · turning =
  // rising below, not announce-worthy yet · cooling = falling below ·
  // warming = MACD not yet computable (<18 closed 5m bars).
  state: 'curling' | 'crossing' | 'crossed' | 'turning' | 'cooling' | 'warming';
  // FULL-DAY change vs the prior close in every session (same anchor as the
  // EMA tab — differs from Momentum/Ignition in after-hours).
  chg_pct: number | null;
  price: number;
  gap_pct: number | null;       // (signal − line) / price × 100; ≤0 once above
  // Below-zero reset marker. For crossed rows: stamped at the cross EVENT
  // (origin — the line rises through zero as the leg runs); other states
  // read the live line. Sorted first within its state.
  below_zero: boolean | null;
  // Price vs the 21EMA on this grid, live — informational only (the
  // pre-study graded above-trend setups WORSE; not a safety signal).
  above_trend: boolean | null;
  rising_bars: number | null;
  // Minutes since the last REAL bar on our feed. Small = the state rides
  // real tape; large = thin tape here — the state is projected from the
  // live price across the quiet stretch (chipped at ≥10).
  bar_age_min: number | null;
  setup_at: string | null;      // today's latest ⤴ setup (bar-close anchored)
  cross_at: string | null;      // today's latest ✚ cross-up
  qualified_at: string;
  news_title: string | null;
  news_url: string | null;
  catalyst: CatalystInfo | null;
}

export type MomoSetupContext = 'warming' | 'cooling' | 'turning' | 'curling' | 'crossing' | 'crossed';

export interface MomoSetupItem {
  ticker: string;
  state: 'warming' | 'resetting' | 'basing' | 'curling' | 'ready' | 'triggered' | 'failed';
  state_at: string | null;
  setup_number: number;
  setup_at: string | null;
  trigger_at: string | null;
  chg_pct: number | null;
  price: number;
  pullback_depth_pct: number | null;
  base_bars: number;
  volume_dryup_ratio: number | null;
  volume_reexpansion_ratio: number | null;
  entry: number | null;
  trigger: number | null;
  stop: number | null;
  stop_distance_pct: number | null;
  below_zero: boolean | null;
  above_ema21: boolean | null;
  context_2m: MomoSetupContext;
  context_5m: MomoSetupContext;
  context_15m: MomoSetupContext;
  feed_age_min: number | null;
  failure_reason: string | null;
  qualified_at: string;
  news_title: string | null;
  news_url: string | null;
  catalyst: CatalystInfo | null;
}

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
  tick_catches: TickCatch[];
  news_radar: NewsRadarItem[];
  ema_crosses: EmaCrossItem[];
  macd_momo: MacdMomoItem[];
  momo_setups: MomoSetupItem[];
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
  rel_vol_1min: number | null;
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

// ─── news ──────────────────────────────────────────────────────────────────
export interface NewsClassification {
  impact_score: number;
  hype_score?: number | null;
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

// ─── trades / journal ───────────────────────────────────────────────────────
// One ET trading day's realized P&L (round-trips attributed to their exit date).
export interface DayAggregate {
  et_date: string;
  gross_pnl: number;
  net_pnl: number;
  commission: number;
  trade_count: number;
  win_count: number;
  loss_count: number;
}

export interface TradesSummary {
  net_pnl: number;
  gross_pnl: number;
  commission: number;
  trade_count: number;
  win_count: number;
  loss_count: number;
  win_rate: number | null;
}

export interface CalendarResponse {
  from: string | null;
  to: string | null;
  days: DayAggregate[];
  summary: TradesSummary;
}

// A flat-to-flat round trip in one symbol (the calendar-cell drill-down rows).
export interface MatchedTrade {
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  entry_at: string;
  exit_at: string;
  et_date: string;
  avg_entry: number | null;
  avg_exit: number | null;
  gross_pnl: number;
  commission: number;
  net_pnl: number;
  fills: number;
  is_open: boolean;
}

export interface DayDetail {
  date: string;
  trades: MatchedTrade[];
  summary: TradesSummary;
}

export interface ImportResult {
  import_id: string;
  account: string | null;
  account_name: string | null;
  period_start: string | null;
  period_end: string | null;
  executions_seen: number;
  executions_imported: number;
  duplicates: number;
  skipped: number;
}

export interface BrokerImport {
  id: string;
  broker: string;
  filename: string | null;
  account: string | null;
  period_start: string | null;
  period_end: string | null;
  executions_seen: number;
  executions_imported: number;
  created_at: string;
}

// ─── prefs ─────────────────────────────────────────────────────────────────
export interface ChartPref {
  user_id: string;
  slot: number;
  ticker: string | null;
  interval: string;
  follow_selection: boolean;
}

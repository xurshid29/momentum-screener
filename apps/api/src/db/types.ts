import type { Generated, ColumnType, JSONColumnType } from 'kysely';

export interface UsersTable {
  id: Generated<string>;
  username: string;
  password: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  active: Generated<boolean>;
}

// Snapshot of poller config + filter at the time of the cycle.
// Stored verbatim so a future analyst can reproduce the screen.
export interface ScreenerFilterSnapshot {
  filter: string;
  float_max_m: number;
  top_n: number;
  accel_threshold: number;
  interval_sec: number;
}

// ET trading session a cycle was polled in. 'afterhours' cycles carry
// after-hours change/price/volume; the rest carry regular-session figures.
export type TradingSession = 'premarket' | 'regular' | 'afterhours' | 'closed';

export interface ScreenerCyclesTable {
  id: Generated<string>;
  polled_at: Generated<Date>;
  filter_snapshot: JSONColumnType<ScreenerFilterSnapshot>;
  row_count: Generated<number>;
  session: Generated<TradingSession>;
  created_at: Generated<Date>;
}

// Single-row table — persists the global poller config across restarts.
export interface ScreenerSettingsTable {
  id: Generated<number>;
  config: JSONColumnType<ScreenerFilterSnapshot>;
  updated_at: Generated<Date>;
}

export type RowStatus = 'NEW' | 'ACC' | 'UP' | 'NEWS' | null;

export interface ScreenerResultsTable {
  id: Generated<string>;
  cycle_id: string;
  ticker: string;
  change_pct: number | null;
  float_m: number | null;
  float_is_proxy: Generated<boolean>;
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
  // Heat composite + the VWAP side at this cycle — persisted 2026-06-12 so
  // the heat weights can be graded against screener_outcomes (the in-memory
  // VWAP state is otherwise unrecoverable offline). Null on pre-migration rows.
  heat: number | null;
  vwap: number | null;
  above_vwap: boolean | null;
  vwap_reclaim: boolean | null;
}

// One row per Ignition-screener candidate per cycle. `score_breakdown` is the
// per-component runner-score (float / volume / catalyst / maturity / premarket / shelf).
export interface IgnitionResultsTable {
  id: Generated<string>;
  cycle_id: string;
  ticker: string;
  runner_score: number;
  score_breakdown: JSONColumnType<Record<string, number>>;
  price: number | null;
  change_pct: number | null;
  float_m: number | null;
  rel_volume: number | null;
  rel_vol_5min: number | null;
  rel_vol_1min: number | null;
  catalyst_score: number | null;
  news_source: NewsSource | null;
  // Effective-shelf / dilution level at ignition time: 'shelf' | 'effective'
  // | 'active' | null. See services/shelf.ts.
  shelf_level: string | null;
  created_at: Generated<Date>;
}

// One row per Swing-screener candidate per scan. See docs/swing-screener-spec.md §5.
export interface SwingResultsTable {
  id: Generated<string>;
  cycle_id: string;
  ticker: string;
  swing_score: number;
  score_breakdown: JSONColumnType<Record<string, number>>;
  price: number | null;
  change_pct: number | null;
  float_m: number | null;
  mcap_m: number | null;
  volume: number | null;
  avg_volume_20: number | null;
  sma_20: number | null;
  sma_50: number | null;
  sma_200: number | null;
  high_52w: number | null;
  atr_14: number | null;
  in_base: boolean | null;
  broke_out: boolean | null;
  close_in_top_q: boolean | null;
  catalyst_score: number | null;
  catalyst_type: string | null;
  shelf_level: string | null;
  created_at: Generated<Date>;
}

// One row per (screen, ticker, ET trading day): the entry context at detection
// plus forward close-to-close moves from daily_bars. Populated by the daily
// OutcomesService job. See db/migrations and docs roadmap "Forward outcome
// tracking".
export interface ScreenerOutcomesTable {
  id: Generated<string>;
  screen: string;                  // 'momentum' | 'ignition' | 'swing'
  ticker: string;
  et_date: ColumnType<string, string, string>;   // Postgres date, ISO at boundaries
  entry_close: number | null;
  next_open: number | null;
  entry_score: number | null;
  first_change_pct: number | null;
  peak_change_pct: number | null;
  catalyst_score: number | null;
  catalyst_direction: string | null;
  catalyst_urgency: string | null;
  catalyst_type: string | null;
  shelf_level: string | null;
  sessions: ColumnType<string[], string[], string[]> | null;
  chg_1d: number | null;
  chg_3d: number | null;
  chg_5d: number | null;
  peak_5d: number | null;
  drawdown_5d: number | null;
  bars_forward: Generated<number>;
  computed_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// Per-user manual "avoid / burned" flag — a permanent warning marker on
// tickers that pump-and-dumped on the operator. No expiry (structural fact,
// not a transient trade idea). See db/migrations.
export interface UserFlaggedTickersTable {
  user_id: string;
  ticker: string;
  note: string | null;
  created_at: Generated<Date>;
}

// Per-ticker daily OHLCV bars. Powers the Swing screener's daily-timeframe
// signals (SMAs, 52w high, ATR, base/breakout detection). Loaded from Finviz
// quote_export and refreshed nightly. See docs/swing-screener-spec.md §4.1.
export interface DailyBarsTable {
  ticker: string;
  // Postgres `date` round-trips as a `Date` here because the pg driver parses
  // it on the way in; on the way out Kysely accepts either a JS Date or a
  // 'YYYY-MM-DD' string, so we widen the insert type.
  date: ColumnType<Date, Date | string, Date | string>;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  fetched_at: Generated<Date>;
}

// 'sec'  — an SEC EDGAR filing (offering, 8-K, M&A, 13D…)
// 'halt' — a Nasdaq trade halt / volatility pause
export type NewsSource = 'finviz' | 'yahoo' | 'benzinga' | 'sec' | 'halt';

export interface NewsArticlesTable {
  id: Generated<string>;
  source: NewsSource;
  url: string;
  title: string;
  published_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  fetched_at: Generated<Date>;
  raw: JSONColumnType<Record<string, unknown>> | null;
}

export interface NewsTickerLinksTable {
  article_id: string;
  ticker: string;
}

export type CatalystDirection = 'bullish' | 'bearish' | 'mixed' | 'neutral';
export type CatalystUrgency = 'ignore' | 'watch' | 'strong' | 'major';
export type CatalystMateriality = 'high' | 'medium' | 'low' | 'unknown';
export type Classifier = 'rules' | 'openai_nano' | 'openai_mini' | 'openai' | 'anthropic_sonnet';

export interface NewsClassificationsTable {
  article_id: string;
  impact_score: number;
  // Crowd/pump potential (0..100), orthogonal to impact_score's catalyst
  // quality. Nullable — old rows + deterministic SEC/halt paths leave it null.
  hype_score: number | null;
  direction: CatalystDirection;
  urgency: CatalystUrgency;
  catalyst_type: string;
  materiality: CatalystMateriality;
  is_repeat: Generated<boolean>;
  confidence: number;
  reason: string | null;
  risk_flags: JSONColumnType<string[]>;
  classifier: Classifier;
  classified_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UserFilterPresetsTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  filter: JSONColumnType<ScreenerFilterSnapshot>;
  is_default: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UserPanelLayoutTable {
  user_id: string;
  layout: JSONColumnType<Record<string, unknown>>;
  updated_at: Generated<Date>;
}

export interface UserHiddenTickersTable {
  user_id: string;
  ticker: string;
  // Stored as a Postgres `date`. Treat as ISO-8601 (YYYY-MM-DD) at all
  // boundaries so day-equality comparisons stay timezone-safe.
  hidden_date: ColumnType<string, string, string>;
  hidden_at: Generated<Date>;
}

export interface UserChartPrefsTable {
  user_id: string;
  slot: number;
  ticker: string | null;
  interval: Generated<string>;
  follow_selection: Generated<boolean>;
  // List of internal study ids (e.g. ['vwap', 'ema9']). Translated to TV
  // study identifiers on the frontend at widget init.
  studies: Generated<JSONColumnType<string[]>>;
}

export interface UserWatchlistTable {
  user_id: string;
  ticker: string;
  note: string | null;
  // ET calendar date the entry expires on. Stored as Postgres `date`; treat as
  // ISO-8601 (YYYY-MM-DD) at all boundaries so the expiry comparison is
  // timezone-safe. Removed the next ET day by the GET endpoint's cleanup.
  expires_at: ColumnType<string, string, string>;
  // Last time the user opened this entry's news. Drives the "new news" dot:
  // news newer than coalesce(news_seen_at, created_at) is unseen. NULL until
  // first viewed.
  news_seen_at: ColumnType<Date | null, string | null, string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// One uploaded broker statement file (IBKR TradeLog .tlg for now). Informational
// metadata + a content hash; the actual dedup is per-fill on trade_executions.
export interface BrokerImportsTable {
  id: Generated<string>;
  user_id: string;
  broker: Generated<string>;
  filename: string | null;
  account: string | null;
  file_hash: string | null;
  period_start: ColumnType<string | null, string | null, string | null>;
  period_end: ColumnType<string | null, string | null, string | null>;
  executions_seen: Generated<number>;
  executions_imported: Generated<number>;
  created_at: Generated<Date>;
}

// One broker fill (leg). The source of truth — round-trip "trades" (flat-to-flat
// per symbol) are derived in code (services/ibkr-tlg.ts), not stored. Unique on
// (user_id, exec_id) so re-importing an overlapping file is idempotent.
// `executed_at` is ET wall clock (no tz); `et_date` is the ET trading date used
// for all calendar grouping. See db/migrations/…_broker_trades.sql.
export interface TradeExecutionsTable {
  id: Generated<string>;
  user_id: string;
  import_id: string | null;
  exec_id: string;
  symbol: string;
  description: string | null;
  venue: string | null;
  side: string;                 // 'buy' | 'sell'
  open_close: string | null;    // 'O' | 'C'
  action_raw: string | null;
  quantity: number;             // signed
  multiplier: Generated<number>;
  price: number;
  amount: number;               // quantity × price, signed
  commission: Generated<number>;
  currency: Generated<string>;
  executed_at: ColumnType<Date, Date | string, Date | string>;
  et_date: ColumnType<string, string, string>;
  created_at: Generated<Date>;
}

// Durable early-detection tier transitions (🤫 accum / 👀🛰️ tick / 📰 radar) —
// written fire-and-forget by the poller so grading survives deploys (docker
// logs reset on every container recreation). See services/tier-events.ts.
export interface TierEventsTable {
  id: Generated<string>;
  tier: string;    // 'accum' | 'tick' | 'radar'
  event: string;   // per-tier transition name — see the migration header
  ticker: string;
  at: Generated<Date>;
  meta: JSONColumnType<Record<string, unknown>> | null;
}

export interface Database {
  users: UsersTable;
  screener_settings: ScreenerSettingsTable;
  screener_cycles: ScreenerCyclesTable;
  screener_results: ScreenerResultsTable;
  ignition_results: IgnitionResultsTable;
  swing_results: SwingResultsTable;
  daily_bars: DailyBarsTable;
  screener_outcomes: ScreenerOutcomesTable;
  news_articles: NewsArticlesTable;
  news_ticker_links: NewsTickerLinksTable;
  news_classifications: NewsClassificationsTable;
  user_filter_presets: UserFilterPresetsTable;
  user_panel_layout: UserPanelLayoutTable;
  user_chart_prefs: UserChartPrefsTable;
  user_hidden_tickers: UserHiddenTickersTable;
  user_watchlist: UserWatchlistTable;
  user_flagged_tickers: UserFlaggedTickersTable;
  broker_imports: BrokerImportsTable;
  trade_executions: TradeExecutionsTable;
  tier_events: TierEventsTable;
}

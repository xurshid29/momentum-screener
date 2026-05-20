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
}

// One row per Ignition-screener candidate per cycle. `score_breakdown` is the
// per-component runner-score (float / volume / catalyst / earliness / halt).
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
  catalyst_score: number | null;
  news_source: NewsSource | null;
  // Effective-shelf / dilution level at ignition time: 'shelf' | 'effective'
  // | 'active' | null. See services/shelf.ts.
  shelf_level: string | null;
  created_at: Generated<Date>;
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

export interface Database {
  users: UsersTable;
  screener_settings: ScreenerSettingsTable;
  screener_cycles: ScreenerCyclesTable;
  screener_results: ScreenerResultsTable;
  ignition_results: IgnitionResultsTable;
  news_articles: NewsArticlesTable;
  news_ticker_links: NewsTickerLinksTable;
  news_classifications: NewsClassificationsTable;
  user_filter_presets: UserFilterPresetsTable;
  user_panel_layout: UserPanelLayoutTable;
  user_chart_prefs: UserChartPrefsTable;
  user_hidden_tickers: UserHiddenTickersTable;
}

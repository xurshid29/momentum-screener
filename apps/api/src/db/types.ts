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

export interface ScreenerCyclesTable {
  id: Generated<string>;
  polled_at: Generated<Date>;
  filter_snapshot: JSONColumnType<ScreenerFilterSnapshot>;
  row_count: Generated<number>;
  created_at: Generated<Date>;
}

export type RowStatus = 'NEW' | 'ACC' | 'UP' | 'NEWS' | null;

export interface ScreenerResultsTable {
  id: Generated<string>;
  cycle_id: string;
  ticker: string;
  change_pct: number | null;
  float_m: number | null;
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

export type NewsSource = 'finviz' | 'yahoo' | 'benzinga';

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
  screener_cycles: ScreenerCyclesTable;
  screener_results: ScreenerResultsTable;
  news_articles: NewsArticlesTable;
  news_ticker_links: NewsTickerLinksTable;
  user_filter_presets: UserFilterPresetsTable;
  user_panel_layout: UserPanelLayoutTable;
  user_chart_prefs: UserChartPrefsTable;
}

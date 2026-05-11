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
export type NewsSource = 'finviz' | 'yahoo' | 'benzinga';
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
  is_fresh_news: boolean;
  has_today_news: boolean;
  news_title: string | null;
  news_source: NewsSource | null;
  news_url: string | null;
  finviz_url: string;
  catalyst: CatalystInfo | null;
}

export interface NewsHeadline {
  ticker: string;
  source: NewsSource;
  title: string;
  url: string;
  published_at: string | null;
}

export interface CyclePayload {
  cycle_id: string;
  polled_at: string | null;
  config: ScreenerFilterSnapshot;
  rows: EnrichedRow[];
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
  ticker: string | null;
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

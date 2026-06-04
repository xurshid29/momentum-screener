import { apiClient } from './client';
import type { ChartPref } from './types';

// Free-form panel layout payload. Persisted to user_panel_layout.layout (jsonb).
// Currently only stores chart_count; extend as we add more layout knobs.
export interface PanelLayout {
  chart_count?: number;
  // Momentum tab "news/catalyst only" display filter — show only rows that
  // have today's news. Per-user, persisted alongside chart_count.
  momentum_news_only?: boolean;
  // Same display filter for the Ignition sidebar.
  ignition_news_only?: boolean;
}

export const prefsApi = {
  async getCharts(): Promise<ChartPref[]> {
    const res = await apiClient.get<ChartPref[]>('/api/prefs/charts');
    return res.data;
  },

  async putCharts(prefs: Omit<ChartPref, 'user_id'>[]): Promise<void> {
    await apiClient.put<{ ok: true }>('/api/prefs/charts', prefs);
  },

  async getLayout(): Promise<PanelLayout | null> {
    const res = await apiClient.get<PanelLayout | null>('/api/prefs/layout');
    return res.data;
  },

  async putLayout(layout: PanelLayout): Promise<void> {
    await apiClient.put<{ ok: true }>('/api/prefs/layout', layout);
  },

  // ─── hidden tickers (current ET day) ──────────────────────────────────────
  async getHiddenTickers(): Promise<string[]> {
    const res = await apiClient.get<string[]>('/api/prefs/hidden-tickers');
    return res.data;
  },

  async hideTicker(ticker: string): Promise<void> {
    await apiClient.post<{ ticker: string }>('/api/prefs/hidden-tickers', { ticker });
  },

  async unhideTicker(ticker: string): Promise<void> {
    await apiClient.delete<{ ok: true }>(`/api/prefs/hidden-tickers/${encodeURIComponent(ticker)}`);
  },

  // ─── watchlist / favorites (expiring) ─────────────────────────────────────
  async getWatchlist(): Promise<WatchlistEntry[]> {
    const res = await apiClient.get<WatchlistEntry[]>('/api/prefs/watchlist');
    return res.data;
  },

  // expires_at omitted → backend defaults to +2 ET days. One-click add.
  async addWatchlist(entry: { ticker: string; expires_at?: string }): Promise<void> {
    await apiClient.post<{ ticker: string }>('/api/prefs/watchlist', entry);
  },

  async setWatchlistExpiry(ticker: string, expires_at: string): Promise<void> {
    await apiClient.patch<{ ticker: string }>(`/api/prefs/watchlist/${encodeURIComponent(ticker)}`, { expires_at });
  },

  async markWatchlistSeen(ticker: string): Promise<void> {
    await apiClient.post<{ ok: true }>(`/api/prefs/watchlist/${encodeURIComponent(ticker)}/seen`, {});
  },

  async removeWatchlist(ticker: string): Promise<void> {
    await apiClient.delete<{ ok: true }>(`/api/prefs/watchlist/${encodeURIComponent(ticker)}`);
  },
};

export interface WatchlistEntry {
  ticker: string;
  note: string | null;
  expires_at: string;   // ISO (date or timestamp) — ET calendar date
  created_at: string;
  news_seen_at: string | null;
  // Most recent article within the news window + its classification.
  news_title: string | null;
  news_url: string | null;
  news_source: string | null;
  news_published_at: string | null;
  catalyst_score: number | null;
  catalyst_direction: string | null;
  catalyst_urgency: string | null;
  catalyst_type: string | null;
  catalyst_reason: string | null;
  // News landed after the user last viewed this entry (or after adding it).
  has_new_news: boolean;
}

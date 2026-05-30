import { apiClient } from './client';
import type { ChartPref } from './types';

// Free-form panel layout payload. Persisted to user_panel_layout.layout (jsonb).
// Currently only stores chart_count; extend as we add more layout knobs.
export interface PanelLayout {
  chart_count?: number;
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

  async addWatchlist(entry: { ticker: string; note?: string; expires_at: string }): Promise<void> {
    await apiClient.post<{ ticker: string }>('/api/prefs/watchlist', entry);
  },

  async removeWatchlist(ticker: string): Promise<void> {
    await apiClient.delete<{ ok: true }>(`/api/prefs/watchlist/${encodeURIComponent(ticker)}`);
  },
};

export interface WatchlistEntry {
  ticker: string;
  note: string | null;
  expires_at: string;   // YYYY-MM-DD (ET)
  created_at: string;
}

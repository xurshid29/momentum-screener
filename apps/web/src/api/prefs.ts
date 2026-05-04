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
};

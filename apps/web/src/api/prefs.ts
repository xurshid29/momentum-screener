import { apiClient } from './client';
import type { ChartPref } from './types';

export const prefsApi = {
  async getCharts(): Promise<ChartPref[]> {
    const res = await apiClient.get<ChartPref[]>('/api/prefs/charts');
    return res.data;
  },

  async putCharts(prefs: Omit<ChartPref, 'user_id'>[]): Promise<void> {
    await apiClient.put<{ ok: true }>('/api/prefs/charts', prefs);
  },
};

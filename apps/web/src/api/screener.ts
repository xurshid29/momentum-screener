import { apiClient } from './client';
import type {
  CyclePayload,
  HistoryByDayRow,
  HistoryByDayScreen,
  HistoryRow,
  IgnitionHistoryRow,
  ScreenerFilterSnapshot,
} from './types';

export const screenerApi = {
  async latest(): Promise<CyclePayload> {
    const res = await apiClient.get<CyclePayload>('/api/screener/latest');
    return res.data;
  },

  async history(ticker: string, limit = 100): Promise<HistoryRow[]> {
    const res = await apiClient.get<HistoryRow[]>(
      `/api/screener/history?ticker=${encodeURIComponent(ticker)}&limit=${limit}`,
    );
    return res.data;
  },

  async ignitionHistory(ticker: string, limit = 200): Promise<IgnitionHistoryRow[]> {
    const res = await apiClient.get<IgnitionHistoryRow[]>(
      `/api/screener/ignition-history?ticker=${encodeURIComponent(ticker)}&limit=${limit}`,
    );
    return res.data;
  },

  async historyByDay(date: string, screen: HistoryByDayScreen): Promise<HistoryByDayRow[]> {
    const res = await apiClient.get<HistoryByDayRow[]>(
      `/api/screener/history-by-day?date=${encodeURIComponent(date)}&screen=${screen}`,
    );
    return res.data;
  },

  async patchConfig(partial: Partial<ScreenerFilterSnapshot>): Promise<ScreenerFilterSnapshot> {
    const res = await apiClient.patch<ScreenerFilterSnapshot>('/api/screener/config', partial);
    return res.data;
  },
};

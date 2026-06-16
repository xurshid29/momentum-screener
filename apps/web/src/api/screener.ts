import { apiClient } from './client';
import type {
  BurnedTicker,
  CyclePayload,
  HistoryByDayRow,
  HistoryByDayScreen,
  HistoryRow,
  OutcomeSummaryResponse,
  OutcomesGroupBy,
  OutcomesHorizon,
  OutcomesScreen,
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

  async historyByDay(date: string, screen: HistoryByDayScreen): Promise<HistoryByDayRow[]> {
    const res = await apiClient.get<HistoryByDayRow[]>(
      `/api/screener/history-by-day?date=${encodeURIComponent(date)}&screen=${screen}`,
    );
    return res.data;
  },

  async outcomesSummary(
    groupBy: OutcomesGroupBy,
    horizon: OutcomesHorizon,
    screen: OutcomesScreen,
  ): Promise<OutcomeSummaryResponse> {
    const res = await apiClient.get<OutcomeSummaryResponse>(
      `/api/screener/outcomes-summary?group_by=${groupBy}&horizon=${horizon}&screen=${screen}`,
    );
    return res.data;
  },

  async burnedTickers(): Promise<BurnedTicker[]> {
    const res = await apiClient.get<BurnedTicker[]>('/api/screener/burned-tickers');
    return res.data;
  },

  async patchConfig(partial: Partial<ScreenerFilterSnapshot>): Promise<ScreenerFilterSnapshot> {
    const res = await apiClient.patch<ScreenerFilterSnapshot>('/api/screener/config', partial);
    return res.data;
  },
};

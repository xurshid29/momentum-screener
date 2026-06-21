import { apiClient } from './client';
import type { BrokerImport, CalendarResponse, DayDetail, ImportResult } from './types';

export const tradesApi = {
  async importTlg(filename: string, content: string): Promise<ImportResult> {
    const res = await apiClient.post<ImportResult>('/api/trades/import', { filename, content });
    return res.data;
  },

  async calendar(from: string, to: string): Promise<CalendarResponse> {
    const res = await apiClient.get<CalendarResponse>(
      `/api/trades/calendar?from=${from}&to=${to}`,
    );
    return res.data;
  },

  async day(date: string): Promise<DayDetail> {
    const res = await apiClient.get<DayDetail>(`/api/trades/day?date=${encodeURIComponent(date)}`);
    return res.data;
  },

  async range(): Promise<{ min: string | null; max: string | null }> {
    const res = await apiClient.get<{ min: string | null; max: string | null }>('/api/trades/range');
    return res.data;
  },

  async imports(): Promise<BrokerImport[]> {
    const res = await apiClient.get<BrokerImport[]>('/api/trades/imports');
    return res.data;
  },

  async deleteImport(id: string): Promise<void> {
    await apiClient.delete(`/api/trades/imports/${id}`);
  },
};

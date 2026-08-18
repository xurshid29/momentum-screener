import { apiClient } from './client';
import type { EdgePresetInput, EdgeResponse, EdgeSnapshot } from './types';

export const edgeApi = {
  async get(): Promise<EdgeResponse> {
    const res = await apiClient.get<EdgeResponse>('/api/edge');
    return res.data;
  },

  async save(ticker: string, preset: EdgePresetInput): Promise<EdgeSnapshot | null> {
    const res = await apiClient.put<EdgeSnapshot | null, EdgePresetInput>(
      `/api/edge/${encodeURIComponent(ticker)}`,
      preset,
    );
    return res.data;
  },

  async reset(ticker: string): Promise<void> {
    await apiClient.post<{ ok: true }>(`/api/edge/${encodeURIComponent(ticker)}/reset`, {});
  },

  async remove(ticker: string): Promise<void> {
    await apiClient.delete<{ ok: true }>(`/api/edge/${encodeURIComponent(ticker)}`);
  },
};

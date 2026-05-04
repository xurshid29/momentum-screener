import { apiClient } from './client';
import type { NewsArticle } from './types';

export const newsApi = {
  async forTicker(ticker: string, limit = 50): Promise<NewsArticle[]> {
    const res = await apiClient.get<NewsArticle[]>(`/api/news?ticker=${encodeURIComponent(ticker)}&limit=${limit}`);
    return res.data;
  },

  async feed(limit = 50, tickers?: string[]): Promise<NewsArticle[]> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (tickers && tickers.length > 0) params.set('tickers', tickers.join(','));
    const res = await apiClient.get<NewsArticle[]>(`/api/news/feed?${params.toString()}`);
    return res.data;
  },
};

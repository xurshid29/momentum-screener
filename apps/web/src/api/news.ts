import { apiClient } from './client';
import type { NewsArticle, ClassifyArticleResponse } from './types';

export const newsApi = {
  // `days` is the ET-calendar-day lookback (default 1 = today only). Pass a
  // larger window for the swing / continuation context where a 2–3-day-old
  // catalyst still matters.
  async forTicker(ticker: string, limit = 50, days = 1): Promise<NewsArticle[]> {
    const res = await apiClient.get<NewsArticle[]>(
      `/api/news?ticker=${encodeURIComponent(ticker)}&limit=${limit}&days=${days}`,
    );
    return res.data;
  },

  async feed(
    limit = 50,
    tickers?: string[],
    opts?: { universe?: boolean; hours?: number },
  ): Promise<NewsArticle[]> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (tickers && tickers.length > 0) params.set('tickers', tickers.join(','));
    if (opts?.universe) params.set('universe', 'true');
    if (opts?.hours != null) params.set('hours', String(opts.hours));
    const res = await apiClient.get<NewsArticle[]>(`/api/news/feed?${params.toString()}`);
    return res.data;
  },

  async classify(articleId: string): Promise<ClassifyArticleResponse> {
    const res = await apiClient.post<ClassifyArticleResponse>(`/api/news/${encodeURIComponent(articleId)}/classify`);
    return res.data;
  },
};

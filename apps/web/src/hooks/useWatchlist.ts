import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { prefsApi, type WatchlistEntry } from '../api/prefs';

// Per-user watchlist with expiry. The server drops expired entries on GET
// (ET-day cleanup), so we refetch every 5 min as a backstop in case the tab
// is left open across the midnight-ET rollover — same approach as
// useHiddenTickers.
export function useWatchlist() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['prefs', 'watchlist'],
    queryFn: () => prefsApi.getWatchlist(),
    refetchInterval: 5 * 60 * 1000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['prefs', 'watchlist'] });

  const add = useMutation({
    mutationFn: (entry: { ticker: string; note?: string; expires_at: string }) =>
      prefsApi.addWatchlist(entry),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (ticker: string) => prefsApi.removeWatchlist(ticker),
    onSuccess: invalidate,
  });

  const entries: WatchlistEntry[] = data ?? [];
  return {
    entries,
    tickers: new Set(entries.map((e) => e.ticker)),
    isLoading,
    add: add.mutate,
    adding: add.isPending,
    remove: remove.mutate,
  };
}

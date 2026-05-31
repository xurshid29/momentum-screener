import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { prefsApi, type WatchlistEntry } from '../api/prefs';

// Per-user watchlist with expiry. The server drops expired entries on GET
// (ET-day cleanup), so we refetch every 5 min as a backstop in case the tab
// is left open across the midnight-ET rollover — same approach as
// useHiddenTickers. Also refetches the news/"new news" enrichment on that
// cadence so a catalyst landing while a ticker sits in the list surfaces
// without a manual reload.
export function useWatchlist() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['prefs', 'watchlist'],
    queryFn: () => prefsApi.getWatchlist(),
    refetchInterval: 5 * 60 * 1000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['prefs', 'watchlist'] });

  // expires_at omitted → backend defaults to +2 ET days. The one-click star.
  const add = useMutation({
    mutationFn: (entry: { ticker: string; expires_at?: string }) => prefsApi.addWatchlist(entry),
    onSuccess: invalidate,
  });

  const setExpiry = useMutation({
    mutationFn: ({ ticker, expires_at }: { ticker: string; expires_at: string }) =>
      prefsApi.setWatchlistExpiry(ticker, expires_at),
    onSuccess: invalidate,
  });

  const markSeen = useMutation({
    mutationFn: (ticker: string) => prefsApi.markWatchlistSeen(ticker),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (ticker: string) => prefsApi.removeWatchlist(ticker),
    onSuccess: invalidate,
  });

  const entries: WatchlistEntry[] = data ?? [];
  const tickers = new Set(entries.map((e) => e.ticker));

  return {
    entries,
    tickers,
    isLoading,
    add: add.mutate,
    adding: add.isPending,
    setExpiry: setExpiry.mutate,
    markSeen: markSeen.mutate,
    remove: remove.mutate,
    // Star toggle: in the list → remove; otherwise add (default +2d expiry).
    toggle: (ticker: string) => (tickers.has(ticker) ? remove.mutate(ticker) : add.mutate({ ticker })),
    has: (ticker: string) => tickers.has(ticker),
  };
}

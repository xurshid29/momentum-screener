import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { prefsApi } from '../api/prefs';

// Per-user, per-day hidden ticker list. The server scopes the GET to the
// current ET day, so the set automatically empties at midnight. We refetch
// every 5 minutes as a backstop in case the user leaves the tab open across
// the rollover.
export function useHiddenTickers() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['prefs', 'hidden-tickers'],
    queryFn: () => prefsApi.getHiddenTickers(),
    refetchInterval: 5 * 60 * 1000,
  });

  const hide = useMutation({
    mutationFn: (ticker: string) => prefsApi.hideTicker(ticker),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['prefs', 'hidden-tickers'] }),
  });

  const unhide = useMutation({
    mutationFn: (ticker: string) => prefsApi.unhideTicker(ticker),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['prefs', 'hidden-tickers'] }),
  });

  const hidden = new Set(data ?? []);
  return { hidden, isLoading, hide: hide.mutate, unhide: unhide.mutate };
}

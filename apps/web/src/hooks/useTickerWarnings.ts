import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { prefsApi, type FlaggedEntry } from '../api/prefs';
import { screenerApi } from '../api/screener';
import type { BurnedTicker } from '../api/types';

// Combined "avoid this ticker" warnings from two sources:
//   • manual  — the per-user flagged/avoid list (user_flagged_tickers), permanent
//   • auto    — pump-and-dump offenders detected from screener_outcomes (global)
// A ticker can be warned by either or both. The hook exposes a single
// warning(ticker) lookup for badges, plus isFlagged/toggleFlag for the manual
// control. Drives the ⚠ badge + row dimming across every screen surface.

export interface TickerWarning {
  ticker: string;
  manual: boolean;          // on the user's manual avoid-list
  manualNote: string | null;
  auto: boolean;            // auto-detected pump-and-dump
  burned: BurnedTicker | null;
}

export function useTickerWarnings() {
  const qc = useQueryClient();

  const { data: flagged } = useQuery({
    queryKey: ['prefs', 'flagged'],
    queryFn: () => prefsApi.getFlagged(),
    staleTime: 60_000,
  });

  const { data: burned } = useQuery({
    queryKey: ['burned-tickers'],
    queryFn: () => screenerApi.burnedTickers(),
    // Only shifts when the daily outcome job runs — poll loosely.
    staleTime: 5 * 60 * 1000,
  });

  const manualMap = useMemo(() => {
    const m = new Map<string, FlaggedEntry>();
    for (const f of flagged ?? []) m.set(f.ticker, f);
    return m;
  }, [flagged]);

  const burnedMap = useMemo(() => {
    const m = new Map<string, BurnedTicker>();
    for (const b of burned ?? []) m.set(b.ticker, b);
    return m;
  }, [burned]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['prefs', 'flagged'] });
  const addFlag = useMutation({
    mutationFn: (ticker: string) => prefsApi.addFlagged(ticker),
    onSuccess: invalidate,
  });
  const removeFlag = useMutation({
    mutationFn: (ticker: string) => prefsApi.removeFlagged(ticker),
    onSuccess: invalidate,
  });

  const warning = (ticker: string): TickerWarning | null => {
    const manual = manualMap.get(ticker);
    const b = burnedMap.get(ticker) ?? null;
    if (!manual && !b) return null;
    return {
      ticker,
      manual: !!manual,
      manualNote: manual?.note ?? null,
      auto: !!b,
      burned: b,
    };
  };

  return {
    warning,
    isFlagged: (ticker: string) => manualMap.has(ticker),
    toggleFlag: (ticker: string) =>
      manualMap.has(ticker) ? removeFlag.mutate(ticker) : addFlag.mutate(ticker),
    flaggedCount: manualMap.size,
    burnedCount: burnedMap.size,
  };
}

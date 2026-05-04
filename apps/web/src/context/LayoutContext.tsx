// Cross-cutting layout state (chart grid count) shared between the AppLayout
// header (which renders the count selector) and ChartGrid (which consumes it).
// Persisted per-user via /api/prefs/layout.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { prefsApi } from '../api/prefs';

export type ChartCount = 1 | 2 | 3 | 4;
const DEFAULT_CHART_COUNT: ChartCount = 4;

interface LayoutContextValue {
  chartCount: ChartCount;
  setChartCount: (n: ChartCount) => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [chartCount, setChartCountState] = useState<ChartCount>(DEFAULT_CHART_COUNT);
  const { data: serverLayout } = useQuery({
    queryKey: ['prefs', 'layout'],
    queryFn: () => prefsApi.getLayout(),
  });

  // Hydrate from server response once. The query may return undefined (in flight)
  // or null (no layout saved yet) — both are valid initial states; only commit
  // when we get an actual chart_count back.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || serverLayout === undefined) return;
    const cc = serverLayout?.chart_count;
    if (cc === 1 || cc === 2 || cc === 3 || cc === 4) setChartCountState(cc);
    hydrated.current = true;
  }, [serverLayout]);

  const setChartCount = (n: ChartCount) => {
    setChartCountState(n);
    prefsApi.putLayout({ chart_count: n }).catch(() => {});
  };

  return (
    <LayoutContext.Provider value={{ chartCount, setChartCount }}>
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayout(): LayoutContextValue {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used within LayoutProvider');
  return ctx;
}

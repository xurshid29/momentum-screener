// Cross-cutting layout state shared across the dashboard, persisted per-user
// via /api/prefs/layout (a single free-form jsonb row). Currently: the chart
// grid count (AppLayout header ↔ ChartGrid) and the Momentum "news-only"
// display filter (ScreenerPanel). Both live in the same jsonb blob, so every
// setter must persist the MERGED object — writing just one field would clobber
// the other (putLayout replaces, not merges).

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { prefsApi, type PanelLayout } from '../api/prefs';

// 0 = charts hidden entirely (the chart pane unmounts).
export type ChartCount = 0 | 1 | 2 | 3 | 4;
const DEFAULT_CHART_COUNT: ChartCount = 4;

interface LayoutContextValue {
  chartCount: ChartCount;
  setChartCount: (n: ChartCount) => void;
  momentumNewsOnly: boolean;
  setMomentumNewsOnly: (v: boolean) => void;
  ignitionNewsOnly: boolean;
  setIgnitionNewsOnly: (v: boolean) => void;
  // Sidebar section visibility — display-only hiding (server keeps
  // computing/alerting/grading); toggled from the sidebar header, persisted.
  hideLiveTicks: boolean;
  setHideLiveTicks: (v: boolean) => void;
  hideIgnitionList: boolean;
  setHideIgnitionList: (v: boolean) => void;
  hideNewsRadar: boolean;
  setHideNewsRadar: (v: boolean) => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [chartCount, setChartCountState] = useState<ChartCount>(DEFAULT_CHART_COUNT);
  const [momentumNewsOnly, setMomentumNewsOnlyState] = useState(false);
  const [ignitionNewsOnly, setIgnitionNewsOnlyState] = useState(false);
  const [hideLiveTicks, setHideLiveTicksState] = useState(false);
  const [hideIgnitionList, setHideIgnitionListState] = useState(false);
  const [hideNewsRadar, setHideNewsRadarState] = useState(false);
  const { data: serverLayout } = useQuery({
    queryKey: ['prefs', 'layout'],
    queryFn: () => prefsApi.getLayout(),
  });

  // Hydrate from server once. The query may return undefined (in flight) or
  // null (nothing saved yet) — both valid initial states.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || serverLayout === undefined) return;
    const cc = serverLayout?.chart_count;
    if (cc === 0 || cc === 1 || cc === 2 || cc === 3 || cc === 4) setChartCountState(cc);
    if (typeof serverLayout?.momentum_news_only === 'boolean') {
      setMomentumNewsOnlyState(serverLayout.momentum_news_only);
    }
    if (typeof serverLayout?.ignition_news_only === 'boolean') {
      setIgnitionNewsOnlyState(serverLayout.ignition_news_only);
    }
    if (typeof serverLayout?.hide_live_ticks === 'boolean') {
      setHideLiveTicksState(serverLayout.hide_live_ticks);
    }
    if (typeof serverLayout?.hide_ignition_list === 'boolean') {
      setHideIgnitionListState(serverLayout.hide_ignition_list);
    }
    if (typeof serverLayout?.hide_news_radar === 'boolean') {
      setHideNewsRadarState(serverLayout.hide_news_radar);
    }
    hydrated.current = true;
  }, [serverLayout]);

  // Persist the full merged layout so one field never clobbers the other.
  const persist = (patch: Partial<PanelLayout>) => {
    const next: PanelLayout = {
      chart_count: chartCount,
      momentum_news_only: momentumNewsOnly,
      ignition_news_only: ignitionNewsOnly,
      hide_live_ticks: hideLiveTicks,
      hide_ignition_list: hideIgnitionList,
      hide_news_radar: hideNewsRadar,
      ...patch,
    };
    prefsApi.putLayout(next).catch(() => {});
  };

  const setChartCount = (n: ChartCount) => {
    setChartCountState(n);
    persist({ chart_count: n });
  };

  const setMomentumNewsOnly = (v: boolean) => {
    setMomentumNewsOnlyState(v);
    persist({ momentum_news_only: v });
  };

  const setIgnitionNewsOnly = (v: boolean) => {
    setIgnitionNewsOnlyState(v);
    persist({ ignition_news_only: v });
  };

  const setHideLiveTicks = (v: boolean) => {
    setHideLiveTicksState(v);
    persist({ hide_live_ticks: v });
  };

  const setHideIgnitionList = (v: boolean) => {
    setHideIgnitionListState(v);
    persist({ hide_ignition_list: v });
  };

  const setHideNewsRadar = (v: boolean) => {
    setHideNewsRadarState(v);
    persist({ hide_news_radar: v });
  };

  return (
    <LayoutContext.Provider
      value={{
        chartCount,
        setChartCount,
        momentumNewsOnly,
        setMomentumNewsOnly,
        ignitionNewsOnly,
        setIgnitionNewsOnly,
        hideLiveTicks,
        setHideLiveTicks,
        hideIgnitionList,
        setHideIgnitionList,
        hideNewsRadar,
        setHideNewsRadar,
      }}
    >
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayout(): LayoutContextValue {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used within LayoutProvider');
  return ctx;
}

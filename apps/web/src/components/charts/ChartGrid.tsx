import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ChartSlot } from './ChartSlot';
import { useSelection } from '../../context/SelectionContext';
import { useLayout, type ChartCount } from '../../context/LayoutContext';
import { prefsApi } from '../../api/prefs';
import type { ChartPref } from '../../api/types';

const DEFAULT_INTERVALS = ['1', '5', '15', '60'];
const SLOT_INDICES = [1, 2, 3, 4] as const;

export function ChartGrid() {
  const { selected } = useSelection();
  const { chartCount } = useLayout();
  const { data: serverPrefs } = useQuery({
    queryKey: ['prefs', 'charts'],
    queryFn: () => prefsApi.getCharts(),
  });

  const [prefs, setPrefs] = useState<Record<number, Omit<ChartPref, 'user_id'>>>(() => ({
    1: { slot: 1, ticker: null, interval: DEFAULT_INTERVALS[0], follow_selection: true },
    2: { slot: 2, ticker: null, interval: DEFAULT_INTERVALS[1], follow_selection: true },
    3: { slot: 3, ticker: null, interval: DEFAULT_INTERVALS[2], follow_selection: true },
    4: { slot: 4, ticker: null, interval: DEFAULT_INTERVALS[3], follow_selection: true },
  }));

  const hydratedPrefs = useRef(false);
  useEffect(() => {
    if (hydratedPrefs.current || !serverPrefs) return;
    if (serverPrefs.length === 0) {
      hydratedPrefs.current = true;
      return;
    }
    setPrefs((prev) => {
      const next = { ...prev };
      for (const sp of serverPrefs) {
        next[sp.slot] = {
          slot: sp.slot,
          ticker: sp.ticker,
          interval: sp.interval,
          follow_selection: sp.follow_selection,
        };
      }
      return next;
    });
    hydratedPrefs.current = true;
  }, [serverPrefs]);

  // Selection follow — only update visible slots so hidden slots keep state.
  useEffect(() => {
    if (!selected) return;
    setPrefs((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const slot of SLOT_INDICES) {
        if (slot > chartCount) continue;
        if (next[slot].follow_selection && next[slot].ticker !== selected) {
          next[slot] = { ...next[slot], ticker: selected };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selected, chartCount]);

  const saveTimer = useRef<number | null>(null);
  const queueSavePrefs = (latest: typeof prefs) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const arr = SLOT_INDICES.map((s) => latest[s]);
      prefsApi.putCharts(arr).catch(() => {});
    }, 500);
  };

  const onIntervalChange = (slot: number, interval: string) => {
    setPrefs((prev) => {
      const next = { ...prev, [slot]: { ...prev[slot], interval } };
      queueSavePrefs(next);
      return next;
    });
  };

  const slot = useMemo(
    () => (n: number) => (
      <ChartSlot
        slotIndex={n}
        ticker={prefs[n].ticker}
        interval={prefs[n].interval}
        onIntervalChange={(i) => onIntervalChange(n, i)}
      />
    ),
    [prefs],
  );

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ChartLayout count={chartCount} renderSlot={slot} />
    </div>
  );
}

interface ChartLayoutProps {
  count: ChartCount;
  renderSlot: (n: number) => React.ReactNode;
}

// react-resizable-panels persists sizes by autoSaveId — suffixing the count
// makes each layout remember its own pane sizes independently.
function ChartLayout({ count, renderSlot }: ChartLayoutProps) {
  const HHandle = <PanelResizeHandle style={{ width: 4, background: '#0a0a0a' }} />;
  const VHandle = <PanelResizeHandle style={{ height: 4, background: '#0a0a0a' }} />;

  if (count === 0) return null; // charts hidden — DashboardPage unmounts the pane

  if (count === 1) {
    return <div style={{ width: '100%', height: '100%' }}>{renderSlot(1)}</div>;
  }

  if (count === 2) {
    return (
      <PanelGroup direction="horizontal" autoSaveId="ms-charts-h-2">
        <Panel defaultSize={50} minSize={20}>{renderSlot(1)}</Panel>
        {HHandle}
        <Panel defaultSize={50} minSize={20}>{renderSlot(2)}</Panel>
      </PanelGroup>
    );
  }

  if (count === 3) {
    return (
      <PanelGroup direction="vertical" autoSaveId="ms-charts-v-3">
        <Panel defaultSize={50} minSize={20}>{renderSlot(1)}</Panel>
        {VHandle}
        <Panel defaultSize={50} minSize={20}>
          <PanelGroup direction="horizontal" autoSaveId="ms-charts-h-3-bottom">
            <Panel defaultSize={50} minSize={20}>{renderSlot(2)}</Panel>
            {HHandle}
            <Panel defaultSize={50} minSize={20}>{renderSlot(3)}</Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    );
  }

  // count === 4
  return (
    <PanelGroup direction="vertical" autoSaveId="ms-charts-v-4">
      <Panel defaultSize={50} minSize={20}>
        <PanelGroup direction="horizontal" autoSaveId="ms-charts-h-4-top">
          <Panel defaultSize={50} minSize={20}>{renderSlot(1)}</Panel>
          {HHandle}
          <Panel defaultSize={50} minSize={20}>{renderSlot(2)}</Panel>
        </PanelGroup>
      </Panel>
      {VHandle}
      <Panel defaultSize={50} minSize={20}>
        <PanelGroup direction="horizontal" autoSaveId="ms-charts-h-4-bottom">
          <Panel defaultSize={50} minSize={20}>{renderSlot(3)}</Panel>
          {HHandle}
          <Panel defaultSize={50} minSize={20}>{renderSlot(4)}</Panel>
        </PanelGroup>
      </Panel>
    </PanelGroup>
  );
}

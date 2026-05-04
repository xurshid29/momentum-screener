import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ChartSlot } from './ChartSlot';
import { useSelection } from '../../context/SelectionContext';
import { prefsApi } from '../../api/prefs';
import type { ChartPref } from '../../api/types';

const DEFAULT_INTERVALS = ['1', '5', '15', '60'];

export function ChartGrid() {
  const { selected } = useSelection();
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

  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !serverPrefs) return;
    if (serverPrefs.length === 0) {
      hydrated.current = true;
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
    hydrated.current = true;
  }, [serverPrefs]);

  useEffect(() => {
    if (!selected) return;
    setPrefs((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const slot of [1, 2, 3, 4]) {
        if (next[slot].follow_selection && next[slot].ticker !== selected) {
          next[slot] = { ...next[slot], ticker: selected };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selected]);

  const saveTimer = useRef<number | null>(null);
  const queueSave = (latest: typeof prefs) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const arr = [1, 2, 3, 4].map((s) => latest[s]);
      prefsApi.putCharts(arr).catch(() => {});
    }, 500);
  };

  const onIntervalChange = (slot: number, interval: string) => {
    setPrefs((prev) => {
      const next = { ...prev, [slot]: { ...prev[slot], interval } };
      queueSave(next);
      return next;
    });
  };

  const slot = (n: number) => (
    <ChartSlot
      slotIndex={n}
      ticker={prefs[n].ticker}
      interval={prefs[n].interval}
      onIntervalChange={(i) => onIntervalChange(n, i)}
    />
  );

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <PanelGroup direction="vertical" autoSaveId="ms-charts-v">
        <Panel defaultSize={50} minSize={20}>
          <PanelGroup direction="horizontal" autoSaveId="ms-charts-h-top">
            <Panel defaultSize={50} minSize={20}>{slot(1)}</Panel>
            <PanelResizeHandle style={{ width: 4, background: '#0a0a0a' }} />
            <Panel defaultSize={50} minSize={20}>{slot(2)}</Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle style={{ height: 4, background: '#0a0a0a' }} />
        <Panel defaultSize={50} minSize={20}>
          <PanelGroup direction="horizontal" autoSaveId="ms-charts-h-bottom">
            <Panel defaultSize={50} minSize={20}>{slot(3)}</Panel>
            <PanelResizeHandle style={{ width: 4, background: '#0a0a0a' }} />
            <Panel defaultSize={50} minSize={20}>{slot(4)}</Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  );
}

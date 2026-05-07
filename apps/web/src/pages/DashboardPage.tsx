import { useEffect, type ReactNode } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useScreenerStream } from '../hooks/useScreenerStream';
import { useScreenerAlerts } from '../hooks/useScreenerAlerts';
import { useTabTitleFlash } from '../hooks/useTabTitleFlash';
import { ScreenerPanel } from '../components/screener/ScreenerPanel';
import { SelectedStockPanel } from '../components/screener/SelectedStockPanel';
import { NewsRoomPanel } from '../components/news/NewsRoomPanel';
import { ChartGrid } from '../components/charts/ChartGrid';
import { SelectionProvider, useSelection } from '../context/SelectionContext';
import type { CyclePayload } from '../api/types';

// All panel sizes are persisted to localStorage by react-resizable-panels using
// the autoSaveId. Per-user persistence to /api/prefs/layout is a future bonus —
// localStorage already gives "remembered across sessions" on the same device.

export function DashboardPage() {
  const { payload, connected } = useScreenerStream();
  useScreenerAlerts(payload);
  useTabTitleFlash(payload);

  return (
    <SelectionProvider>
      <AutoSelectFirstTicker payload={payload} />
      <div style={{ width: '100%', height: '100%', background: '#0a0a0a' }}>
        <PanelGroup direction="horizontal" autoSaveId="ms-outer">
          <Panel defaultSize={50} minSize={25}>
            <PanelGroup direction="vertical" autoSaveId="ms-left">
              <Panel defaultSize={45} minSize={20}>
                <Card><ScreenerPanel payload={payload} connected={connected} /></Card>
              </Panel>
              <VHandle />
              <Panel defaultSize={30} minSize={15}>
                <Card><SelectedStockPanel payload={payload} /></Card>
              </Panel>
              <VHandle />
              <Panel defaultSize={25} minSize={15}>
                <Card><NewsRoomPanel payload={payload} /></Card>
              </Panel>
            </PanelGroup>
          </Panel>
          <HHandle />
          <Panel defaultSize={50} minSize={25}>
            <Card>
              <ChartGrid />
            </Card>
          </Panel>
        </PanelGroup>
      </div>
    </SelectionProvider>
  );
}

// On dashboard mount, pick the first ticker from the screener so charts and
// the Quote Details panel start with content. Only fires while nothing is
// selected — the first user click locks selection in.
function AutoSelectFirstTicker({ payload }: { payload: CyclePayload | null }) {
  const { selected, setSelected } = useSelection();
  const firstTicker = payload?.rows?.[0]?.ticker ?? null;
  useEffect(() => {
    if (selected != null) return;
    if (firstTicker) setSelected(firstTicker);
  }, [selected, firstTicker, setSelected]);
  return null;
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: '#1a1a1a',
        border: '1px solid #303030',
        borderRadius: 4,
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {children}
    </div>
  );
}

function HHandle() {
  return (
    <PanelResizeHandle
      style={{ width: 4, background: '#0a0a0a', cursor: 'col-resize', transition: 'background 0.15s' }}
      className="ms-handle ms-handle-h"
    />
  );
}

function VHandle() {
  return (
    <PanelResizeHandle
      style={{ height: 4, background: '#0a0a0a', cursor: 'row-resize', transition: 'background 0.15s' }}
      className="ms-handle ms-handle-v"
    />
  );
}

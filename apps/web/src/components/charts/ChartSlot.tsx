import { useState } from 'react';
import { Select, Button, Tooltip, Space, Typography } from 'antd';
import { FullscreenOutlined, FullscreenExitOutlined, LinkOutlined } from '@ant-design/icons';
import { TradingViewWidget } from './TradingViewWidget';

const { Text } = Typography;

const INTERVAL_OPTIONS = [
  { label: '1m', value: '1' },
  { label: '5m', value: '5' },
  { label: '15m', value: '15' },
  { label: '30m', value: '30' },
  { label: '1h', value: '60' },
  { label: '4h', value: '240' },
  { label: '1D', value: 'D' },
];

// Hardcoded study sets per interval. Volume is rendered by the TV widget by
// default at the bottom of every chart, so we don't list it explicitly.
//
// studies_overrides keys: lowercase study display name + dotted property path.
// The free embed widget honors most of these, but some properties may be
// silently ignored depending on widget version.
function studiesForInterval(interval: string): { studies: string[]; overrides: Record<string, unknown> } {
  if (interval === '1') {
    return {
      studies: [
        'VWAP@tv-basicstudies',
        'MACD@tv-basicstudies',
        'MAExp@tv-basicstudies',
      ],
      overrides: {
        // VWAP color/thickness — try every documented and observed path form;
        // unknown keys are silently ignored by the widget. Style overrides on
        // the FREE embed are inconsistent — if none of these stick, it's a
        // Charting-Library-only feature in this widget version.
        'VWAP.VWAP.color':                         '#ff9800',
        'VWAP.VWAP.linewidth':                     2,
        'VWAP.plot.color':                         '#ff9800',
        'VWAP.plot.linewidth':                     2,
        'Volume Weighted Average Price.VWAP.color':       '#ff9800',
        'Volume Weighted Average Price.VWAP.linewidth':   2,
        'Volume Weighted Average Price.plot.color':       '#ff9800',
        'Volume Weighted Average Price.plot.linewidth':   2,
        'volume weighted average price.color':     '#ff9800',
        'volume weighted average price.linewidth': 2,

        // EMA length — input overrides reliably work on the free widget. Try
        // both casings since this family of studies is sometimes case-sensitive.
        'Moving Average Exponential.length': 20,
        'moving average exponential.length': 20,
      },
    };
  }
  // Other intervals: rely on TV's default Volume pane only.
  return { studies: [], overrides: {} };
}

interface ChartSlotProps {
  slotIndex: number;
  ticker: string | null;
  interval: string;
  onIntervalChange: (interval: string) => void;
  onFullscreenChange?: (fullscreen: boolean) => void;
}

export function ChartSlot({ slotIndex, ticker, interval, onIntervalChange, onFullscreenChange }: ChartSlotProps) {
  const [fullscreen, setFullscreen] = useState(false);

  const containerId = `tv_slot_${slotIndex}`;
  const display = ticker ?? '—';
  const { studies, overrides } = studiesForInterval(interval);

  const toggleFullscreen = () => {
    const next = !fullscreen;
    setFullscreen(next);
    onFullscreenChange?.(next);
  };

  const openInTv = () => {
    if (!ticker) return;
    window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(ticker)}`, '_blank', 'noopener');
  };

  return (
    <div
      style={{
        position: fullscreen ? 'fixed' : 'relative',
        inset: fullscreen ? 0 : undefined,
        width: '100%',
        height: '100%',
        background: '#1a1a1a',
        border: '1px solid #303030',
        borderRadius: 4,
        display: 'flex',
        flexDirection: 'column',
        zIndex: fullscreen ? 1000 : undefined,
      }}
    >
      <div
        style={{
          padding: '4px 8px',
          borderBottom: '1px solid #303030',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flex: '0 0 auto',
        }}
      >
        <Space>
          <Text strong style={{ color: '#e0e0e0', fontSize: 13 }}>{display}</Text>
          <Select
            size="small"
            value={interval}
            options={INTERVAL_OPTIONS}
            onChange={onIntervalChange}
            style={{ width: 70 }}
          />
        </Space>
        <Space>
          <Tooltip title="Open in TradingView (use for 10S/30S)">
            <Button size="small" icon={<LinkOutlined />} onClick={openInTv} disabled={!ticker} />
          </Tooltip>
          <Tooltip title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            <Button
              size="small"
              icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={toggleFullscreen}
            />
          </Tooltip>
        </Space>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        {ticker ? (
          <TradingViewWidget
            symbol={ticker}
            interval={interval}
            containerId={containerId}
            theme="dark"
            studies={studies}
            studiesOverrides={overrides}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666' }}>
            Click a ticker in the screener
          </div>
        )}
      </div>
    </div>
  );
}

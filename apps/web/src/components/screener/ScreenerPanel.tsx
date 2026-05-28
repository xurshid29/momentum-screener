import { useMemo, useState, type MouseEvent } from 'react';
import { Table, Tabs, Tag, Typography, Tooltip, Badge, Button, Space, Popover, List } from 'antd';
import { FilterOutlined, CloseOutlined, EyeInvisibleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { CatalystInfo, CyclePayload, EnrichedRow, RowStatus, TradingSession } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { TickerLink } from '../common/TickerLink';
import { FireBadge } from '../common/FireBadge';
import { ShelfBadge } from '../common/ShelfBadge';
import { fmtPct, fmtFloat, fmtPrice, fmtVolume, fmtMcap, fmtRelVol, fmtBigPct, num } from '../../utils/format';
import { FiltersDialog } from './FiltersDialog';
import { CatalystNewsModal } from './CatalystNewsModal';

const { Text } = Typography;

interface ScreenerPanelProps {
  payload: CyclePayload | null;
  connected: boolean;
}

const STATUS_COLOR: Record<NonNullable<RowStatus>, string> = {
  NEW: 'blue',
  ACC: 'orange',
  UP: 'green',
  NEWS: 'purple',
};

const SESSION_LABEL: Record<TradingSession, string> = {
  premarket: 'pre-market',
  regular: 'market',
  afterhours: 'after-hours',
  closed: 'closed',
};

const SESSION_COLOR: Record<TradingSession, string> = {
  premarket: '#1890ff',
  regular: '#52c41a',
  afterhours: '#faad14',
  closed: '#8c8c8c',
};

type ScreenerTab = 'momentum' | 'swing';

export function ScreenerPanel({ payload, connected }: ScreenerPanelProps) {
  const { selected, setSelected } = useSelection();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [catalystModal, setCatalystModal] = useState<{ ticker: string; catalyst: CatalystInfo | null } | null>(null);
  const [activeTab, setActiveTab] = useState<ScreenerTab>('momentum');
  const { hidden, hide, unhide } = useHiddenTickers();

  const columns: ColumnsType<EnrichedRow> = useMemo(
    () => [
      {
        title: '',
        key: 'links',
        width: 76,
        render: (_v, row) => (
          <Space size={4} onClick={(e) => e.stopPropagation()}>
            <a
              href={row.finviz_url}
              target="_blank"
              rel="noreferrer"
              className="screener-link-btn"
            >
              <img src="/finviz-icon.png" alt="Finviz" />
            </a>
            <a
              href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(row.ticker)}`}
              target="_blank"
              rel="noreferrer"
              className="screener-link-btn"
            >
              <img src="/tradingview-icon.png" alt="TradingView" />
            </a>
          </Space>
        ),
      },
      {
        title: '',
        dataIndex: 'status',
        key: 'status',
        width: 56,
        render: (s: RowStatus) =>
          s ? <Tag color={STATUS_COLOR[s]} style={{ margin: 0, fontSize: 10 }}>{s}</Tag> : null,
      },
      {
        title: 'Ticker',
        dataIndex: 'ticker',
        key: 'ticker',
        width: 126,
        render: (t: string, row) => (
          <span>
            <TickerLink
              ticker={t}
              onSelect={setSelected}
              stopPropagation
              style={{ color: '#fff', fontWeight: 600 }}
            />
            {row.is_fresh_news && <span title="Fresh news this cycle"> 🚨</span>}
            {row.has_today_news && (
              <CatalystBadge
                score={row.catalyst?.score ?? null}
                reason={row.catalyst?.reason}
                type={row.catalyst?.type}
                onOpen={() => setCatalystModal({ ticker: row.ticker, catalyst: row.catalyst ?? null })}
              />
            )}
            {row.shelf && (
              <span style={{ marginLeft: 6 }}>
                <ShelfBadge shelf={row.shelf} />
              </span>
            )}
          </span>
        ),
      },
      {
        // After-hours cycles carry the after-hours move in change_pct.
        title: payload?.session === 'afterhours' ? 'AH Chg %' : 'Chg %',
        dataIndex: 'change_pct',
        key: 'change_pct',
        width: 80,
        align: 'right',
        render: (raw, row) => {
          const v = num(raw);
          const ad = num(row.accel_delta);
          return (
            <Tooltip title={ad != null ? `Δ ${ad > 0 ? '+' : ''}${ad.toFixed(2)}%` : null}>
              <Text style={{ color: (v ?? 0) >= 0 ? '#52c41a' : '#ff4d4f' }}>{fmtPct(raw)}</Text>
            </Tooltip>
          );
        },
        sorter: (a, b) => (num(a.change_pct) ?? 0) - (num(b.change_pct) ?? 0),
      },
      {
        title: 'Float',
        dataIndex: 'float_m',
        key: 'float_m',
        width: 70,
        align: 'right',
        render: (raw, row) =>
          row.float_is_proxy ? (
            <Tooltip title="Shares outstanding (Finviz did not report a Float value)">
              <span style={{ color: '#bfbfbf' }}>{fmtFloat(raw)}<span style={{ color: '#888' }}>*</span></span>
            </Tooltip>
          ) : (
            fmtFloat(raw)
          ),
      },
      { title: 'Price', dataIndex: 'price', key: 'price', width: 75, align: 'right', render: fmtPrice },
      { title: 'Volume', dataIndex: 'volume', key: 'volume', width: 80, align: 'right', render: fmtVolume },
      {
        title: 'RVol Day',
        dataIndex: 'rel_volume',
        key: 'rel_volume',
        width: 80,
        align: 'right',
        render: (raw) => {
          const v = num(raw);
          // Highlight unusual rel-vol — momentum traders watch for >5x.
          const color = v == null ? undefined : v >= 5 ? '#faad14' : v >= 2 ? '#52c41a' : undefined;
          return <Text style={{ color }}>{fmtRelVol(raw)}</Text>;
        },
        sorter: (a, b) => (num(a.rel_volume) ?? 0) - (num(b.rel_volume) ?? 0),
      },
      {
        title: 'RVol 5m',
        dataIndex: 'rel_vol_5min',
        key: 'rel_vol_5min',
        width: 90,
        align: 'right',
        render: (raw) => {
          const v = num(raw);
          // 100% = exactly typical 5-min slice. >500% is hot, >5000% is extreme.
          const color = v == null ? undefined : v >= 5000 ? '#faad14' : v >= 500 ? '#52c41a' : undefined;
          return <Text style={{ color }}>{fmtBigPct(raw)}</Text>;
        },
        sorter: (a, b) => (num(a.rel_vol_5min) ?? 0) - (num(b.rel_vol_5min) ?? 0),
      },
      { title: 'MCap', dataIndex: 'mcap_m', key: 'mcap_m', width: 70, align: 'right', render: fmtMcap },
      { title: 'Country', dataIndex: 'country', key: 'country', width: 90, ellipsis: true },
      {
        title: '',
        key: 'hide',
        width: 36,
        align: 'center',
        render: (_v, row) => (
          <Tooltip title="Hide for today">
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined style={{ fontSize: 11, color: '#888' }} />}
              onClick={(e) => { e.stopPropagation(); hide(row.ticker); }}
              style={{ width: 22, height: 22, padding: 0 }}
            />
          </Tooltip>
        ),
      },
    ],
    [hide, payload?.session],
  );

  const allRows = payload?.rows ?? [];
  const rows = allRows.filter((r) => !hidden.has(r.ticker));
  const hiddenInScreener = allRows.filter((r) => hidden.has(r.ticker)).map((r) => r.ticker);
  // Tickers the user hid that aren't currently in the screener — still show
  // them in the "Hidden" list so the user can unhide blind if they want.
  const hiddenOutside = [...hidden].filter((t) => !allRows.some((r) => r.ticker === t));
  const hiddenList = [...hiddenInScreener, ...hiddenOutside];

  // Header controls — Filters is Momentum-specific (the live config it edits
  // is the Momentum filter); the rest (hidden popover + live indicator) are
  // universal across tabs.
  const extraControls = (
    <Space size="middle" style={{ paddingRight: 8 }}>
      {hiddenList.length > 0 && (
        <Popover
          trigger="click"
          placement="bottomRight"
          content={
            <List
              size="small"
              style={{ minWidth: 160 }}
              dataSource={hiddenList}
              locale={{ emptyText: 'Nothing hidden' }}
              renderItem={(t) => (
                <List.Item style={{ padding: '4px 0' }}>
                  <Text strong style={{ flex: 1 }}>{t}</Text>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => unhide(t)}
                    style={{ padding: 0, height: 'auto' }}
                  >
                    unhide
                  </Button>
                </List.Item>
              )}
            />
          }
        >
          <Button size="small" icon={<EyeInvisibleOutlined />}>
            {hiddenList.length} hidden
          </Button>
        </Popover>
      )}
      {activeTab === 'momentum' && (
        <Tooltip title="Edit filters">
          <Button size="small" icon={<FilterOutlined />} onClick={() => setFiltersOpen(true)}>
            Filters
          </Button>
        </Tooltip>
      )}
      <Badge
        status={connected ? 'success' : 'default'}
        text={
          <Text type="secondary" style={{ fontSize: 12 }}>
            {connected ? 'live' : 'offline'}
            {payload?.session && (
              <>
                {' · '}
                <span style={{ color: SESSION_COLOR[payload.session] }}>
                  {SESSION_LABEL[payload.session]}
                </span>
              </>
            )}
            {payload?.polled_at && ` · ${new Date(payload.polled_at).toLocaleTimeString()}`}
          </Text>
        }
      />
    </Space>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <FiltersDialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        config={payload?.config ?? null}
      />
      <CatalystNewsModal
        ticker={catalystModal?.ticker ?? null}
        catalyst={catalystModal?.catalyst ?? null}
        onClose={() => setCatalystModal(null)}
      />
      <Tabs
        size="small"
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as ScreenerTab)}
        className="tabs-fill-height"
        tabBarStyle={{ margin: 0, padding: '0 8px', borderBottom: '1px solid #303030' }}
        tabBarExtraContent={extraControls}
        items={[
          {
            key: 'momentum',
            label: `Momentum · ${rows.length}`,
            children: (
              <div style={{ height: '100%', overflow: 'auto' }}>
                <Table<EnrichedRow>
                  rowKey="ticker"
                  size="small"
                  columns={columns}
                  dataSource={rows}
                  pagination={false}
                  sticky
                  rowClassName={(r) => (r.is_fresh_news ? 'screener-row-fresh' : '')}
                  onRow={(r) => ({
                    onClick: () => setSelected(r.ticker),
                    style: {
                      cursor: 'pointer',
                      background: r.ticker === selected ? '#15395b' : undefined,
                    },
                  })}
                />
              </div>
            ),
          },
          {
            key: 'swing',
            label: 'Swing',
            children: <SwingStub />,
          },
        ]}
      />
    </div>
  );
}

// Catalyst marker for a screener row. Color + flame count signal strength
// at a glance; tooltip carries the precise score and reason. Clicking opens
// the catalyst/news modal for the ticker.
//   ≥70  🔥🔥 red    — major catalyst
//   40+  🔥    orange — strong
//   15+  🔥    yellow — weak
//   <15  —            — hidden
function CatalystBadge({
  score,
  reason,
  type,
  onOpen,
}: {
  score: number | null;
  reason?: string;
  type?: string;
  onOpen: () => void;
}) {
  // Stop the click bubbling to the row so opening the modal doesn't also
  // re-select the row underneath.
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    onOpen();
  };
  if (score == null) {
    return (
      <span
        title="Catalyst score pending — click for news"
        onClick={open}
        style={{ marginLeft: 6, opacity: 0.55, cursor: 'pointer' }}
      >
        ✨
      </span>
    );
  }
  if (score < 15) return null;
  const tooltip = `${score} · ${type ?? ''}${reason ? ` — ${reason}` : ''} · click for news`.trim();
  return (
    <span title={tooltip} onClick={open} style={{ marginLeft: 6, cursor: 'pointer' }}>
      <FireBadge score={score} />
    </span>
  );
}

// Placeholder for the Swing screener tab — shows what's coming so the tab
// isn't empty while the backend is being built. See docs/swing-screener-spec.md
// for the locked-in v1 design (universe, score weights, cadence, data deps).
function SwingStub() {
  return (
    <div style={{ padding: '20px 24px', height: '100%', overflow: 'auto' }}>
      <Text strong style={{ color: '#e0e0e0', fontSize: 16, display: 'block', marginBottom: 8 }}>
        Swing screener — coming soon
      </Text>
      <Text type="secondary" style={{ display: 'block', marginBottom: 24, maxWidth: 720 }}>
        Multi-day setups (1–5 day holds): clean breakouts from tight bases,
        gap-and-hold on durable catalysts, trend continuations off the 20-day
        SMA. Different universe than Momentum/Ignition — $2–$50, float
        5–100M, mcap ≥ $50M. Full design in <code>docs/swing-screener-spec.md</code>.
      </Text>

      <StubSection title="Planned columns">
        <StubItem k="Score">0–100, weighted: Trend 25 + Strength 15 + Setup 25 + Volume 15 + Catalyst 20 (shelf penalty −25 max)</StubItem>
        <StubItem k="Setup flags">base · breakout · close strength</StubItem>
        <StubItem k="Dist 52WH">distance from 52-week high</StubItem>
        <StubItem k="vs 20-SMA">price relative to 20-day moving average</StubItem>
        <StubItem k="Vol vs Avg">today's volume × 20-day average</StubItem>
        <StubItem k="Cat / Shelf">same as Momentum, catalyst durability weighs heavier</StubItem>
      </StubSection>

      <StubSection title="Implementation progress">
        <StubStep done>Spec doc</StubStep>
        <StubStep done>UI scaffold (this tab)</StubStep>
        <StubStep>Daily-bar backfill (Phase 3b — hard prerequisite)</StubStep>
        <StubStep>Swing scan + score + persistence</StubStep>
        <StubStep>Real Swing table</StubStep>
        <StubStep>Telegram /swing command</StubStep>
      </StubSection>
    </div>
  );
}

function StubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <Text
        strong
        style={{
          color: '#888',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          display: 'block',
          marginBottom: 8,
        }}
      >
        {title}
      </Text>
      <div style={{ paddingLeft: 4 }}>{children}</div>
    </div>
  );
}

function StubItem({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '3px 0', fontSize: 13, lineHeight: 1.5 }}>
      <span style={{ color: '#e0e0e0', minWidth: 110, fontWeight: 500 }}>{k}</span>
      <Text type="secondary" style={{ flex: 1 }}>{children}</Text>
    </div>
  );
}

function StubStep({ done = false, children }: { done?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ padding: '3px 0', fontSize: 13, color: done ? '#52c41a' : '#8c8c8c' }}>
      <span style={{ marginRight: 8 }}>{done ? '✓' : '○'}</span>
      {children}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Table, Tabs, Tag, Typography, Tooltip, Badge, Button, Space, Popover, List, Checkbox } from 'antd';
import { FilterOutlined, CloseOutlined, EyeInvisibleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { CatalystInfo, CyclePayload, EnrichedRow, RowStatus, TradingSession } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useLayout } from '../../context/LayoutContext';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { WatchlistStar } from '../common/WatchlistStar';
import { CatalystBadge } from '../common/CatalystBadge';
import { ShelfBadge } from '../common/ShelfBadge';
import { WarningBadge, useIsWarned } from '../common/WarningBadge';
import { fmtPct, fmtFloat, fmtPrice, fmtVolume, fmtMcap, fmtRelVol, fmtBigPct, num } from '../../utils/format';
import { FiltersDialog } from './FiltersDialog';
import { CatalystNewsModal } from './CatalystNewsModal';
import { SwingTable } from './SwingTable';
import { ContinuationTable } from './ContinuationTable';
import { HistoryByDayPanel } from './HistoryByDayPanel';
import { OutcomesPanel } from './OutcomesPanel';

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

type ScreenerTab = 'momentum' | 'swing' | 'continuation' | 'history';

// First-appeared time in the operator's TZ (UTC+5), HH:MM, plus how long ago.
// The "ago" is the staleness cue: a top-of-list +600% name first seen 9h ago is
// a stale leftover, not a fresh mover.
const APPEARED_TZ = 'Asia/Tashkent'; // UTC+5, no DST

// Heat value — colour-tiered like a temperature so the eye catches the hot
// (fresh/rising) rows at the top of the default sort.
function HeatCell({ heat }: { heat: number }) {
  const color = heat >= 60 ? '#ff4d4f' : heat >= 40 ? '#fa8c16' : heat >= 20 ? '#fadb14' : '#8c8c8c';
  return (
    <Tooltip title="Activity now: freshness + acceleration + VWAP reclaim + 5m-RVol + 1m+5m burst + fresh news">
      <span style={{ color, fontWeight: 700 }}>{heat}</span>
    </Tooltip>
  );
}

function AppearedCell({ iso }: { iso: string | null }) {
  if (!iso) return <Text type="secondary">—</Text>;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return <Text type="secondary">—</Text>;
  const hhmm = t.toLocaleTimeString('en-GB', {
    timeZone: APPEARED_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const mins = Math.max(0, Math.round((Date.now() - t.getTime()) / 60000));
  const ago = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
  // Older than ~2h on a momentum runner = likely past its move; dim it.
  const stale = mins >= 120;
  return (
    <Tooltip title={`First appeared ${hhmm} (UTC+5) · ${ago} ago`}>
      <span style={{ lineHeight: 1.15, display: 'inline-block' }}>
        <div style={{ fontSize: 12 }}>{hhmm}</div>
        <div style={{ fontSize: 10, color: stale ? '#fa8c16' : '#8c8c8c' }}>{ago} ago</div>
      </span>
    </Tooltip>
  );
}

export function ScreenerPanel({ payload, connected }: ScreenerPanelProps) {
  const { selected, setSelected } = useSelection();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [catalystModal, setCatalystModal] = useState<{ ticker: string; catalyst: CatalystInfo | null } | null>(null);
  const [activeTab, setActiveTab] = useState<ScreenerTab>('momentum');
  const { hidden, hide, unhide } = useHiddenTickers();
  const { momentumNewsOnly, setMomentumNewsOnly } = useLayout();
  const isWarned = useIsWarned();

  const columns: ColumnsType<EnrichedRow> = useMemo(
    () => [
      {
        title: '',
        key: 'links',
        width: 98,
        render: (_v, row) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <WatchlistStar ticker={row.ticker} />
            <TickerLinks ticker={row.ticker} finvizUrl={row.finviz_url} />
          </span>
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
            {row.vwap_reclaim && (
              <Tooltip title="Reclaimed VWAP this cycle — crossed from below to above">
                <span style={{ color: '#52c41a', fontWeight: 700, marginLeft: 4 }}>↑VWAP</span>
              </Tooltip>
            )}
            {row.has_today_news && (
              <CatalystBadge
                score={row.catalyst?.score ?? null}
                hype={row.catalyst?.hype}
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
            <WarningBadge ticker={t} />
          </span>
        ),
      },
      {
        // "Activity now" — fresh/accelerating/VWAP-reclaiming names rank above
        // stale big-Chg% leaders. Default sort, so the top of the list is
        // "worth looking at right now" instead of "already won today". Click
        // Chg% to fall back to the cumulative-level view.
        title: 'Heat',
        dataIndex: 'heat',
        key: 'heat',
        width: 64,
        align: 'right',
        defaultSortOrder: 'descend',
        sorter: (a, b) => a.heat - b.heat,
        render: (h: number) => <HeatCell heat={h} />,
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
          // 100% = exactly typical 5-min slice. Cuts ≈ p57 / p86 of the
          // momentum universe on the exact-window scale (fixed 2026-06-12).
          const color = v == null ? undefined : v >= 10000 ? '#faad14' : v >= 1000 ? '#52c41a' : undefined;
          return <Text style={{ color }}>{fmtBigPct(raw)}</Text>;
        },
        sorter: (a, b) => (num(a.rel_vol_5min) ?? 0) - (num(b.rel_vol_5min) ?? 0),
      },
      {
        // The fast companion read: volume over the trailing 60s vs a typical
        // 1-min slice. Answers "is the burst live RIGHT NOW" — it collapses
        // within a minute when buying stops, while 5m stays elevated. Both
        // columns hot at once is the strongest live-surge tell.
        title: 'RVol 1m',
        dataIndex: 'rel_vol_1min',
        key: 'rel_vol_1min',
        width: 90,
        align: 'right',
        render: (raw, row) => {
          const v = num(raw);
          // RVol is share turnover — direction-blind by construction. A hot
          // burst while price fell over the same minute is sell-side pressure
          // (distribution / shakeout prints): same magnitude tiers, tinted
          // red. Measured: red bursts still bounce +4pts within 10 min ~68%
          // of the time on this universe — "decision moment", not "avoid".
          const falling = v != null && v >= 1000
            && row.chg_delta_1min != null && row.chg_delta_1min <= -2;
          const color = v == null ? undefined
            : falling ? '#ff4d4f'
            : v >= 15000 ? '#faad14' : v >= 1000 ? '#52c41a' : undefined;
          const cell = <Text style={{ color }}>{fmtBigPct(raw)}</Text>;
          return falling
            ? <Tooltip title={`Sell-side burst — price ${row.chg_delta_1min}pts over the last minute on this volume`}>{cell}</Tooltip>
            : cell;
        },
        sorter: (a, b) => (num(a.rel_vol_1min) ?? 0) - (num(b.rel_vol_1min) ?? 0),
      },
      { title: 'MCap', dataIndex: 'mcap_m', key: 'mcap_m', width: 70, align: 'right', render: fmtMcap },
      { title: 'Country', dataIndex: 'country', key: 'country', width: 90, ellipsis: true },
      {
        // When the ticker first appeared in a screen today (UTC+5). Reference
        // info — moved to the far right now that Heat (the sort key) leads.
        // Disambiguates a fresh mover from a stale leader sitting on a big Chg%.
        title: 'Appeared',
        dataIndex: 'first_seen_at',
        key: 'first_seen_at',
        width: 92,
        align: 'right',
        sorter: (a, b) =>
          new Date(a.first_seen_at).getTime() - new Date(b.first_seen_at).getTime(),
        render: (iso: string) => <AppearedCell iso={iso} />,
      },
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
  // Hidden filter always applies; the "news only" toggle additionally drops
  // rows with no catalyst/news today (client-side display filter — the Finviz
  // fetch is unchanged).
  const rows = allRows.filter(
    (r) => !hidden.has(r.ticker) && (!momentumNewsOnly || r.has_today_news),
  );
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
        <Tooltip title="Show only rows with a catalyst / news today">
          <Checkbox
            checked={momentumNewsOnly}
            onChange={(e) => setMomentumNewsOnly(e.target.checked)}
            style={{ fontSize: 12 }}
          >
            🔥 News only
          </Checkbox>
        </Tooltip>
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
                  rowClassName={(r) =>
                    [isWarned(r.ticker) ? 'screener-row-warned' : '', r.is_fresh_news ? 'screener-row-fresh' : '']
                      .filter(Boolean)
                      .join(' ')
                  }
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
            label: `Swing${payload?.swing && payload.swing.length ? ` · ${payload.swing.length}` : ''}`,
            children: (
              <SwingTable
                rows={payload?.swing ?? []}
                onOpenCatalyst={(ticker, catalyst) => setCatalystModal({ ticker, catalyst })}
              />
            ),
          },
          {
            key: 'history',
            label: 'History',
            children: (
              <HistoryByDayPanel
                payload={payload}
                onOpenCatalyst={(ticker, catalyst) => setCatalystModal({ ticker, catalyst })}
              />
            ),
          },
          {
            key: 'outcomes',
            label: 'Outcomes',
            children: <OutcomesPanel />,
          },
          {
            // Demoted to last + reframed (2026-06-11). Our outcome data showed
            // the continuation pattern is a NEGATIVE long signal: multi-day-
            // prior names averaged −2.4% / 28% win over 5d vs +3.2% / 39% for
            // fresh first-day names. So this is no longer a buy list — it's a
            // "these already ran, watch for the fade/short" context tab.
            key: 'continuation',
            label: `Faders${payload?.continuation && payload.continuation.length ? ` · ${payload.continuation.length}` : ''}`,
            children: (
              <ContinuationTable
                rows={payload?.continuation ?? []}
                payload={payload}
                onOpenCatalyst={(ticker, catalyst) => setCatalystModal({ ticker, catalyst })}
              />
            ),
          },
        ]}
      />
    </div>
  );
}


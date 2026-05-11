import { useMemo, useState } from 'react';
import { Table, Tag, Typography, Tooltip, Badge, Button, Space } from 'antd';
import { FilterOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { CyclePayload, EnrichedRow, RowStatus } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { TickerLink } from '../common/TickerLink';
import { fmtPct, fmtFloat, fmtPrice, fmtVolume, fmtMcap, fmtRelVol, fmtBigPct, num } from '../../utils/format';
import { FiltersDialog } from './FiltersDialog';

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

export function ScreenerPanel({ payload, connected }: ScreenerPanelProps) {
  const { selected, setSelected } = useSelection();
  const [filtersOpen, setFiltersOpen] = useState(false);

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
        width: 110,
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
              <CatalystIcon
                score={row.catalyst?.score ?? null}
                reason={row.catalyst?.reason}
                type={row.catalyst?.type}
              />
            )}
          </span>
        ),
      },
      {
        title: 'Chg %',
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
    ],
    [],
  );

  const rows = payload?.rows ?? [];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #303030', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text strong style={{ color: '#e0e0e0' }}>
          Screener — {rows.length} rows
        </Text>
        <Space size="middle">
          <Tooltip title="Edit filters">
            <Button size="small" icon={<FilterOutlined />} onClick={() => setFiltersOpen(true)}>
              Filters
            </Button>
          </Tooltip>
          <Badge
            status={connected ? 'success' : 'default'}
            text={
              <Text type="secondary" style={{ fontSize: 12 }}>
                {connected ? 'live' : 'offline'}
                {payload?.polled_at && ` · ${new Date(payload.polled_at).toLocaleTimeString()}`}
              </Text>
            }
          />
        </Space>
      </div>
      <FiltersDialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        config={payload?.config ?? null}
      />
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
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
    </div>
  );
}

// Catalyst-tier icon — keeps the fire motif but varies by impact score.
//   ≥70  🔥  major catalyst (red flame)
//   40+  ⚡  watch / momentum-only
//   15+  🧊  weak headline
//   <15  —   nothing (we still show the underlying news icon elsewhere)
// `score` is `null` until the classifier has run for this article.
function CatalystIcon({
  score,
  reason,
  type,
}: {
  score: number | null;
  reason?: string;
  type?: string;
}) {
  if (score == null) return <span title="Catalyst score pending"> 🔥</span>;
  const tooltip = `${score} · ${type ?? ''}${reason ? ` — ${reason}` : ''}`.trim();
  if (score >= 70) return <span title={tooltip} style={{ filter: 'saturate(1.2)' }}> 🔥</span>;
  if (score >= 40) return <span title={tooltip}> ⚡</span>;
  if (score >= 15) return <span title={tooltip} style={{ opacity: 0.65 }}> 🧊</span>;
  return null;
}

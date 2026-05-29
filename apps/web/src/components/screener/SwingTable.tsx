// The Swing screener tab — multi-day setups (1–5 day holds). Sibling of
// the Momentum table inside ScreenerPanel; clicking a row drives the
// shared `useSelection()` so Quote Details / News Room / Charts all
// react identically to either screen. See docs/swing-screener-spec.md
// §6 for the column set and the scoring rules behind the score tier.

import { useMemo } from 'react';
import { Table, Typography, Tooltip, Button, Empty } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { CatalystInfo, SwingRow, SwingSetupFlags } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { CatalystBadge } from '../common/CatalystBadge';
import { ShelfBadge } from '../common/ShelfBadge';
import { fmtPct, fmtPrice, num } from '../../utils/format';

const { Text } = Typography;

interface Props {
  rows: SwingRow[];
  onOpenCatalyst: (ticker: string, catalyst: CatalystInfo | null) => void;
}

// Swing-score tier coloring — same bands as runner-score (≥75 red, 55+ orange,
// 40+ yellow, dim otherwise). Keeps the score color language consistent
// across Momentum / Ignition / Swing.
function scoreColor(s: number): string {
  if (s >= 75) return '#ff4d4f';
  if (s >= 55) return '#fa8c16';
  if (s >= 40) return '#fadb14';
  return '#8c8c8c';
}

export function SwingTable({ rows: allRows, onOpenCatalyst }: Props) {
  const { selected, setSelected } = useSelection();
  const { hidden, hide } = useHiddenTickers();

  const rows = useMemo(
    () => allRows.filter((r) => !hidden.has(r.ticker)),
    [allRows, hidden],
  );

  const columns: ColumnsType<SwingRow> = useMemo(
    () => [
      {
        title: '',
        key: 'links',
        width: 76,
        render: (_v, row) => <TickerLinks ticker={row.ticker} finvizUrl={row.finviz_url} />,
      },
      {
        title: 'Ticker',
        key: 'ticker',
        width: 140,
        render: (_v, row) => (
          <span>
            <TickerLink
              ticker={row.ticker}
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
                onOpen={() => onOpenCatalyst(row.ticker, row.catalyst ?? null)}
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
        title: 'Score',
        dataIndex: 'swing_score',
        key: 'swing_score',
        width: 70,
        align: 'right',
        render: (s: number, row) => {
          const b = row.score_breakdown;
          const tip = `trend ${b.trend} · strength ${b.strength} · setup ${b.setup} · volume ${b.volume} · catalyst ${b.catalyst} · shelf ${b.shelf}`;
          return (
            <Tooltip title={tip}>
              <span style={{ color: scoreColor(s), fontWeight: 700, fontSize: 13 }}>
                {Math.round(s)}
              </span>
            </Tooltip>
          );
        },
        sorter: (a, b) => a.swing_score - b.swing_score,
        defaultSortOrder: 'descend',
      },
      {
        title: 'Setup',
        key: 'setup',
        width: 100,
        render: (_v, row) => <SetupFlagStrip flags={row.setup_flags} />,
      },
      {
        title: 'Price',
        dataIndex: 'price',
        key: 'price',
        width: 70,
        align: 'right',
        render: fmtPrice,
      },
      {
        title: 'Chg %',
        dataIndex: 'change_pct',
        key: 'change_pct',
        width: 70,
        align: 'right',
        render: (raw) => {
          const v = num(raw);
          return (
            <Text style={{ color: (v ?? 0) >= 0 ? '#52c41a' : '#ff4d4f' }}>{fmtPct(raw)}</Text>
          );
        },
        sorter: (a, b) => (num(a.change_pct) ?? 0) - (num(b.change_pct) ?? 0),
      },
      {
        title: 'vs 52WH',
        key: 'dist_52w',
        width: 78,
        align: 'right',
        render: (_v, row) => {
          const d = row.daily_context.dist_52w_high_pct;
          const h = row.daily_context.high_52w;
          if (d == null) return <Text type="secondary">—</Text>;
          // Near the highs is the goal — color tiers match the strengthScore
          // bands in swing-score.ts so the eye and the score agree.
          const color = d >= -5 ? '#52c41a' : d >= -15 ? '#faad14' : '#8c8c8c';
          const txt = `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
          return (
            <Tooltip title={h != null ? `52w high $${h.toFixed(2)}` : undefined}>
              <Text style={{ color }}>{txt}</Text>
            </Tooltip>
          );
        },
        sorter: (a, b) =>
          (a.daily_context.dist_52w_high_pct ?? -Infinity) -
          (b.daily_context.dist_52w_high_pct ?? -Infinity),
      },
      {
        title: 'vs 20SMA',
        key: 'vs_sma20',
        width: 80,
        align: 'right',
        render: (_v, row) => {
          const s = row.daily_context.sma_20;
          const p = row.price;
          if (s == null || p == null || s <= 0) return <Text type="secondary">—</Text>;
          const pct = ((p - s) / s) * 100;
          const color = pct >= 5 ? '#52c41a' : pct <= -5 ? '#ff4d4f' : '#bfbfbf';
          return (
            <Tooltip title={`20-SMA $${s.toFixed(2)}`}>
              <Text style={{ color }}>{`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}</Text>
            </Tooltip>
          );
        },
      },
      {
        title: 'Vol×Avg',
        key: 'vol_ratio',
        width: 78,
        align: 'right',
        render: (_v, row) => {
          const v = row.volume;
          const avg = row.daily_context.avg_volume_20;
          if (v == null || avg == null || avg <= 0) return <Text type="secondary">—</Text>;
          const ratio = v / avg;
          // Same bands as the volume confirmation component of swing-score.
          const color = ratio >= 2.5 ? '#52c41a' : ratio >= 1.5 ? '#faad14' : '#bfbfbf';
          return (
            <Tooltip title={`20-day avg ${formatBigVolume(avg)}`}>
              <Text style={{ color }}>{ratio.toFixed(1)}×</Text>
            </Tooltip>
          );
        },
        sorter: (a, b) => {
          const ra = a.volume && a.daily_context.avg_volume_20 ? a.volume / a.daily_context.avg_volume_20 : 0;
          const rb = b.volume && b.daily_context.avg_volume_20 ? b.volume / b.daily_context.avg_volume_20 : 0;
          return ra - rb;
        },
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
              onClick={(e) => {
                e.stopPropagation();
                hide(row.ticker);
              }}
              style={{ width: 22, height: 22, padding: 0 }}
            />
          </Tooltip>
        ),
      },
    ],
    [setSelected, hide, onOpenCatalyst],
  );

  // Empty-state for cold start (the first Swing scan hasn't completed yet).
  if (allRows.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Text type="secondary" style={{ fontSize: 12, maxWidth: 360, display: 'inline-block' }}>
              Swing scan hasn't produced rows yet. First scan runs at startup and every ~20 min after, plus a forced post-close refresh at 16:30 ET. Daily-bar backfill is a one-time bootstrap — see <code>docs/swing-screener-spec.md</code>.
            </Text>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <Table<SwingRow>
        rowKey="ticker"
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={false}
        sticky
        onRow={(r) => ({
          onClick: () => setSelected(r.ticker),
          style: {
            cursor: 'pointer',
            background: r.ticker === selected ? '#15395b' : undefined,
          },
        })}
      />
    </div>
  );
}

// Compact icon strip for the three setup signals — base · breakout · close
// strength. Each badge only renders when its flag is true; an absent badge
// is a "no" signal. The 10-day breakout shows as ↑10 (the alert trigger),
// the smaller 5-day shows as ↑5 in a warning color.
function SetupFlagStrip({ flags }: { flags: SwingSetupFlags }) {
  type Item = { color: string; label: string; title: string };
  const items: Item[] = [];
  if (flags.in_base) {
    items.push({ color: '#52c41a', label: 'B', title: 'In tight base (5-day close range ≤ 10%)' });
  }
  if (flags.broke_out) {
    items.push({ color: '#52c41a', label: '↑10', title: 'Broke out — close above 10-day prior high' });
  } else if (flags.broke_out_5d) {
    items.push({ color: '#faad14', label: '↑5', title: 'Broke 5-day prior high (smaller signal)' });
  }
  if (flags.close_in_top_q) {
    items.push({ color: '#52c41a', label: 'C', title: "Close in top 25% of today's range" });
  }

  if (items.length === 0) {
    return <Text type="secondary" style={{ fontSize: 10 }}>—</Text>;
  }

  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {items.map((it, i) => (
        <Tooltip key={i} title={it.title}>
          <span
            style={{
              display: 'inline-block',
              color: it.color,
              border: `1px solid ${it.color}`,
              borderRadius: 3,
              padding: '0 4px',
              fontSize: 10,
              fontWeight: 600,
              lineHeight: '14px',
            }}
          >
            {it.label}
          </span>
        </Tooltip>
      ))}
    </span>
  );
}

// Volume formatter — 20-day-avg numbers are large (millions). The Momentum
// table's fmtVolume rounds to whole shares; here we want a 1-decimal "M"
// suffix in the tooltip ("20-day avg 4.2M").
function formatBigVolume(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
}

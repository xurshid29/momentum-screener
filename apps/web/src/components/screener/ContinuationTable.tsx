// The Continuation tab — tickers that have shown up in Ignition on 2+
// distinct ET trading days inside the last 5. The "same name keeps showing
// up" pattern is exactly the multi-day-swing setup playbook from CODX /
// SBFM / FATN — see docs/web-dashboard.md "Continuation tab" for the
// strategy framing.
//
// The table is purely derivative of `payload.continuation` (no separate
// fetch). The live-presence column cross-references the current Momentum,
// Ignition, and Swing payloads so you can see at a glance which other tabs
// are currently flagging the same ticker.

import { useMemo } from 'react';
import { Table, Typography, Tooltip, Button, Empty } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { CatalystInfo, ContinuationRow, CyclePayload, EnrichedRow } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { CatalystBadge } from '../common/CatalystBadge';
import { ShelfBadge } from '../common/ShelfBadge';

const { Text } = Typography;

interface Props {
  rows: ContinuationRow[];
  payload: CyclePayload | null;
  onOpenCatalyst: (ticker: string, catalyst: CatalystInfo | null) => void;
}

// Same banding as the other tables' scoreColor — keeps the score language
// consistent across the four screens.
function scoreColor(s: number | null | undefined): string {
  if (s == null) return '#8c8c8c';
  if (s >= 75) return '#ff4d4f';
  if (s >= 55) return '#fa8c16';
  if (s >= 40) return '#fadb14';
  return '#8c8c8c';
}

// MM-DD form for the compact first→last column. Avoids visual noise from the
// 4-digit year when all rows are in the same ~5-day window.
function fmtMD(iso: string): string {
  return iso.slice(5);
}

export function ContinuationTable({ rows: allRows, payload, onOpenCatalyst }: Props) {
  const { selected, setSelected } = useSelection();
  const { hidden, hide } = useHiddenTickers();

  const rows = useMemo(
    () => allRows.filter((r) => !hidden.has(r.ticker)),
    [allRows, hidden],
  );

  // Per-cycle indices for fast cross-screen presence checks.
  const liveSets = useMemo(() => {
    const mom = new Set<string>();
    const ig = new Set<string>();
    const sw = new Set<string>();
    if (payload) {
      for (const r of payload.rows) mom.add(r.ticker);
      for (const r of payload.ignition) ig.add(r.ticker);
      for (const r of payload.swing) sw.add(r.ticker);
    }
    return { mom, ig, sw };
  }, [payload]);

  // ContinuationRow is bare metadata (no shelf / catalyst / news_url fields
  // of its own) — to render the same badges as the other tabs we look the
  // ticker up in the live payloads. Built once per cycle. Last-write-wins
  // across the three screens is fine: the catalyst object is shared state.
  const liveLookup = useMemo(() => {
    const m = new Map<string, EnrichedRow>();
    if (payload) {
      // Order matters only in that later writes win on duplicate tickers;
      // since all three screens read from the same enrichedByTicker map on
      // the backend, the row object is the same regardless.
      for (const r of payload.rows) m.set(r.ticker, r);
      for (const r of payload.ignition) if (!m.has(r.ticker)) m.set(r.ticker, r);
      for (const r of payload.swing) if (!m.has(r.ticker)) m.set(r.ticker, r);
    }
    return m;
  }, [payload]);

  const columns: ColumnsType<ContinuationRow> = useMemo(
    () => [
      {
        title: '',
        key: 'links',
        width: 76,
        render: (_v, row) => {
          const live = liveLookup.get(row.ticker);
          return <TickerLinks ticker={row.ticker} finvizUrl={live?.finviz_url} />;
        },
      },
      {
        title: 'Ticker',
        key: 'ticker',
        width: 140,
        render: (_v, row) => {
          const live = liveLookup.get(row.ticker);
          const shelf = live?.shelf ?? null;
          return (
            <span>
              <TickerLink
                ticker={row.ticker}
                onSelect={setSelected}
                stopPropagation
                style={{ color: '#fff', fontWeight: 600 }}
              />
              {live?.is_fresh_news && (
                <span title="Fresh news this cycle"> 🚨</span>
              )}
              {live?.has_today_news && (
                <CatalystBadge
                  score={live.catalyst?.score ?? null}
                  reason={live.catalyst?.reason}
                  type={live.catalyst?.type}
                  onOpen={() => onOpenCatalyst(row.ticker, live.catalyst ?? null)}
                />
              )}
              {shelf && (
                <span style={{ marginLeft: 6 }}>
                  <ShelfBadge shelf={shelf} />
                </span>
              )}
            </span>
          );
        },
      },
      {
        title: 'Days',
        dataIndex: 'days_seen',
        key: 'days_seen',
        width: 64,
        align: 'right',
        // Earlier-stage setups (fewer days seen) are the actionable entries —
        // 5–6-day tickers tend to be the already-extended runners. Sort ASC
        // by default; the user can flip via the sorter for the established
        // setups view.
        render: (d: number) => {
          const color = d >= 4 ? '#52c41a' : d >= 3 ? '#faad14' : '#bfbfbf';
          return <span style={{ color, fontWeight: 700, fontSize: 13 }}>{d}</span>;
        },
        sorter: (a, b) => a.days_seen - b.days_seen,
        defaultSortOrder: 'ascend',
      },
      {
        title: 'Window',
        key: 'window',
        width: 110,
        render: (_v, row) => (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {fmtMD(row.first_seen)} → {fmtMD(row.last_seen)}
          </Text>
        ),
      },
      {
        title: 'Score Day 1 → Today',
        key: 'score_trend',
        width: 150,
        align: 'center',
        render: (_v, row) => {
          // Climbing = conviction growing; flat or falling = move is rolling
          // over. Today's score is null when the ticker dropped off today's
          // Ignition list — render that as "—" rather than 0 to distinguish
          // "not in today's list" from "in list with low score".
          const arrow =
            row.today_peak == null
              ? '·'
              : row.today_peak > row.first_day_peak
                ? '↑'
                : row.today_peak < row.first_day_peak
                  ? '↓'
                  : '→';
          const tip = `Window peak: ${Math.round(row.peak_window)}`;
          return (
            <Tooltip title={tip}>
              <span style={{ fontSize: 12 }}>
                <span style={{ color: scoreColor(row.first_day_peak), fontWeight: 600 }}>
                  {Math.round(row.first_day_peak)}
                </span>
                <span style={{ color: '#8c8c8c', margin: '0 6px' }}>{arrow}</span>
                <span style={{ color: scoreColor(row.today_peak), fontWeight: 700 }}>
                  {row.today_peak == null ? '—' : Math.round(row.today_peak)}
                </span>
              </span>
            </Tooltip>
          );
        },
        sorter: (a, b) => (a.today_peak ?? -1) - (b.today_peak ?? -1),
      },
      {
        title: 'Price range',
        key: 'price_range',
        width: 130,
        align: 'right',
        render: (_v, row) => {
          const lift = row.min_price > 0 ? ((row.max_price - row.min_price) / row.min_price) * 100 : null;
          const liftColor = lift == null
            ? '#bfbfbf'
            : lift >= 100 ? '#52c41a' : lift >= 50 ? '#faad14' : '#bfbfbf';
          return (
            <span style={{ fontSize: 12 }}>
              <Text type="secondary">${row.min_price.toFixed(2)} → ${row.max_price.toFixed(2)}</Text>
              {lift != null && (
                <span style={{ color: liftColor, marginLeft: 6, fontWeight: 600 }}>
                  +{lift.toFixed(0)}%
                </span>
              )}
            </span>
          );
        },
        sorter: (a, b) => {
          const la = a.min_price > 0 ? (a.max_price - a.min_price) / a.min_price : 0;
          const lb = b.min_price > 0 ? (b.max_price - b.min_price) / b.min_price : 0;
          return la - lb;
        },
      },
      {
        title: 'Live in',
        key: 'live_in',
        width: 90,
        align: 'center',
        render: (_v, row) => (
          <LiveBadgeStrip
            mom={liveSets.mom.has(row.ticker)}
            ig={liveSets.ig.has(row.ticker)}
            sw={liveSets.sw.has(row.ticker)}
          />
        ),
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
    [setSelected, hide, liveSets, liveLookup, onOpenCatalyst],
  );

  if (allRows.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Text type="secondary" style={{ fontSize: 12, maxWidth: 360, display: 'inline-block' }}>
              No continuation candidates yet. Needs ≥ 2 distinct ET days of Ignition history per ticker
              within the last 5 days; the cache refreshes every ~10 min.
            </Text>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <Table<ContinuationRow>
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

// Compact M/I/S indicator strip — one letter per screen currently flagging
// the ticker. Lit = in that list right now; dim = not. Lets you eyeball
// "is this a fresh dual-signal setup?" at a glance.
function LiveBadgeStrip({ mom, ig, sw }: { mom: boolean; ig: boolean; sw: boolean }) {
  const items: Array<{ label: string; on: boolean; tip: string; color: string }> = [
    { label: 'M', on: mom, tip: 'In current Momentum screen', color: '#52c41a' },
    { label: 'I', on: ig, tip: 'In current Ignition list', color: '#fa8c16' },
    { label: 'S', on: sw, tip: 'In current Swing list', color: '#1890ff' },
  ];
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {items.map((it) => (
        <Tooltip key={it.label} title={it.tip}>
          <span
            style={{
              display: 'inline-block',
              border: `1px solid ${it.on ? it.color : '#3a3a3a'}`,
              color: it.on ? it.color : '#5a5a5a',
              borderRadius: 3,
              padding: '0 4px',
              fontSize: 10,
              fontWeight: 600,
              lineHeight: '14px',
              minWidth: 16,
              textAlign: 'center',
            }}
          >
            {it.label}
          </span>
        </Tooltip>
      ))}
    </span>
  );
}

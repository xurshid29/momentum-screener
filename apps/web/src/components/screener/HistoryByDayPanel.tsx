// History-by-day view — pick an ET trading date and a screen (Ignition or
// Momentum), see every ticker that appeared on that day grouped by session
// (PM / Regular / AH / closed). Per-(ticker, session) row with: first→last
// ET time, peak runner-score (Ignition) or Status (Momentum), chg range,
// price range, ticks. The day's most-impactful catalyst classification rides
// as a clickable 🔥/✨ badge next to the ticker.
//
// Static query (no SSE) — refetches on date or screen change. Same selection
// integration as the live tables: click a row → useSelection() drives the
// Quote Details / News Room / Charts panels.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { Table, Tag, Typography, DatePicker, Segmented, Empty, Spin } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type {
  CatalystInfo,
  CyclePayload,
  HistoryByDayRow,
  HistoryByDayScreen,
  RowStatus,
  TradingSession,
} from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { screenerApi } from '../../api/screener';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { CatalystBadge } from '../common/CatalystBadge';
import { ShelfBadge } from '../common/ShelfBadge';
import { fmtPct, fmtPrice, num } from '../../utils/format';

const { Text } = Typography;

interface Props {
  payload: CyclePayload | null;
  onOpenCatalyst: (ticker: string, catalyst: CatalystInfo | null) => void;
}

const SESSION_COLOR: Record<TradingSession, string> = {
  premarket: 'blue',
  regular: 'green',
  afterhours: 'orange',
  closed: 'default',
};
const SESSION_SHORT: Record<TradingSession, string> = {
  premarket: 'PM',
  regular: 'REG',
  afterhours: 'AH',
  closed: '—',
};

const STATUS_COLOR: Record<NonNullable<RowStatus>, string> = {
  NEW: 'blue',
  ACC: 'orange',
  UP: 'green',
  NEWS: 'purple',
};

function scoreColor(s: number | null | undefined): string {
  if (s == null) return '#8c8c8c';
  if (s >= 75) return '#ff4d4f';
  if (s >= 55) return '#fa8c16';
  if (s >= 40) return '#fadb14';
  return '#8c8c8c';
}

function todayEtDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function fmtEtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function HistoryByDayPanel({ payload, onOpenCatalyst }: Props) {
  const { selected, setSelected } = useSelection();
  const [date, setDate] = useState<string>(todayEtDate());
  const [screen, setScreen] = useState<HistoryByDayScreen>('ignition');

  const { data, isFetching } = useQuery({
    queryKey: ['history-by-day', date, screen],
    queryFn: () => screenerApi.historyByDay(date, screen),
    staleTime: 60_000,
  });

  // Shelf badges come off whichever live payload currently knows the ticker.
  // Catalyst comes off the row itself (the day's strongest classification).
  const shelfLookup = useMemo(() => {
    const m = new Map<string, NonNullable<CyclePayload['rows'][number]['shelf']>>();
    if (payload) {
      for (const r of payload.rows) if (r.shelf) m.set(r.ticker, r.shelf);
      for (const r of payload.ignition) if (r.shelf) m.set(r.ticker, r.shelf);
      for (const r of payload.swing) if (r.shelf) m.set(r.ticker, r.shelf);
    }
    return m;
  }, [payload]);

  const finvizUrlLookup = useMemo(() => {
    const m = new Map<string, string>();
    if (payload) {
      for (const r of payload.rows) m.set(r.ticker, r.finviz_url);
      for (const r of payload.ignition) if (!m.has(r.ticker)) m.set(r.ticker, r.finviz_url);
      for (const r of payload.swing) if (!m.has(r.ticker)) m.set(r.ticker, r.finviz_url);
    }
    return m;
  }, [payload]);

  const columns: ColumnsType<HistoryByDayRow> = useMemo(() => {
    const base: ColumnsType<HistoryByDayRow> = [
      {
        title: '',
        key: 'links',
        width: 76,
        render: (_v, row) => (
          <TickerLinks ticker={row.ticker} finvizUrl={finvizUrlLookup.get(row.ticker)} />
        ),
      },
      {
        title: '',
        dataIndex: 'session',
        key: 'session',
        width: 60,
        render: (s: TradingSession) => (
          <Tag color={SESSION_COLOR[s]} style={{ margin: 0, fontSize: 10 }}>{SESSION_SHORT[s]}</Tag>
        ),
        sorter: (a, b) => {
          const ord: Record<TradingSession, number> = { premarket: 1, regular: 2, afterhours: 3, closed: 4 };
          return ord[a.session] - ord[b.session];
        },
      },
      {
        title: 'Ticker',
        key: 'ticker',
        width: 140,
        render: (_v, row) => {
          // Synthesize a partial CatalystInfo for the modal click — same
          // shape as on the Continuation rows.
          const hasCatalyst = row.news_title != null;
          const synthesized: CatalystInfo | null =
            row.catalyst_score != null && row.catalyst_direction && row.catalyst_urgency && row.catalyst_type
              ? {
                  score: row.catalyst_score,
                  direction: row.catalyst_direction as CatalystInfo['direction'],
                  urgency: row.catalyst_urgency as CatalystInfo['urgency'],
                  type: row.catalyst_type,
                  reason: '',
                  risk_flags: [],
                  classifier: 'rules',
                }
              : null;
          const shelf = shelfLookup.get(row.ticker) ?? null;
          return (
            <span>
              <TickerLink
                ticker={row.ticker}
                onSelect={setSelected}
                stopPropagation
                style={{ color: '#fff', fontWeight: 600 }}
              />
              {hasCatalyst && (
                <CatalystBadge
                  score={row.catalyst_score}
                  type={row.catalyst_type ?? undefined}
                  onOpen={() => onOpenCatalyst(row.ticker, synthesized)}
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
        title: 'First → Last (ET)',
        key: 'window',
        width: 140,
        render: (_v, row) => (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {fmtEtTime(row.first_at)} → {fmtEtTime(row.last_at)}
          </Text>
        ),
      },
    ];

    if (screen === 'ignition') {
      base.push({
        title: 'Peak score',
        dataIndex: 'peak_score',
        key: 'peak_score',
        width: 80,
        align: 'right',
        render: (s: number | null) =>
          s == null ? <Text type="secondary">—</Text> : (
            <span style={{ color: scoreColor(s), fontWeight: 700, fontSize: 13 }}>
              {Math.round(s)}
            </span>
          ),
        sorter: (a, b) => (a.peak_score ?? -1) - (b.peak_score ?? -1),
      });
    } else {
      base.push({
        title: 'Status',
        dataIndex: 'status',
        key: 'status',
        width: 80,
        render: (s: RowStatus) =>
          s ? <Tag color={STATUS_COLOR[s]} style={{ margin: 0, fontSize: 10 }}>{s}</Tag> : <Text type="secondary">—</Text>,
      });
    }

    base.push(
      {
        title: 'Chg range',
        key: 'chg_range',
        width: 130,
        align: 'right',
        render: (_v, row) => {
          const mn = num(row.min_chg);
          const mx = num(row.max_chg);
          if (mn == null && mx == null) return <Text type="secondary">—</Text>;
          return (
            <span style={{ fontSize: 12 }}>
              <Text style={{ color: (mn ?? 0) < 0 ? '#ff4d4f' : '#bfbfbf' }}>{fmtPct(mn)}</Text>
              <Text type="secondary" style={{ margin: '0 4px' }}>→</Text>
              <Text style={{ color: (mx ?? 0) >= 0 ? '#52c41a' : '#bfbfbf' }}>{fmtPct(mx)}</Text>
            </span>
          );
        },
        sorter: (a, b) => (num(a.max_chg) ?? 0) - (num(b.max_chg) ?? 0),
      },
      {
        title: 'Price range',
        key: 'price_range',
        width: 150,
        align: 'right',
        render: (_v, row) => {
          if (row.min_price == null || row.max_price == null) return <Text type="secondary">—</Text>;
          const lift = row.min_price > 0 ? ((row.max_price - row.min_price) / row.min_price) * 100 : null;
          const liftColor = lift == null ? '#bfbfbf' : lift >= 50 ? '#52c41a' : lift >= 20 ? '#faad14' : '#bfbfbf';
          return (
            <span style={{ fontSize: 12 }}>
              <Text type="secondary">{fmtPrice(row.min_price)} → {fmtPrice(row.max_price)}</Text>
              {lift != null && (
                <span style={{ color: liftColor, marginLeft: 6, fontWeight: 600 }}>
                  +{lift.toFixed(0)}%
                </span>
              )}
            </span>
          );
        },
      },
      {
        title: 'Ticks',
        dataIndex: 'ticks',
        key: 'ticks',
        width: 60,
        align: 'right',
        render: (n: number) => <Text type="secondary" style={{ fontSize: 11 }}>{n}</Text>,
        sorter: (a, b) => a.ticks - b.ticks,
      },
    );

    return base;
  }, [screen, finvizUrlLookup, shelfLookup, onOpenCatalyst, setSelected]);

  const rows = data ?? [];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid #303030' }}>
        <DatePicker
          value={dayjs(date)}
          onChange={(d: Dayjs | null) => d && setDate(d.format('YYYY-MM-DD'))}
          format="YYYY-MM-DD"
          allowClear={false}
          size="small"
        />
        <Segmented
          size="small"
          options={[
            { label: 'Ignition', value: 'ignition' },
            { label: 'Momentum', value: 'momentum' },
          ]}
          value={screen}
          onChange={(v) => setScreen(v as HistoryByDayScreen)}
        />
        <Text type="secondary" style={{ fontSize: 11 }}>
          {isFetching ? <Spin size="small" /> : `${rows.length} row${rows.length === 1 ? '' : 's'}`}
        </Text>
      </div>
      {rows.length === 0 && !isFetching ? (
        <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Text type="secondary" style={{ fontSize: 12 }}>
                Nothing in <code>{screen}_results</code> for {date}. Either no data persisted or the date is outside our retention window.
              </Text>
            }
          />
        </div>
      ) : (
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
          <Table<HistoryByDayRow>
            rowKey={(r) => `${r.ticker}|${r.session}`}
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
      )}
    </div>
  );
}

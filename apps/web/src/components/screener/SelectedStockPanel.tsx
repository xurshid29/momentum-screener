import { Fragment, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Typography, Empty, Tag, Tabs, Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useSelection } from '../../context/SelectionContext';
import { newsApi } from '../../api/news';
import { screenerApi } from '../../api/screener';
import { ShelfBadge } from '../common/ShelfBadge';
import { TickerLink } from '../common/TickerLink';
import { WatchlistStar } from '../common/WatchlistStar';
import { TickerNewsList } from '../news/TickerNewsList';
import type {
  CyclePayload,
  EnrichedRow,
  HistoryRow,
  IgnitionHistoryRow,
  NewsArticle,
  RowStatus,
  ShelfLevel,
  TradingSession,
} from '../../api/types';
import { fmtPct, fmtPrice, fmtVolume, fmtFloat, fmtMcap, fmtRelVol, fmtBigPct, num } from '../../utils/format';

const { Text } = Typography;

// ET-calendar-day lookback for the per-ticker news list. 4 = today + the
// previous 3 days, so a Friday catalyst is still visible the next Monday —
// the swing/continuation timeframe where older news still moves the stock.
const TICKER_NEWS_DAYS = 4;

const STATUS_COLOR: Record<NonNullable<RowStatus>, string> = {
  NEW: 'blue',
  ACC: 'orange',
  UP: 'green',
  NEWS: 'purple',
};

// Compact session tags for the Ignition history table.
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

// Runner-score color tiers — same bands as IgnitionSidebar.scoreColor.
function scoreColor(s: number): string {
  if (s >= 75) return '#ff4d4f';
  if (s >= 55) return '#fa8c16';
  if (s >= 40) return '#fadb14';
  return '#8c8c8c';
}

interface SelectedStockPanelProps {
  payload: CyclePayload | null;
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour12: false });
}

// "(N in Tsec)" — counts how many cycles in a row (most recent N) the ticker
// appeared in, paired with the time elapsed across that streak.
function streakLabel(rows: HistoryRow[], idx: number): string | null {
  if (idx === rows.length - 1) return null;
  let count = 1;
  let endTs = new Date(rows[idx].polled_at).getTime();
  let startTs = endTs;
  for (let i = idx + 1; i < rows.length; i++) {
    const t = new Date(rows[i].polled_at).getTime();
    if (endTs - t > 60_000) break;
    count++;
    startTs = t;
    endTs = new Date(rows[idx].polled_at).getTime();
  }
  if (count <= 1) return null;
  const sec = Math.max(1, Math.round((endTs - startTs) / 1000));
  return `${count} in ${sec}s`;
}

export function SelectedStockPanel({ payload }: SelectedStockPanelProps) {
  const { selected } = useSelection();

  const liveRow: EnrichedRow | null = useMemo(
    () => (selected && payload ? payload.rows.find((r) => r.ticker === selected) ?? null : null),
    [selected, payload],
  );

  // Per-ticker news. Shown in the Details tab as the catalyst list. Uses a
  // multi-day lookback (not today-only) so the swing / continuation context —
  // where a 2–3-day-old catalyst still drives the move — surfaces here too.
  const { data: news } = useQuery({
    queryKey: ['news', selected, TICKER_NEWS_DAYS],
    queryFn: () =>
      selected ? newsApi.forTicker(selected, 30, TICKER_NEWS_DAYS) : Promise.resolve([] as NewsArticle[]),
    enabled: !!selected,
    staleTime: 10_000,
  });

  // History — also gives us a fallback metadata source if the ticker dropped
  // out of the live screener (the most recent recorded row has the company info).
  const { data: history } = useQuery({
    queryKey: ['history', selected, payload?.cycle_id],
    queryFn: () => (selected ? screenerApi.history(selected, 100) : Promise.resolve([] as HistoryRow[])),
    enabled: !!selected,
  });

  // Ignition history — per-cycle runner-score evolution for the selected
  // ticker. Read from ignition_results, so it covers sub-$1 volume-led names
  // that never met the Momentum filter (and thus aren't in `history`).
  const { data: ignitionHistory } = useQuery({
    queryKey: ['ignition-history', selected, payload?.cycle_id],
    queryFn: () =>
      selected ? screenerApi.ignitionHistory(selected, 200) : Promise.resolve([] as IgnitionHistoryRow[]),
    enabled: !!selected,
  });

  // Pick the freshest source of metadata: live row first, then most recent history.
  const meta = liveRow ?? (history && history[0] ? (history[0] as unknown as EnrichedRow) : null);

  const historyColumns: ColumnsType<HistoryRow> = useMemo(
    () => [
      {
        title: 'Time',
        dataIndex: 'polled_at',
        key: 'polled_at',
        width: 120,
        render: (iso: string, _row, idx) => {
          const streak = history ? streakLabel(history, idx) : null;
          return (
            <div style={{ lineHeight: 1.2 }}>
              <div>{fmtTime(iso)}</div>
              {streak && <Text type="secondary" style={{ fontSize: 10 }}>({streak})</Text>}
            </div>
          );
        },
      },
      {
        title: '',
        dataIndex: 'status',
        key: 'status',
        width: 50,
        render: (s: RowStatus) =>
          s ? <Tag color={STATUS_COLOR[s]} style={{ margin: 0, fontSize: 10 }}>{s}</Tag> : null,
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
        render: (raw, row) => {
          const v = num(raw);
          const ad = num(row.accel_delta);
          return (
            <Tooltip title={ad != null ? `Δ ${ad > 0 ? '+' : ''}${ad.toFixed(2)}%` : null}>
              <Text style={{ color: (v ?? 0) >= 0 ? '#52c41a' : '#ff4d4f' }}>{fmtPct(raw)}</Text>
            </Tooltip>
          );
        },
      },
      { title: 'Volume', dataIndex: 'volume', key: 'volume', width: 80, align: 'right', render: fmtVolume },
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
    ],
    [history],
  );

  const ignitionColumns: ColumnsType<IgnitionHistoryRow> = useMemo(
    () => [
      {
        title: 'Time',
        dataIndex: 'polled_at',
        key: 'polled_at',
        width: 80,
        render: (iso: string) => <span>{fmtTime(iso)}</span>,
      },
      {
        title: '',
        dataIndex: 'session',
        key: 'session',
        width: 50,
        render: (s: TradingSession) => (
          <Tag color={SESSION_COLOR[s]} style={{ margin: 0, fontSize: 10 }}>{SESSION_SHORT[s]}</Tag>
        ),
      },
      {
        title: 'Score',
        dataIndex: 'runner_score',
        key: 'runner_score',
        width: 64,
        align: 'right',
        render: (s: number, row) => {
          const b = row.score_breakdown;
          const tooltip = `float ${b.float} · volume ${b.volume} · catalyst ${b.catalyst} · earliness ${b.earliness} · halt ${b.halt} · shelf ${b.shelf}`;
          return (
            <Tooltip title={tooltip}>
              <span style={{ color: scoreColor(s), fontWeight: 700 }}>{Math.round(s)}</span>
            </Tooltip>
          );
        },
      },
      {
        title: 'Chg %',
        dataIndex: 'change_pct',
        key: 'change_pct',
        width: 70,
        align: 'right',
        render: (raw) => {
          const v = num(raw);
          return <Text style={{ color: (v ?? 0) >= 0 ? '#52c41a' : '#ff4d4f' }}>{fmtPct(raw)}</Text>;
        },
      },
      { title: 'Price', dataIndex: 'price', key: 'price', width: 64, align: 'right', render: fmtPrice },
      {
        title: 'RV 5m',
        dataIndex: 'rel_vol_5min',
        key: 'rel_vol_5min',
        width: 70,
        align: 'right',
        render: fmtBigPct,
      },
      {
        // catalyst_score is an integer 0–100 (rule classifier or LLM-refined);
        // news_source is the originating feed. Both nullable.
        title: 'Cat',
        key: 'catalyst',
        width: 56,
        align: 'right',
        render: (_v, row) =>
          row.catalyst_score == null && row.news_source == null
            ? <Text type="secondary">—</Text>
            : (
                <Tooltip title={row.news_source ?? ''}>
                  <span>{row.catalyst_score ?? '—'}</span>
                </Tooltip>
              ),
      },
      {
        title: 'Shelf',
        dataIndex: 'shelf_level',
        key: 'shelf_level',
        width: 50,
        align: 'center',
        render: (lvl: ShelfLevel | null) =>
          lvl ? <ShelfBadge shelf={{ level: lvl, latest_form: '', latest_filed_at: '', days_since: 0, forms: [] }} size={12} /> : null,
      },
    ],
    [],
  );

  if (!selected) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Text type="secondary">Click a ticker</Text>} />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #303030' }}>
        <Text strong style={{ color: '#e0e0e0', letterSpacing: 0.5 }}>Quote Details</Text>
      </div>
      <Tabs
        size="small"
        defaultActiveKey="details"
        className="tabs-fill-height"
        tabBarStyle={{ margin: 0, padding: '0 8px' }}
        items={[
          {
            key: 'details',
            label: 'Details',
            children: <DetailsTab ticker={selected} meta={meta} news={news ?? []} />,
          },
          {
            key: 'history',
            label: 'History',
            children: (
              <div style={{ height: '100%', overflow: 'auto' }}>
                <Table<HistoryRow>
                  rowKey="id"
                  size="small"
                  columns={historyColumns}
                  dataSource={history ?? []}
                  pagination={false}
                  sticky
                />
              </div>
            ),
          },
          {
            key: 'ignition',
            label: `Ignition${ignitionHistory && ignitionHistory.length ? ` (${ignitionHistory.length})` : ''}`,
            children: (
              <div style={{ height: '100%', overflow: 'auto' }}>
                <Table<IgnitionHistoryRow>
                  rowKey="id"
                  size="small"
                  columns={ignitionColumns}
                  dataSource={ignitionHistory ?? []}
                  pagination={false}
                  sticky
                  locale={{ emptyText: 'No ignition history for this ticker' }}
                />
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

interface DetailsTabProps {
  ticker: string;
  meta: EnrichedRow | null;
  news: NewsArticle[];
}

function DetailsTab({ ticker, meta, news }: DetailsTabProps) {
  const change = num(meta?.change_pct);
  const changeColor = (change ?? 0) >= 0 ? '#52c41a' : '#ff4d4f';
  const sub = [meta?.company, meta?.country, meta?.industry, meta?.sector].filter(Boolean).join('  ·  ');

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '10px 12px' }}>
      {/* Header — ticker + price + change */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <span style={{ alignSelf: 'center' }}>
          <WatchlistStar ticker={ticker} size={18} />
        </span>
        <TickerLink
          ticker={ticker}
          style={{ color: '#fff', fontSize: 22, fontWeight: 700, letterSpacing: 0.5 }}
        />
        <Text style={{ color: '#e6e6e6', fontSize: 18 }}>{fmtPrice(meta?.price)}</Text>
        <Text style={{ color: changeColor, fontSize: 14, fontWeight: 600 }}>
          {change != null && change >= 0 ? '+' : ''}{fmtPct(meta?.change_pct)}
        </Text>
        <span style={{ display: 'inline-flex', gap: 4, alignSelf: 'center' }}>
          <a
            href={`https://elite.finviz.com/quote?t=${encodeURIComponent(ticker)}&ty=c&p=h&b=1`}
            target="_blank"
            rel="noreferrer"
            className="screener-link-btn"
          >
            <img src="/finviz-icon.png" alt="Finviz" />
          </a>
          <a
            href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(ticker)}`}
            target="_blank"
            rel="noreferrer"
            className="screener-link-btn"
          >
            <img src="/tradingview-icon.png" alt="TradingView" />
          </a>
        </span>
      </div>

      {sub && (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 20 }}>{sub}</Text>
      )}

      {/* 6 columns × 2 rows. Items listed top-to-bottom within each column,
          then left-to-right across columns. Shs Out intentionally omitted —
          Float carries the same trading signal. */}
      <StatsGrid
        items={[
          { label: 'Market Cap',    value: fmtMcap(meta?.mcap_m) },
          {
            label: 'Float',
            value: meta?.float_is_proxy ? (
              <Tooltip title="Shares outstanding (Finviz did not report a Float value)">
                <span>{fmtFloat(meta?.float_m)}<span style={{ color: '#888' }}>*</span></span>
              </Tooltip>
            ) : (
              fmtFloat(meta?.float_m)
            ),
          },
          { label: 'Volume',        value: fmtVolume(meta?.volume) },
          { label: 'Avg Vol',       value: fmtVolume(meta?.avg_volume) },
          { label: 'Short Float',   value: <Coloured color={colorShortFloat(num(meta?.short_float_pct))}>{fmtPct(meta?.short_float_pct)}</Coloured> },
          { label: 'Short Ratio',   value: fmtNumber(meta?.short_ratio, 2) },
          { label: 'RVol Day',      value: fmtRelVol(meta?.rel_volume) },
          { label: 'RVol 5m',       value: fmtBigPct(meta?.rel_vol_5min) },
          { label: 'Insider Own',   value: fmtPct(meta?.insider_own_pct) },
          { label: 'Insider Trans', value: <Coloured color={colorInsiderTrans(num(meta?.insider_trans_pct))}>{fmtPct(meta?.insider_trans_pct)}</Coloured> },
          { label: 'Inst Own',      value: fmtPct(meta?.inst_own_pct) },
          { label: 'Inst Trans',    value: <Coloured color={colorInstTrans(num(meta?.inst_trans_pct))}>{fmtPct(meta?.inst_trans_pct)}</Coloured> },
        ]}
      />

      {/* Recent news headlines (multi-day) — placed below stats so the
          price/structural numbers are immediately visible without scrolling. */}
      <div style={{ marginTop: 20 }}>
        <SectionTitle>Recent News</SectionTitle>
        <TickerNewsList news={news} />
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text
      strong
      style={{
        color: '#888',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        display: 'block',
        marginTop: 0,
        marginBottom: 6,
      }}
    >
      {children}
    </Text>
  );
}

function Coloured({ color, children }: { color: string | undefined; children: React.ReactNode }) {
  return <span style={{ color }}>{children}</span>;
}

function fmtNumber(n: number | string | null | undefined, digits = 2): string {
  const v = num(n);
  return v == null ? '—' : v.toFixed(digits);
}

// Color bands from CLAUDE.md "Short Float Risk Levels".
function colorShortFloat(v: number | null): string | undefined {
  if (v == null) return undefined;
  if (v >= 25) return '#ff4d4f';   // very high
  if (v >= 15) return '#fa8c16';   // high
  if (v >= 5)  return '#faad14';   // medium
  return undefined;                // low — default
}

// CLAUDE.md "Insider/Inst Activity":
// Insider Trans > 0% → very bullish, -3..0 minor, -3..-10 moderate red, <-10 strong red.
function colorInsiderTrans(v: number | null): string | undefined {
  if (v == null) return undefined;
  if (v > 0) return '#52c41a';
  if (v < -10) return '#ff4d4f';
  if (v < -3)  return '#fa8c16';
  return undefined;
}

// Inst Trans > +5% bullish, < -5% bearish, in-between neutral.
function colorInstTrans(v: number | null): string | undefined {
  if (v == null) return undefined;
  if (v > 5)  return '#52c41a';
  if (v < -5) return '#ff4d4f';
  return undefined;
}

interface StatsGridProps {
  items: { label: string; value: React.ReactNode }[];
}

function StatsGrid({ items }: StatsGridProps) {
  // 6 columns × 2 rows, column-major layout. Each "column" is a label+value
  // pair; pairs are separated by a fixed-width spacer so the gap between pairs
  // reads wider than the in-pair gap. A `1fr` filler trailing the last pair
  // absorbs leftover panel width.
  const COLUMNS = 6;
  const ROWS = 2;
  const trackParts: string[] = [];
  for (let i = 0; i < COLUMNS; i++) {
    trackParts.push('max-content', 'max-content');
    if (i < COLUMNS - 1) trackParts.push('28px');
  }
  trackParts.push('1fr');

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: trackParts.join(' '),
        columnGap: 12,
        rowGap: 6,
        alignItems: 'baseline',
        fontSize: 12,
      }}
    >
      {items.map((it, i) => {
        const colGroup = Math.floor(i / ROWS);
        const row = (i % ROWS) + 1;
        const labelCol = colGroup * 3 + 1;
        const valueCol = labelCol + 1;
        return (
          <Fragment key={i}>
            <span style={{ color: '#888', gridColumn: labelCol, gridRow: row }}>{it.label}</span>
            <span style={{ color: '#e0e0e0', gridColumn: valueCol, gridRow: row }}>{it.value}</span>
          </Fragment>
        );
      })}
    </div>
  );
}

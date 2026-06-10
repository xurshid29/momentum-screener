// The Continuation tab — names in the middle of a multi-day move. Seeded from
// either screen (Momentum ∪ Ignition) and forward-tracked via daily_bars, so a
// quiet day-2 grind that re-triggers no screen still counts (see
// services/continuation.ts). The "same name keeps advancing day after day"
// pattern is the multi-day-swing playbook from CODX / SBFM / FATN — see
// docs/web-dashboard.md "Continuation tab" for the strategy framing.
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
import { WatchlistStar } from '../common/WatchlistStar';
import { CatalystBadge } from '../common/CatalystBadge';
import { ShelfBadge } from '../common/ShelfBadge';
import { WarningBadge, useIsWarned } from '../common/WarningBadge';

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
  const isWarned = useIsWarned();

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
        width: 98,
        render: (_v, row) => {
          const live = liveLookup.get(row.ticker);
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <WatchlistStar ticker={row.ticker} />
              <TickerLinks ticker={row.ticker} finvizUrl={live?.finviz_url} />
            </span>
          );
        },
      },
      {
        title: 'Ticker',
        key: 'ticker',
        width: 140,
        render: (_v, row) => {
          const live = liveLookup.get(row.ticker);
          const shelf = live?.shelf ?? null;
          // News badge reads off the row's own 3-day-window catalyst data
          // (see services/continuation.ts) — covers catalysts that landed
          // yesterday or 2 days ago, which is the actionable timeframe for
          // a Continuation entry. The 🚨 stays driven by liveLookup since
          // it specifically means "this cycle", not "this window".
          const hasRecentNews = row.news_title != null;
          // Synthesize a CatalystInfo-shaped object for the modal so it can
          // open the same shared CatalystNewsModal with the right context.
          const synthesizedCatalyst: CatalystInfo | null =
            row.catalyst_score != null && row.catalyst_direction && row.catalyst_urgency && row.catalyst_type
              ? {
                  score: row.catalyst_score,
                  direction: row.catalyst_direction as CatalystInfo['direction'],
                  urgency: row.catalyst_urgency as CatalystInfo['urgency'],
                  type: row.catalyst_type,
                  reason: row.catalyst_reason ?? '',
                  risk_flags: [],
                  classifier: 'rules',
                }
              : null;
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
              {hasRecentNews && (
                <CatalystBadge
                  score={row.catalyst_score}
                  reason={row.catalyst_reason ?? undefined}
                  type={row.catalyst_type ?? undefined}
                  onOpen={() => onOpenCatalyst(row.ticker, synthesizedCatalyst)}
                />
              )}
              {shelf && (
                <span style={{ marginLeft: 6 }}>
                  <ShelfBadge shelf={shelf} />
                </span>
              )}
              <WarningBadge ticker={row.ticker} />
            </span>
          );
        },
      },
      {
        title: 'Run',
        dataIndex: 'days_in_run',
        key: 'days_in_run',
        width: 78,
        align: 'right',
        // days_in_run = distinct active days (screen OR a real daily-bar move)
        // from the trigger onward. Earlier-stage setups (fewer days) are the
        // actionable entries — 5–6-day rows tend to be already extended. Sort
        // ASC by default. Subtext shows how many of those days actually hit a
        // screen; a gap means the daily bar carried the move the screens missed.
        render: (_v, row) => {
          const d = row.days_in_run;
          const color = d >= 4 ? '#52c41a' : d >= 3 ? '#faad14' : '#bfbfbf';
          const carried = row.screen_days < d;
          return (
            <Tooltip
              title={
                carried
                  ? `${d} active days · ${row.screen_days} on a screen, ${d - row.screen_days} carried by daily bars alone`
                  : `${d} active days, all on a screen`
              }
            >
              <span style={{ lineHeight: 1.1 }}>
                <span style={{ color, fontWeight: 700, fontSize: 13 }}>{d}d</span>
                <br />
                <span style={{ color: '#8c8c8c', fontSize: 10 }}>
                  {row.screen_days}/{d} scr
                </span>
              </span>
            </Tooltip>
          );
        },
        sorter: (a, b) => a.days_in_run - b.days_in_run,
        defaultSortOrder: 'ascend',
      },
      {
        title: 'Window',
        key: 'window',
        width: 100,
        render: (_v, row) => (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {fmtMD(row.first_seen)} → {fmtMD(row.last_seen)}
          </Text>
        ),
      },
      {
        title: 'Move',
        key: 'move',
        width: 130,
        align: 'right',
        // Cumulative move from the run's base close to the latest close — the
        // "how far has it gone" number that replaces the old runner-score
        // trajectory (now that Momentum-only names have no score). Subtext is
        // the most recent day's close-to-close change so you can see whether
        // it's still advancing or rolling over.
        render: (_v, row) => {
          const fb = row.from_base_pct;
          const ld = row.last_day_change_pct;
          if (fb == null) {
            return <Text type="secondary" style={{ fontSize: 11 }}>—</Text>;
          }
          const fbColor = fb >= 100 ? '#52c41a' : fb >= 30 ? '#faad14' : '#bfbfbf';
          const ldColor = ld == null ? '#8c8c8c' : ld >= 0 ? '#52c41a' : '#ff4d4f';
          return (
            <span style={{ lineHeight: 1.1 }}>
              <span style={{ color: fbColor, fontWeight: 700, fontSize: 13 }}>
                {fb >= 0 ? '+' : ''}{fb.toFixed(0)}%
              </span>
              <br />
              <span style={{ color: ldColor, fontSize: 10 }}>
                {ld == null ? '· d/d' : `${ld >= 0 ? '+' : ''}${ld.toFixed(1)}% d/d`}
              </span>
            </span>
          );
        },
        sorter: (a, b) => (a.from_base_pct ?? -Infinity) - (b.from_base_pct ?? -Infinity),
      },
      {
        title: 'Off peak',
        key: 'off_peak',
        width: 96,
        align: 'right',
        // Liveness: latest close vs the run's peak close (≤ 0). Near 0 = holding
        // the highs (live continuation); deeply negative = fading. The backend
        // already drops anything past −50%, so everything here is "still alive";
        // this column shows where in that band each name sits. today_peak (live
        // Ignition score) rides as a small ⚡ marker when the name is hot now.
        render: (_v, row) => {
          const op = row.off_peak_pct;
          const hot = row.today_peak != null;
          return (
            <span style={{ fontSize: 12 }}>
              {hot && (
                <Tooltip title={`Live Ignition score today: ${Math.round(row.today_peak!)}`}>
                  <span style={{ color: scoreColor(row.today_peak), marginRight: 4 }}>⚡</span>
                </Tooltip>
              )}
              {op == null ? (
                <Text type="secondary">—</Text>
              ) : (
                <span style={{ color: op >= -10 ? '#52c41a' : op >= -30 ? '#faad14' : '#ff7875', fontWeight: 600 }}>
                  {op.toFixed(0)}%
                </span>
              )}
            </span>
          );
        },
        sorter: (a, b) => (a.off_peak_pct ?? -Infinity) - (b.off_peak_pct ?? -Infinity),
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
              No continuation candidates yet. Needs ≥ 2 active days (a screen hit or a real daily-bar
              move) per ticker within the last 7 days, still holding near its run high; the cache
              refreshes every ~10 min.
            </Text>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ padding: '4px 10px', background: '#2a1f12', borderBottom: '1px solid #3a2a15' }}>
        <Text style={{ fontSize: 11, color: '#d89614' }}>
          ⚠ Already ran — not a long entry. Our outcome data shows multi-day names average −2.4% / 28% win
          over the next 5 days (vs +3.2% / 39% for fresh names). Watch these for the fade / short, not a chase.
        </Text>
      </div>
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
            opacity: isWarned(r.ticker) && r.ticker !== selected ? 0.5 : 1,
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

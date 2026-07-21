import { useState } from 'react';
import { Typography, Tooltip, Empty, Button, Popover, List } from 'antd';
import { CloseOutlined, EyeInvisibleOutlined } from '@ant-design/icons';
import type { CatalystInfo, CyclePayload, EmaCrossItem, IgnitionRow, NewsRadarItem, TickCatch } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useLayout } from '../../context/LayoutContext';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { CatalystBadge } from '../common/CatalystBadge';
import { ShelfBadge } from '../common/ShelfBadge';
import { WarningBadge, useIsWarned } from '../common/WarningBadge';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { fmtPrice, fmtPct, num, isFreshArrival } from '../../utils/format';
import { CatalystNewsModal } from './CatalystNewsModal';

const { Text } = Typography;

// Runner-score color tiers — mirrors the FireBadge catalyst tiers.
function scoreColor(s: number): string {
  if (s >= 75) return '#ff4d4f';
  if (s >= 55) return '#fa8c16';
  if (s >= 40) return '#fadb14';
  return '#8c8c8c';
}

// Above/below-VWAP arrow shown next to the change%. The VWAP itself is
// anchored to the ticker's first detection today and persists across PM →
// regular → AH (see EnrichedRow.vwap in services/poller.ts) — so a pre-market
// spike's volume keeps weighting the indicator into the regular session.
// Tooltip carries the exact VWAP and the % delta vs current price.
function VwapMark({
  vwap,
  aboveVwap,
  price,
}: {
  vwap: number | null;
  aboveVwap: boolean | null;
  price: number | null;
}) {
  if (vwap == null || aboveVwap == null) return null;
  const delta = price != null && vwap > 0 ? ((price - vwap) / vwap) * 100 : null;
  const color = aboveVwap ? '#52c41a' : '#ff4d4f';
  const arrow = aboveVwap ? '▲' : '▼';
  const tip = `VWAP $${vwap.toFixed(2)}${delta != null ? ` · ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% vs price` : ''} · anchored to first detection today`;
  return (
    <Tooltip title={tip}>
      <span style={{ color, fontSize: 10, marginRight: 4, cursor: 'help' }}>{arrow}</span>
    </Tooltip>
  );
}

// A compact section label — sits above the New and Top row groups.
function SectionHeader({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div style={{ padding: '3px 8px', borderBottom: '1px solid #2a2a2a' }}>
      <Text strong style={{ color, fontSize: 10, letterSpacing: 0.6 }}>{label}</Text>
      <Text type="secondary" style={{ fontSize: 10, marginLeft: 5 }}>{count}</Text>
    </div>
  );
}

// Unhide list — shown in the header popover. The hidden set is global per
// user/day, shared with the Momentum screener: unhiding here unhides there too.
function HiddenList({ tickers, onUnhide }: { tickers: string[]; onUnhide: (t: string) => void }) {
  return (
    <List
      size="small"
      style={{ minWidth: 150 }}
      dataSource={tickers}
      locale={{ emptyText: 'Nothing hidden' }}
      renderItem={(t) => (
        <List.Item style={{ padding: '4px 0' }}>
          <Text strong style={{ flex: 1 }}>{t}</Text>
          <Button type="link" size="small" onClick={() => onUnhide(t)} style={{ padding: 0, height: 'auto' }}>
            unhide
          </Button>
        </List.Item>
      )}
    />
  );
}

// Always-visible feed of the Ignition screener — low-float names in the first
// minutes of a move. Split into two groups: a pinned "New" section (tickers
// that just entered the set, surfaced regardless of runner-score so a fresh
// low-score name is never buried) above the score-ranked "Top" list. Clicking
// a row drives the shared selection (charts + Quote panel).
export function IgnitionSidebar({ payload }: { payload: CyclePayload | null }) {
  const { selected, setSelected } = useSelection();
  const { hidden, hide, unhide } = useHiddenTickers();
  const {
    ignitionNewsOnly, setIgnitionNewsOnly,
    hideLiveTicks, setHideLiveTicks,
    hideIgnitionList, setHideIgnitionList,
    hideNewsRadar, setHideNewsRadar,
  } = useLayout();
  const isWarned = useIsWarned();
  const [catalystModal, setCatalystModal] = useState<{ ticker: string; catalyst: CatalystInfo | null } | null>(null);
  // Hidden filter always applies; "news only" additionally drops rows with no
  // catalyst/news today (client-side display filter — the broadcast is intact).
  const all = (payload?.ignition ?? []).filter(
    (r) => !hidden.has(r.ticker) && (!ignitionNewsOnly || r.has_today_news),
  );
  const newRows = all.filter((r) => r.is_new);
  const topRows = all.filter((r) => !r.is_new);
  // Live tick-feed catches — surged on the per-second feed before the screens
  // returned them. Pinned at the very top; drop out once a screen catches up.
  const tickCatches = (payload?.tick_catches ?? []).filter((t) => !hidden.has(t.ticker));
  // News radar — fresh catalysts on known runners that aren't moving yet.
  const newsRadar = (payload?.news_radar ?? []).filter((n) => !hidden.has(n.ticker));
  // EMA-cross layers, grouped per timeframe (each tf gets its own section).
  const emaCrosses = (payload?.ema_crosses ?? []).filter((x) => !hidden.has(x.ticker));
  const emaGroups = (['5m', '1h', '4h'] as const)
    .map((tf) => ({ tf, items: emaCrosses.filter((x) => x.tf === tf) }))
    .filter((g) => g.items.length > 0);
  // Hiding LIVE TICKS / the ignition list frees their space for the EMA
  // sections (display-only — the server keeps computing and alerting).
  const emaMaxHeight = hideIgnitionList ? undefined : '20%';
  const hiddenList = [...hidden].sort();

  const renderRow = (r: IgnitionRow) => (
    <IgnitionItem
      key={r.ticker}
      row={r}
      selected={r.ticker === selected}
      onSelect={setSelected}
      onHide={hide}
      onOpenCatalyst={() => setCatalystModal({ ticker: r.ticker, catalyst: r.catalyst ?? null })}
      warned={isWarned(r.ticker)}
    />
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <CatalystNewsModal
        ticker={catalystModal?.ticker ?? null}
        catalyst={catalystModal?.catalyst ?? null}
        onClose={() => setCatalystModal(null)}
      />
      <div
        style={{
          padding: '6px 8px',
          borderBottom: '1px solid #303030',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>
          <Text strong style={{ color: '#e0e0e0', letterSpacing: 0.5, fontSize: 15 }}>⚡ Ignition</Text>
          <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>{all.length}</Text>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <Tooltip title={hideLiveTicks ? 'LIVE TICKS hidden (still computing server-side) — click to show' : 'Hide the LIVE TICKS section (display only — alerts keep firing)'}>
          <Button
            type="text"
            size="small"
            onClick={() => setHideLiveTicks(!hideLiveTicks)}
            style={{
              fontSize: 11,
              padding: '0 6px',
              color: hideLiveTicks ? '#434343' : '#40a9ff',
              textDecoration: hideLiveTicks ? 'line-through' : undefined,
            }}
          >
            🛰️
          </Button>
        </Tooltip>
        <Tooltip title={hideNewsRadar ? 'NEWS RADAR hidden (still computing server-side) — click to show' : 'Hide the NEWS RADAR section (display only — alerts keep firing)'}>
          <Button
            type="text"
            size="small"
            onClick={() => setHideNewsRadar(!hideNewsRadar)}
            style={{
              fontSize: 11,
              padding: '0 6px',
              color: hideNewsRadar ? '#434343' : '#b37feb',
              textDecoration: hideNewsRadar ? 'line-through' : undefined,
            }}
          >
            📰
          </Button>
        </Tooltip>
        <Tooltip title={hideIgnitionList ? 'Ignition list hidden (still computing server-side) — click to show' : 'Hide the ignition NEW/TOP list (display only — more room for EMA crosses)'}>
          <Button
            type="text"
            size="small"
            onClick={() => setHideIgnitionList(!hideIgnitionList)}
            style={{
              fontSize: 11,
              padding: '0 6px',
              color: hideIgnitionList ? '#434343' : '#fadb14',
              textDecoration: hideIgnitionList ? 'line-through' : undefined,
            }}
          >
            ⚡
          </Button>
        </Tooltip>
        <Tooltip title={ignitionNewsOnly ? 'Showing only rows with news today — click to show all' : 'Show only rows with a catalyst / news today'}>
          <Button
            type="text"
            size="small"
            onClick={() => setIgnitionNewsOnly(!ignitionNewsOnly)}
            style={{
              fontSize: 11,
              padding: '0 6px',
              color: ignitionNewsOnly ? '#fa8c16' : '#8c8c8c',
              background: ignitionNewsOnly ? '#2a1f12' : undefined,
            }}
          >
            🔥 news
          </Button>
        </Tooltip>
        {hiddenList.length > 0 && (
          <Popover
            trigger="click"
            placement="bottomRight"
            content={<HiddenList tickers={hiddenList} onUnhide={unhide} />}
          >
            <Button
              type="text"
              size="small"
              icon={<EyeInvisibleOutlined />}
              style={{ fontSize: 11, color: '#8c8c8c' }}
            >
              {hiddenList.length}
            </Button>
          </Popover>
        )}
        </span>
      </div>

      {/* Live ticks — caught before the screens; pinned above everything */}
      {!hideLiveTicks && tickCatches.length > 0 && (
        <div
          style={{
            flex: '0 0 auto',
            maxHeight: '38%',
            overflow: 'auto',
            background: '#0d1b26',
            borderBottom: '2px solid #1765ad',
          }}
        >
          <SectionHeader label="🛰️ LIVE TICKS" count={tickCatches.filter((t) => t.status !== 'faded').length} color="#40a9ff" />
          {tickCatches.map((tc) => (
            <TickItem key={tc.ticker} tc={tc} selected={tc.ticker === selected} onSelect={setSelected} />
          ))}
        </div>
      )}

      {/* News radar — fresh catalyst on a known runner, not moving yet */}
      {!hideNewsRadar && newsRadar.length > 0 && (
        <div
          style={{
            flex: '0 0 auto',
            maxHeight: '30%',
            overflow: 'auto',
            background: '#170f26',
            borderBottom: '2px solid #722ed1',
          }}
        >
          <SectionHeader label="📰 NEWS RADAR" count={newsRadar.length} color="#b37feb" />
          {newsRadar.map((n) => (
            <RadarItem
              key={n.ticker}
              item={n}
              selected={n.ticker === selected}
              onSelect={setSelected}
              warned={isWarned(n.ticker)}
            />
          ))}
        </div>
      )}

      {/* EMA-cross layers — one section per timeframe (5M / 1H / 4H). With
          the ignition list hidden they grow freely into the freed space. */}
      {emaGroups.map((g) => (
        <div
          key={g.tf}
          style={{
            flex: '0 1 auto',
            maxHeight: emaMaxHeight,
            overflow: 'auto',
            background: '#0f1a12',
            borderBottom: '2px solid #237804',
          }}
        >
          <SectionHeader label={`📈 EMA ${g.tf.toUpperCase()}`} count={g.items.length} color="#95de64" />
          {g.items.map((x) => (
            <EmaCrossRow key={`${x.tf}|${x.ticker}`} item={x} selected={x.ticker === selected} onSelect={setSelected} />
          ))}
        </div>
      ))}

      {hideIgnitionList ? (
        <div style={{ flex: '1 1 auto' }} />
      ) : all.length === 0 && (hideLiveTicks || tickCatches.length === 0) && (hideNewsRadar || newsRadar.length === 0) ? (
        <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Text type="secondary" style={{ fontSize: 12 }}>
                {ignitionNewsOnly ? 'No ignitions with news today' : 'No ignitions'}
              </Text>
            }
          />
        </div>
      ) : (
        <>
          {/* New — pinned at the top, never scrolls out of view */}
          {newRows.length > 0 && (
            <div
              style={{
                flex: '0 0 auto',
                maxHeight: '45%',
                overflow: 'auto',
                background: '#13211a',
                borderBottom: '2px solid #237804',
              }}
            >
              <SectionHeader label="🆕 NEW" count={newRows.length} color="#73d13d" />
              {newRows.map(renderRow)}
            </div>
          )}

          {/* Top — score-ranked, scrolls */}
          <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
            {newRows.length > 0 && topRows.length > 0 && (
              <SectionHeader label="TOP" count={topRows.length} color="#8c8c8c" />
            )}
            {topRows.map(renderRow)}
          </div>
        </>
      )}
    </div>
  );
}

// A live tick-feed catch row — lighter than an ignition row (no score yet; the
// screens haven't returned it). Two-tier styling: 👀 watch = amber (price-led
// flag, confirmation pending), 🛰️ confirmed = blue (volume-confirmed), faded =
// grey and dimmed (expired watch, lingers briefly). Clickable to chart it.
const TICK_STYLES = {
  accum:     { border: '#08979c', ticker: '#5cdbd3', row: '#112b2b' },
  watch:     { border: '#d48806', ticker: '#ffd666', row: '#3a2e10' },
  confirmed: { border: '#1890ff', ticker: '#69c0ff', row: '#14304a' },
  faded:     { border: '#595959', ticker: '#8c8c8c', row: '#262626' },
} as const;

function TickItem({ tc, selected, onSelect }: { tc: TickCatch; selected: boolean; onSelect: (t: string) => void }) {
  const status = tc.status ?? 'confirmed';
  const s = TICK_STYLES[status];
  const anchor = (status === 'confirmed' && tc.confirmed_at) ? tc.confirmed_at : tc.caught_at;
  const agoMs = Date.now() - new Date(anchor).getTime();
  const ago = agoMs < 60_000 ? `${Math.round(agoMs / 1000)}s` : `${Math.round(agoMs / 60_000)}m`;
  const meta: string[] = [];
  if (status === 'accum') meta.push('🤫 accum');
  if (status === 'watch') meta.push('👀 pending');
  if (status === 'faded') meta.push('faded');
  if (tc.rel_vol > 0) meta.push(`${Math.round(tc.rel_vol)}× rv`);
  // Where the flag was planted (the lead) — shown whenever it's known and the
  // name has moved since. Rows refresh price/chg live from the screens, so a
  // watch row can read +106% with a ⚑ +39% flag (CETX) and a direct confirm
  // still carries its detector-side flag (CLRO).
  if (tc.watch_change_pct != null && Math.round(tc.watch_change_pct) !== Math.round(num(tc.change_pct) ?? tc.watch_change_pct)) {
    meta.push(`⚑ +${Math.round(tc.watch_change_pct)}%`);
  }
  meta.push(`${ago} ago`);
  return (
    <div
      onClick={() => onSelect(tc.ticker)}
      style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        padding: '5px 8px', borderBottom: `1px solid ${s.row}`, cursor: 'pointer',
        borderLeft: `3px solid ${s.border}`,
        background: selected ? '#15395b' : undefined,
        opacity: status === 'faded' ? 0.55 : 1,
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ marginRight: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
          <TickerLinks ticker={tc.ticker} />
        </span>
        <TickerLink
          ticker={tc.ticker}
          onSelect={onSelect}
          stopPropagation
          style={{ color: s.ticker, fontWeight: 600, fontSize: 13 }}
        />
        <span style={{ marginLeft: 6, fontSize: 10, color: '#8c8c8c' }}>
          {meta.join(' · ')}
        </span>
      </span>
      <span style={{ flex: '0 0 auto' }}>
        <Text type="secondary" style={{ fontSize: 11, marginRight: 6 }}>{fmtPrice(tc.price)}</Text>
        <Text style={{ color: (num(tc.change_pct) ?? 0) >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 600 }}>
          {fmtPct(tc.change_pct)}
        </Text>
      </span>
    </div>
  );
}

// An EMA-cross row — a 6/50 crossover on 5m bars, either under its ~30-min
// volume observation (dim, "…observing") or volume-confirmed (bright green,
// shows the expansion multiple). Click to chart it.
function EmaCrossRow({ item, selected, onSelect }: {
  item: EmaCrossItem;
  selected: boolean;
  onSelect: (t: string) => void;
}) {
  const confirmed = item.status === 'confirmed';
  const isHtf = item.tf !== '5m';
  // "ago" always anchors on the CROSS bar so it reads like the TV chart the
  // operator compares against; the ✅ multiple marks the confirmation itself.
  const agoMs = Date.now() - new Date(item.cross_at).getTime();
  const ago = agoMs < 60_000 ? `${Math.round(agoMs / 1000)}s`
    : agoMs < 3_600_000 ? `${Math.round(agoMs / 60_000)}m`
    : `${(agoMs / 3_600_000).toFixed(1)}h`;
  return (
    <div
      onClick={() => onSelect(item.ticker)}
      style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        padding: '4px 8px', borderBottom: '1px solid #162b1a', cursor: 'pointer',
        borderLeft: `3px solid ${confirmed ? '#52c41a' : '#3f6600'}`,
        background: selected ? '#1c3a22' : undefined,
        opacity: confirmed ? 1 : 0.75,
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ marginRight: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
          <TickerLinks ticker={item.ticker} />
        </span>
        <TickerLink
          ticker={item.ticker}
          onSelect={onSelect}
          stopPropagation
          style={{ color: confirmed ? '#95de64' : '#8c9b8c', fontWeight: 600, fontSize: 13 }}
        />
        <span style={{ marginLeft: 6, fontSize: 10, color: '#8c8c8c' }}>
          {confirmed ? `✅ ${Math.round(item.vol_ratio)}× vol` : isHtf ? 'cross' : '… observing'} · {isHtf ? '' : 'cross '}{ago} ago
        </span>
      </span>
      <span style={{ flex: '0 0 auto' }}>
        <Text type="secondary" style={{ fontSize: 11 }}>{fmtPrice(item.price)}</Text>
      </span>
    </div>
  );
}

// A news-radar row — a fresh catalyst on a known runner that isn't moving yet
// (📰 purple). Two lines: ticker + classification meta, then the headline.
// Escalates to a green "moving ↗" marker once the tick feed or a screen picks
// the name up. Click to chart it — the whole point is eyes-on-chart early.
function RadarItem({ item, selected, onSelect, warned }: {
  item: NewsRadarItem;
  selected: boolean;
  onSelect: (t: string) => void;
  warned: boolean;
}) {
  const agoMs = Date.now() - new Date(item.first_seen_at).getTime();
  const ago = agoMs < 60_000 ? `${Math.round(agoMs / 1000)}s` : `${Math.round(agoMs / 60_000)}m`;
  const moving = item.status === 'moving';
  const meta: string[] = [`imp ${item.impact}`];
  if (item.hype >= 60) meta.push(`🚀 ${item.hype}`);
  if (item.catalyst_type && item.catalyst_type !== 'other') meta.push(item.catalyst_type);
  meta.push(`${ago} ago`);
  return (
    <div
      onClick={() => onSelect(item.ticker)}
      style={{
        padding: '5px 8px',
        borderBottom: '1px solid #241633',
        cursor: 'pointer',
        borderLeft: `3px solid ${moving ? '#52c41a' : '#722ed1'}`,
        background: selected ? '#2a1a45' : undefined,
        opacity: warned ? 0.55 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ minWidth: 0 }}>
          <span style={{ marginRight: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
            <TickerLinks ticker={item.ticker} />
          </span>
          <TickerLink
            ticker={item.ticker}
            onSelect={onSelect}
            stopPropagation
            style={{ color: '#b37feb', fontWeight: 600, fontSize: 13 }}
          />
          {warned && <span style={{ marginLeft: 4 }}>⛔</span>}
          <span style={{ marginLeft: 6, fontSize: 10, color: '#8c8c8c' }}>{meta.join(' · ')}</span>
        </span>
        <span style={{ flex: '0 0 auto', fontSize: 11, fontWeight: 600, color: moving ? '#73d13d' : '#b37feb' }}>
          {moving ? 'moving ↗' : '📰 news'}
        </span>
      </div>
      <div
        title={item.title}
        style={{
          fontSize: 10,
          color: '#a89bc0',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          marginTop: 1,
        }}
      >
        {item.title}
      </div>
    </div>
  );
}

function IgnitionItem({
  row,
  selected,
  onSelect,
  onHide,
  onOpenCatalyst,
  warned,
}: {
  row: IgnitionRow;
  selected: boolean;
  onSelect: (t: string) => void;
  onHide: (t: string) => void;
  onOpenCatalyst: () => void;
  warned: boolean;
}) {
  const b = row.score_breakdown;
  const chg = num(row.change_pct);
  const bits = [
    row.float_m != null ? `${row.float_m.toFixed(1)}M fl` : null,
    row.rel_vol_5min != null ? `${Math.round(row.rel_vol_5min)}% rv5` : null,
  ].filter(Boolean);

  // Just appeared on the screen (~75s) — green flash so a fresh ignition
  // catches the eye even when its score sorts it down the list.
  const fresh = isFreshArrival(row.first_seen_at);
  return (
    <div
      onClick={() => onSelect(row.ticker)}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: '1px solid #2a2a2a',
        borderLeft: fresh ? '3px solid #52c41a' : '3px solid transparent',
        cursor: 'pointer',
        background: selected ? '#15395b' : fresh ? 'rgba(115,209,61,0.12)' : undefined,
        // Burned/avoid rows recede (the ⛔ badge stays full-opacity is fine —
        // dimming the whole row is the at-a-glance "skip this" cue).
        opacity: warned && !selected ? 0.5 : 1,
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0, padding: '6px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span>
            <span style={{ marginRight: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
              <TickerLinks ticker={row.ticker} finvizUrl={row.finviz_url} />
            </span>
            <TickerLink
              ticker={row.ticker}
              onSelect={onSelect}
              stopPropagation
              style={{ color: '#fff', fontWeight: 600, fontSize: 13 }}
            />
            {fresh && (
              <span
                style={{
                  marginLeft: 5, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
                  color: '#52c41a', border: '1px solid #52c41a', borderRadius: 3,
                  padding: '0 3px', verticalAlign: 'middle',
                }}
              >
                NEW
              </span>
            )}
            {row.shelf && (
              <span style={{ marginLeft: 4 }}>
                <ShelfBadge shelf={row.shelf} size={12} />
              </span>
            )}
            {row.is_fresh_news && (
              <span title="Fresh news this cycle" style={{ marginLeft: 4, fontSize: 11 }}>🚨</span>
            )}
            {row.has_today_news && (
              <CatalystBadge
                score={row.catalyst?.score ?? null}
                hype={row.catalyst?.hype}
                reason={row.catalyst?.reason}
                type={row.catalyst?.type}
                onOpen={onOpenCatalyst}
                size={12}
              />
            )}
            <WarningBadge ticker={row.ticker} size={12} />
          </span>
          {/* Click (not hover) opens the score breakdown; stopPropagation
              keeps the click from also selecting the row. */}
          <Tooltip
            trigger="click"
            title={`float ${b.float} · volume ${b.volume} · catalyst ${b.catalyst} · maturity ${b.maturity} · premarket ${b.premarket} · shelf ${b.shelf}`}
          >
            <span
              onClick={(e) => e.stopPropagation()}
              style={{ color: scoreColor(row.runner_score), fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
            >
              {row.runner_score}
            </span>
          </Tooltip>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <Text type="secondary">{fmtPrice(row.price)}</Text>
          <span>
            <VwapMark vwap={row.vwap} aboveVwap={row.above_vwap} price={row.price} />
            <Text style={{ color: (chg ?? 0) >= 0 ? '#52c41a' : '#ff4d4f' }}>{fmtPct(row.change_pct)}</Text>
          </span>
        </div>
        {bits.length > 0 && (
          <div style={{ fontSize: 10, color: '#8c8c8c', marginTop: 1 }}>{bits.join(' · ')}</div>
        )}
      </div>
      <Button
        type="text"
        size="small"
        title="Hide for today"
        icon={<CloseOutlined style={{ fontSize: 10, color: '#888' }} />}
        onClick={(e) => { e.stopPropagation(); onHide(row.ticker); }}
        style={{ width: 22, height: 22, padding: 0, alignSelf: 'center', marginRight: 2, flex: '0 0 auto' }}
      />
    </div>
  );
}

import { useState } from 'react';
import { Typography, Tooltip, Empty, Button, Popover, List } from 'antd';
import { CloseOutlined, EyeInvisibleOutlined } from '@ant-design/icons';
import type { CatalystInfo, CyclePayload, IgnitionRow } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useLayout } from '../../context/LayoutContext';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { CatalystBadge } from '../common/CatalystBadge';
import { ShelfBadge } from '../common/ShelfBadge';
import { WarningBadge, useIsWarned } from '../common/WarningBadge';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { WatchlistStar } from '../common/WatchlistStar';
import { fmtPrice, fmtPct, num } from '../../utils/format';
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
  const { ignitionNewsOnly, setIgnitionNewsOnly } = useLayout();
  const isWarned = useIsWarned();
  const [catalystModal, setCatalystModal] = useState<{ ticker: string; catalyst: CatalystInfo | null } | null>(null);
  // Hidden filter always applies; "news only" additionally drops rows with no
  // catalyst/news today (client-side display filter — the broadcast is intact).
  const all = (payload?.ignition ?? []).filter(
    (r) => !hidden.has(r.ticker) && (!ignitionNewsOnly || r.has_today_news),
  );
  const newRows = all.filter((r) => r.is_new);
  const topRows = all.filter((r) => !r.is_new);
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

      {all.length === 0 ? (
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

  return (
    <div
      onClick={() => onSelect(row.ticker)}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: '1px solid #2a2a2a',
        cursor: 'pointer',
        background: selected ? '#15395b' : undefined,
        // Burned/avoid rows recede (the ⛔ badge stays full-opacity is fine —
        // dimming the whole row is the at-a-glance "skip this" cue).
        opacity: warned && !selected ? 0.5 : 1,
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0, padding: '6px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span>
            <WatchlistStar ticker={row.ticker} size={12} />
            <span style={{ marginLeft: 4, marginRight: 4, display: 'inline-flex', verticalAlign: 'middle' }}>
              <TickerLinks ticker={row.ticker} finvizUrl={row.finviz_url} />
            </span>
            <TickerLink
              ticker={row.ticker}
              onSelect={onSelect}
              stopPropagation
              style={{ color: '#fff', fontWeight: 600, fontSize: 13 }}
            />
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

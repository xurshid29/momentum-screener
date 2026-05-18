import { Typography, Tooltip, Empty } from 'antd';
import type { CyclePayload, IgnitionRow } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { ShelfBadge } from '../common/ShelfBadge';
import { fmtPrice, fmtPct, num } from '../../utils/format';

const { Text } = Typography;

// Runner-score color tiers — mirrors the FireBadge catalyst tiers.
function scoreColor(s: number): string {
  if (s >= 75) return '#ff4d4f';
  if (s >= 55) return '#fa8c16';
  if (s >= 40) return '#fadb14';
  return '#8c8c8c';
}

// Catalyst marker by direction — a bearish catalyst must not look "hot".
function catalystIcon(direction: string): string {
  if (direction === 'bullish') return '🔥';
  if (direction === 'bearish') return '🔻';
  return '◆';
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

// Always-visible feed of the Ignition screener — low-float names in the first
// minutes of a move. Split into two groups: a pinned "New" section (tickers
// that just entered the set, surfaced regardless of runner-score so a fresh
// low-score name is never buried) above the score-ranked "Top" list. Clicking
// a row drives the shared selection (charts + Quote panel).
export function IgnitionSidebar({ payload }: { payload: CyclePayload | null }) {
  const { selected, setSelected } = useSelection();
  const all = payload?.ignition ?? [];
  const newRows = all.filter((r) => r.is_new);
  const topRows = all.filter((r) => !r.is_new);

  const renderRow = (r: IgnitionRow) => (
    <IgnitionItem key={r.ticker} row={r} selected={r.ticker === selected} onSelect={setSelected} />
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #303030' }}>
        <Text strong style={{ color: '#e0e0e0', letterSpacing: 0.5 }}>⚡ Ignition</Text>
        <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>{all.length}</Text>
      </div>

      {all.length === 0 ? (
        <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<Text type="secondary" style={{ fontSize: 12 }}>No ignitions</Text>}
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
}: {
  row: IgnitionRow;
  selected: boolean;
  onSelect: (t: string) => void;
}) {
  const b = row.score_breakdown;
  const chg = num(row.change_pct);
  const bits = [
    row.float_m != null ? `${row.float_m.toFixed(1)}M fl` : null,
    row.rel_vol_5min != null ? `${Math.round(row.rel_vol_5min)}% rv5` : null,
    row.catalyst ? `${catalystIcon(row.catalyst.direction)}${row.catalyst.score}` : null,
  ].filter(Boolean);

  return (
    <div
      onClick={() => onSelect(row.ticker)}
      style={{
        padding: '6px 8px',
        borderBottom: '1px solid #2a2a2a',
        cursor: 'pointer',
        background: selected ? '#15395b' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ color: '#fff', fontWeight: 600, fontSize: 13 }}>
          {row.ticker}
          {row.shelf && (
            <span style={{ marginLeft: 4 }}>
              <ShelfBadge shelf={row.shelf} size={12} />
            </span>
          )}
        </span>
        <Tooltip
          title={`float ${b.float} · volume ${b.volume} · catalyst ${b.catalyst} · earliness ${b.earliness} · halt ${b.halt} · shelf ${b.shelf}`}
        >
          <span style={{ color: scoreColor(row.runner_score), fontWeight: 700, fontSize: 14 }}>
            {row.runner_score}
          </span>
        </Tooltip>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
        <Text type="secondary">{fmtPrice(row.price)}</Text>
        <Text style={{ color: (chg ?? 0) >= 0 ? '#52c41a' : '#ff4d4f' }}>{fmtPct(row.change_pct)}</Text>
      </div>
      {bits.length > 0 && (
        <div style={{ fontSize: 10, color: '#8c8c8c', marginTop: 1 }}>{bits.join(' · ')}</div>
      )}
    </div>
  );
}

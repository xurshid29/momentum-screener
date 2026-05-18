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

// Always-visible ranked feed of the Ignition screener — low-float names in the
// first minutes of a move, ranked by runner-score. Clicking a row drives the
// shared selection (charts + Quote panel), same as the Momentum table.
export function IgnitionSidebar({ payload }: { payload: CyclePayload | null }) {
  const { selected, setSelected } = useSelection();
  const rows = payload?.ignition ?? [];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #303030' }}>
        <Text strong style={{ color: '#e0e0e0', letterSpacing: 0.5 }}>⚡ Ignition</Text>
        <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>{rows.length}</Text>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        {rows.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<Text type="secondary" style={{ fontSize: 12 }}>No ignitions</Text>}
            />
          </div>
        ) : (
          rows.map((r) => (
            <IgnitionItem
              key={r.ticker}
              row={r}
              selected={r.ticker === selected}
              onSelect={setSelected}
            />
          ))
        )}
      </div>
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

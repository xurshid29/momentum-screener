import { Typography, Tooltip, Empty } from 'antd';
import type { CatalystInfo, EmaCrossItem } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { CatalystBadge } from '../common/CatalystBadge';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { fmtPrice, isFreshArrival } from '../../utils/format';

const { Text } = Typography;

// The ↗ price-reclaim layer, as a full panel (2026-07-28). It lived in the
// left sidebar until the operator's whole workflow became this layer — five
// timeframes stacked into ~200px, a handful of rows each, while the main
// panel carried tables they don't use. Here each timeframe gets its own
// full-height lane, so a busy session shows every fresh reclaim instead of
// the few that fit. Server-side selection/ordering is unchanged (recency
// first, with reserved slots for observing rows — see the payload build in
// poller.ts); this only gives it room.
const TF_LANES = ['5m', '15m', '1h', '4h', '1d'] as const;
type Tf = (typeof TF_LANES)[number];

const TF_LABEL: Record<Tf, string> = {
  '5m': 'EMA 5M', '15m': 'EMA 15M', '1h': 'EMA 1H', '4h': 'EMA 4H', '1d': 'EMA 1D',
};

// A single reclaim row — dim while under volume observation, bright green
// once volume-confirmed (with the expansion multiple). Click charts it.
export function EmaCrossRow({ item, selected, onSelect, onOpenCatalyst }: {
  item: EmaCrossItem;
  selected: boolean;
  onSelect: (t: string) => void;
  onOpenCatalyst: () => void;
}) {
  const confirmed = item.status === 'confirmed';
  const isHtf = item.tf !== '5m';
  // Freshly confirmed — pulse the row so the payoff event catches the eye.
  // Window scales with the timeframe (a 4h confirm stays "new" longer than
  // a 5m one); same isFreshArrival convention as ignition rows.
  const FRESH_CONFIRM_SEC = { '5m': 300, '15m': 600, '1h': 900, '4h': 1800, '1d': 3600 } as const;
  const freshConfirm = confirmed && isFreshArrival(item.confirmed_at, FRESH_CONFIRM_SEC[item.tf]);
  // "ago" always anchors on the RECLAIM bar so it reads like the TV chart the
  // operator compares against; the ✅ multiple marks the confirmation itself.
  const fmtAgo = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s`
    : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m`
    : `${(ms / 3_600_000).toFixed(1)}h`);
  const agoMs = Date.now() - new Date(item.cross_at).getTime();
  const ago = fmtAgo(agoMs);
  // Confirm age, shown alongside (2026-07-28). A row enters the panel when it
  // CONFIRMS, but its label is anchored at the reclaim — so a late confirm
  // (thin tape needing ~30 min to clear the $10k floor) appeared out of
  // nowhere reading "reclaim 33m ago" and looked like a stale detection.
  // Both ages together say exactly what happened: the geometry fired then,
  // the volume evidence landed now.
  const confirmAgoMs = confirmed && item.confirmed_at
    ? Date.now() - new Date(item.confirmed_at).getTime()
    : null;
  // Only worth the extra text once the two diverge — a same-bar confirm
  // would otherwise read "reclaim 1m ago · confirmed 1m ago".
  const showConfirmAgo = confirmAgoMs != null && agoMs - confirmAgoMs > 120_000;
  return (
    <div
      onClick={() => onSelect(item.ticker)}
      className={freshConfirm ? 'ema-confirm-fresh' : undefined}
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
        {(item.catalyst || item.news_title) && (
          <span style={{ marginLeft: 4, display: 'inline-flex', verticalAlign: 'middle' }}>
            <CatalystBadge
              score={item.catalyst?.score ?? null}
              hype={item.catalyst?.hype}
              reason={item.catalyst?.reason}
              type={item.catalyst?.type}
              onOpen={onOpenCatalyst}
              size={12}
            />
          </span>
        )}
        {item.signal === 'reclaim' && (
          <Tooltip title="Price-reclaim channel: price crossed up through BOTH EMAs (10 & 65) — the arming bar sat at/below both, this one cleared them">
            <span style={{ marginLeft: 4, fontSize: 10, color: '#69c0ff', fontWeight: 600, cursor: 'help' }}>↗</span>
          </Tooltip>
        )}
        <span style={{ marginLeft: 6, fontSize: 10, color: freshConfirm ? '#95de64' : '#8c8c8c', fontWeight: freshConfirm ? 600 : undefined }}>
          {confirmed ? `✅ ${Math.round(item.vol_ratio)}× vol` : isHtf ? (item.signal === 'reclaim' ? 'reclaim' : 'cross') : '… observing'} · {item.signal === 'reclaim' ? 'reclaim ' : isHtf ? '' : 'cross '}{ago} ago
          {showConfirmAgo && ` · confirmed ${fmtAgo(confirmAgoMs!)} ago`}
        </span>
        {item.thin_tape && (
          <Tooltip title="Thin tape on our feed — our EMAs may diverge from TV's here; verify the reclaim on the chart">
            <span style={{ marginLeft: 4, fontSize: 10, cursor: 'help' }}>⚠️</span>
          </Tooltip>
        )}
      </span>
      <span style={{ flex: '0 0 auto' }}>
        <Text type="secondary" style={{ fontSize: 11 }}>{fmtPrice(item.price)}</Text>
      </span>
    </div>
  );
}

export function EmaReclaimPanel({ crosses, onOpenCatalyst }: {
  crosses: EmaCrossItem[];
  onOpenCatalyst: (ticker: string, catalyst: CatalystInfo | null) => void;
}) {
  const { selected, setSelected } = useSelection();
  const { hidden } = useHiddenTickers();
  const visible = crosses.filter((x) => !hidden.has(x.ticker));

  if (visible.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<Text type="secondary">No reclaims yet — the layer arms on a close at/below both EMAs</Text>}
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', gap: 1, overflow: 'hidden', background: '#237804' }}>
      {TF_LANES.map((tf) => {
        const items = visible.filter((x) => x.tf === tf);
        const confirmed = items.filter((x) => x.status === 'confirmed').length;
        return (
          <div
            key={tf}
            style={{
              flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column',
              background: '#0f1a12', overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '3px 8px', background: '#12240f', borderBottom: '1px solid #237804',
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flex: '0 0 auto',
              }}
            >
              <Text style={{ color: '#95de64', fontSize: 11, fontWeight: 600 }}>📈 {TF_LABEL[tf]}</Text>
              <Tooltip title={`${confirmed} volume-confirmed · ${items.length - confirmed} still observing`}>
                <Text type="secondary" style={{ fontSize: 10, cursor: 'help' }}>
                  {confirmed}/{items.length}
                </Text>
              </Tooltip>
            </div>
            <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
              {items.length === 0 ? (
                <div style={{ padding: '8px', textAlign: 'center' }}>
                  <Text type="secondary" style={{ fontSize: 10 }}>—</Text>
                </div>
              ) : (
                items.map((x) => (
                  <EmaCrossRow
                    key={`${x.tf}|${x.signal}|${x.ticker}`}
                    item={x}
                    selected={x.ticker === selected}
                    onSelect={setSelected}
                    onOpenCatalyst={() => onOpenCatalyst(x.ticker, x.catalyst ?? null)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

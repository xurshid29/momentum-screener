import { Typography, Tooltip } from 'antd';
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
  // 'moving' — in-flight and already up ≥3% from its reclaim. Descriptive,
  // not predictive: measured, nothing about an in-flight observation
  // forecasts whether it confirms (89.5% never do, and the hazard is flat in
  // both age and price). This just answers "is it going anywhere yet", so
  // the operator scans a handful of movers instead of forty flat rows.
  const moving = item.status === 'moving';
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
        borderLeft: `3px solid ${confirmed ? '#52c41a' : moving ? '#d48806' : '#3f6600'}`,
        background: selected ? '#1c3a22' : undefined,
        opacity: confirmed || moving ? 1 : 0.7,
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
          style={{ color: confirmed ? '#95de64' : moving ? '#ffc53d' : '#8c9b8c', fontWeight: 600, fontSize: 13 }}
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
        <span style={{ marginLeft: 6, fontSize: 10, color: freshConfirm ? '#95de64' : moving ? '#ffc53d' : '#8c8c8c', fontWeight: freshConfirm || moving ? 600 : undefined }}>
          {confirmed
            ? `✅ ${Math.round(item.vol_ratio)}× vol`
            : moving
              ? `◆ moving · ${Math.round(item.vol_ratio)}×`
              : isHtf ? (item.signal === 'reclaim' ? 'reclaim' : 'cross') : '… observing'} · {item.signal === 'reclaim' ? 'reclaim ' : isHtf ? '' : 'cross '}{ago} ago
          {showConfirmAgo && ` · confirmed ${fmtAgo(confirmAgoMs!)} ago`}
        </span>
        {!confirmed && item.pct_since_reclaim != null && (
          <Tooltip title="Live price move since the reclaim. Note this does NOT predict a confirm — measured, nothing in-flight does (89.5% of nominations never confirm, and the hazard is flat in age and price).">
            <span style={{
              marginLeft: 5, fontSize: 10, cursor: 'help',
              color: item.pct_since_reclaim >= 3 ? '#ffc53d' : item.pct_since_reclaim < 0 ? '#a8564f' : '#6b756b',
            }}>
              {item.pct_since_reclaim >= 0 ? '+' : ''}{item.pct_since_reclaim.toFixed(1)}%
            </span>
          </Tooltip>
        )}
        {item.thin_tape && (
          <Tooltip title="Thin tape on our feed — our EMAs may diverge from TV's here; verify the reclaim on the chart">
            <span style={{ marginLeft: 4, fontSize: 10, cursor: 'help' }}>⚠️</span>
          </Tooltip>
        )}
      </span>
      <span style={{ flex: '0 0 auto', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {/* Day change alongside the live price (2026-07-31): a reclaim on a
            name already +150% is a different trade from one on a name flat
            for the day, and the row could not distinguish them. */}
        {item.change_pct != null && (
          <Tooltip title="Change vs the prior close — the day move this reclaim sits inside">
            <Text
              style={{
                fontSize: 11, marginRight: 6, cursor: 'help', fontWeight: 600,
                color: item.change_pct >= 20 ? '#ff7a45'
                  : item.change_pct > 0 ? '#52c41a'
                  : item.change_pct < 0 ? '#ff4d4f' : '#8c8c8c',
              }}
            >
              {item.change_pct >= 0 ? '+' : ''}{item.change_pct.toFixed(1)}%
            </Text>
          </Tooltip>
        )}
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

  // The lanes always render, even with nothing in them (2026-07-29). An
  // all-empty panel is NORMAL and frequent — the map is cleared at the
  // midnight-ET roll and 5m rows age out in 30-45 min, so every overnight
  // and quiet stretch is empty. Collapsing the whole tab to one centered
  // message threw away the structure and read like something was broken;
  // the standing five-lane skeleton says "armed and watching, nothing yet".
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flex: '1 1 auto', display: 'flex', gap: 1, overflow: 'hidden', background: '#237804', minHeight: 0 }}>
        {TF_LANES.map((tf) => {
          const items = visible.filter((x) => x.tf === tf);
          const confirmed = items.filter((x) => x.status === 'confirmed').length;
          const movingCount = items.filter((x) => x.status === 'moving').length;
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
                <Tooltip title={`${confirmed} volume-confirmed · ${movingCount} moving (≥3% off the reclaim) · ${items.length - confirmed - movingCount} reclaimed but flat`}>
                  <Text type="secondary" style={{ fontSize: 10, cursor: 'help' }}>
                    <span style={{ color: '#95de64' }}>{confirmed}</span>
                    {movingCount > 0 && <span style={{ color: '#ffc53d' }}> ◆{movingCount}</span>}
                    <span> /{items.length}</span>
                  </Text>
                </Tooltip>
              </div>
              <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
                {items.length === 0 ? (
                  <div style={{ padding: '14px 8px', textAlign: 'center' }}>
                    <Text type="secondary" style={{ fontSize: 10, color: '#3f4a40' }}>
                      no reclaims
                    </Text>
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
      {visible.length === 0 && (
        <div
          style={{
            flex: '0 0 auto', padding: '5px 10px', background: '#0f1a12',
            borderTop: '1px solid #237804', textAlign: 'center',
          }}
        >
          <Text type="secondary" style={{ fontSize: 11 }}>
            Armed — waiting for a bar to close at/below both EMAs, then clear them on volume.
            Rows clear at the midnight-ET roll, so overnight and quiet sessions read empty.
          </Text>
        </div>
      )}
    </div>
  );
}

import { Typography, Tooltip } from 'antd';
import type { CatalystInfo, MacdMomoItem, TradingSession } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { CatalystBadge } from '../common/CatalystBadge';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { fmtPrice, isFreshArrival } from '../../utils/format';

const { Text } = Typography;

// ⤴ MACD MOMO (2026-08-06) — the operator's live second-leg strategy as the
// default tab. One row per top gainer of the session (top-10 ∪ ≥30%, sticky
// for the ET day) with its live MACD 3/10/8 state on 5m closes. The row to
// act on is CURLING: the line has turned up toward its signal with most of
// the gap closed — the operator's measured entry moment (validated on the
// 08-05 leaders: INLF 10:35 ET → +47%/60m, ZYBT 11:00 ET → +136%/30m).
// Attention surface only — no sounds, no Telegram; grading via tier_events
// tier='macd' decides any promotion.

const STATE_STYLE: Record<MacdMomoItem['state'], {
  label: string; color: string; border: string; dim: boolean;
}> = {
  curling: { label: '⤴ curling', color: '#ffc53d', border: '#d48806', dim: false },
  crossed: { label: '✚ crossed', color: '#95de64', border: '#52c41a', dim: false },
  turning: { label: '↻ turning', color: '#d4b106', border: '#7c6e14', dim: true },
  cooling: { label: 'cooling', color: '#8c8c8c', border: '#3a3a3a', dim: true },
  warming: { label: 'warming…', color: '#5c5c5c', border: '#2a2a2a', dim: true },
};

const STATE_TIP: Record<MacdMomoItem['state'], string> = {
  curling: 'SETUP live: the MACD line (3/10/8 SMA, 5m closes) has turned up toward its signal with most of the pullback gap closed — the "close to the crossover" entry moment. Tight stop; the line can still fail back down.',
  crossed: 'The MACD line closed above its signal — the crossover happened. Later than the curl entry.',
  turning: 'Line rising below the signal but the curl is not announce-worthy yet (gap still wide or turn too young).',
  cooling: 'Line falling below the signal — mid-pullback / post-fade. The reset that precedes the next curl.',
  warming: 'Not enough closed 5m bars yet to compute the MACD (needs ~18).',
};

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '?';
  return ms < 60_000 ? `${Math.round(ms / 1000)}s`
    : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m`
    : `${(ms / 3_600_000).toFixed(1)}h`;
}

function MomoRow({ item, selected, onSelect, onOpenCatalyst, session }: {
  item: MacdMomoItem;
  selected: boolean;
  onSelect: (t: string) => void;
  onOpenCatalyst: () => void;
  session?: TradingSession;
}) {
  const st = STATE_STYLE[item.state];
  const afterHours = session === 'afterhours';
  // A setup announced in the last ~10 min pulses — that is the acting window.
  const freshSetup = item.state === 'curling' && isFreshArrival(item.setup_at, 600);
  const freshCross = item.state === 'crossed' && isFreshArrival(item.cross_at, 300);
  return (
    <div
      onClick={() => onSelect(item.ticker)}
      className={freshSetup || freshCross ? 'ema-confirm-fresh' : undefined}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 8px', borderBottom: '1px solid #1f1f1f', cursor: 'pointer',
        borderLeft: `3px solid ${st.border}`,
        background: selected ? '#15395b' : undefined,
        opacity: st.dim ? 0.65 : 1,
      }}
    >
      <span style={{ flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <span style={{ marginRight: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
          <TickerLinks ticker={item.ticker} />
        </span>
        <TickerLink
          ticker={item.ticker}
          onSelect={onSelect}
          stopPropagation
          style={{ color: st.dim ? '#8c8c8c' : st.color, fontWeight: 600, fontSize: 13 }}
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
        <Tooltip title={STATE_TIP[item.state]}>
          <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 600, color: st.color, cursor: 'help' }}>
            {st.label}
            {item.state === 'curling' && item.gap_pct != null && ` · gap ${item.gap_pct.toFixed(2)}%`}
          </span>
        </Tooltip>
        {item.below_zero === true && item.state !== 'cooling' && (
          <Tooltip title="MACD line still below ZERO — the deep post-pullback reset the best second legs curl out of">
            <span style={{ marginLeft: 5, fontSize: 9, color: '#69c0ff', cursor: 'help', fontWeight: 700 }}>&lt;0</span>
          </Tooltip>
        )}
        {item.setup_at && (
          <Tooltip title="Latest ⤴ setup today (bar close time — matches the TV chart)">
            <span style={{ marginLeft: 6, fontSize: 10, color: '#8c8c8c', cursor: 'help' }}>
              ⤴ {fmtAgo(item.setup_at)}
            </span>
          </Tooltip>
        )}
        {item.cross_at && (
          <Tooltip title="Latest ✚ crossover today (bar close time)">
            <span style={{ marginLeft: 5, fontSize: 10, color: '#8c8c8c', cursor: 'help' }}>
              ✚ {fmtAgo(item.cross_at)}
            </span>
          </Tooltip>
        )}
      </span>
      <span style={{ flex: '0 0 auto', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {item.chg_pct != null && (
          <Tooltip
            title={
              afterHours
                ? 'FULL-DAY change vs the prior close. ⚠️ Momentum/Ignition show AFTER-HOURS change in this session — different anchor.'
                : 'Day change vs the prior close — how much of the move has already happened.'
            }
          >
            <Text
              style={{
                fontSize: 11, marginRight: 6, cursor: 'help', fontWeight: 600,
                color: item.chg_pct >= 20 ? '#ff7a45'
                  : item.chg_pct > 0 ? '#52c41a'
                  : item.chg_pct < 0 ? '#ff4d4f' : '#8c8c8c',
              }}
            >
              {item.chg_pct >= 0 ? '+' : ''}{item.chg_pct.toFixed(1)}%
              {afterHours && (
                <span style={{ fontSize: 8, opacity: 0.7, marginLeft: 1, verticalAlign: 'super' }}>d</span>
              )}
            </Text>
          </Tooltip>
        )}
        <Text type="secondary" style={{ fontSize: 11 }}>{fmtPrice(item.price)}</Text>
      </span>
    </div>
  );
}

export function MacdMomoPanel({ items, onOpenCatalyst, session }: {
  items: MacdMomoItem[];
  onOpenCatalyst: (ticker: string, catalyst: CatalystInfo | null) => void;
  session?: TradingSession;
}) {
  const { selected, setSelected } = useSelection();
  const { hidden } = useHiddenTickers();
  const visible = items.filter((x) => !hidden.has(x.ticker));
  const curling = visible.filter((x) => x.state === 'curling').length;
  const crossed = visible.filter((x) => x.state === 'crossed').length;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div
        style={{
          padding: '4px 10px', background: '#1f1a0a', borderBottom: '1px solid #d48806',
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flex: '0 0 auto',
        }}
      >
        <Tooltip title="The session's top gainers (top-10 by day change ∪ anything ≥30%, sticky for the ET day) with their live MACD 3/10/8 state on 5m closes. Act on ⤴ CURLING — the line turning up toward its signal after the pullback reset.">
          <Text style={{ color: '#ffc53d', fontSize: 11, fontWeight: 600, cursor: 'help' }}>
            ⤴ TOP GAINERS · MACD 3/10/8
          </Text>
        </Tooltip>
        <Text type="secondary" style={{ fontSize: 10 }}>
          {curling > 0 && <span style={{ color: '#ffc53d', fontWeight: 600 }}>⤴{curling} </span>}
          {crossed > 0 && <span style={{ color: '#95de64' }}>✚{crossed} </span>}
          <span>/{visible.length}</span>
        </Text>
      </div>
      <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
        {visible.length === 0 ? (
          <div style={{ padding: '18px 10px', textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              No top gainers qualified yet today (top-10 needs ≥10% · anyone at ≥30%).
              The set fills as the session's leaders emerge and resets at midnight ET.
            </Text>
          </div>
        ) : (
          visible.map((x) => (
            <MomoRow
              key={x.ticker}
              item={x}
              selected={x.ticker === selected}
              onSelect={setSelected}
              onOpenCatalyst={() => onOpenCatalyst(x.ticker, x.catalyst ?? null)}
              session={session}
            />
          ))
        )}
      </div>
      <div
        style={{
          flex: '0 0 auto', padding: '4px 10px', background: '#141414',
          borderTop: '1px solid #303030',
        }}
      >
        <Text type="secondary" style={{ fontSize: 10 }}>
          Second legs on the day's leaders: cooling → the line resets (often &lt;0) → ⤴ curls toward
          the signal (entry, tight stop) → ✚ crosses. Closed 5m bars, TV-parity
          (&quot;wait for close&quot;). No sounds/Telegram — grading decides promotion.
        </Text>
      </div>
    </div>
  );
}

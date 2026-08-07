import { Typography, Tooltip } from 'antd';
import type { CatalystInfo, MacdMomoItem, TradingSession } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { CatalystBadge } from '../common/CatalystBadge';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { fmtPrice, isFreshArrival } from '../../utils/format';

const { Text } = Typography;

// Tooltips open only on a DELIBERATE hover (2026-08-06, operator's ask):
// the antd default (0.1s) popped explainers on every mouse pass across the
// list, and near the top of the panel they flip BELOW the row and blanket
// the rows being scanned. 0.7s keeps them one dwell away without ambushing.
const TIP_DELAY = 0.7;

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
  curling: 'SETUP live: the MACD line (3/10/8 SMA, 5m) has turned up toward its signal with most of the pullback gap closed — the "close to the crossover" entry moment. Tight stop; the line can still fail back down.',
  crossed: 'The MACD line is above its signal — the crossover happened. Later than the curl entry. State includes the live forming bar (matches the TV panel); ⤴/✚ event stamps stay closed-bar.',
  turning: 'Line rising below the signal but the curl is not announce-worthy yet (gap still wide or turn too young). Rendered on the live forming bar, like TV.',
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
        <Tooltip mouseEnterDelay={TIP_DELAY} title={STATE_TIP[item.state]}>
          <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 600, color: st.color, cursor: 'help' }}>
            {st.label}
            {item.state === 'curling' && item.gap_pct != null && ` · gap ${item.gap_pct.toFixed(2)}%`}
          </span>
        </Tooltip>
        {item.below_zero === true && (
          <Tooltip mouseEnterDelay={TIP_DELAY} title={item.state === 'crossed'
            ? 'Born below ZERO: this cross originated under the MACD zero line — the deep-reset class the operator rates highest. Ranked first within its state.'
            : 'MACD line below ZERO — the deep post-pullback reset the best second legs curl out of. Ranked first within its state.'}
          >
            <span
              style={{
                marginLeft: 5, fontSize: 9, fontWeight: 700, cursor: 'help',
                padding: '0 4px', borderRadius: 3,
                background: '#111d2c', color: '#69c0ff', border: '1px solid #2b4a6f',
              }}
            >
              &lt;0
            </span>
          </Tooltip>
        )}
        {item.bar_age_min != null && item.bar_age_min >= 10 && (
          <Tooltip mouseEnterDelay={TIP_DELAY} title={`Thin tape on our feed: the last real print closed ${item.bar_age_min}m ago — the state is projected from the live price across the quiet stretch. Verify on the chart.`}>
            <span style={{ marginLeft: 5, fontSize: 9, color: '#595959', cursor: 'help' }}>⏱{item.bar_age_min}m</span>
          </Tooltip>
        )}
        {item.setup_at && (
          <Tooltip mouseEnterDelay={TIP_DELAY} title="Latest ⤴ setup today (bar close time — matches the TV chart)">
            <span style={{ marginLeft: 6, fontSize: 10, color: '#8c8c8c', cursor: 'help' }}>
              ⤴ {fmtAgo(item.setup_at)}
            </span>
          </Tooltip>
        )}
        {item.cross_at && (
          <Tooltip mouseEnterDelay={TIP_DELAY} title="Latest ✚ crossover today (bar close time)">
            <span style={{ marginLeft: 5, fontSize: 10, color: '#8c8c8c', cursor: 'help' }}>
              ✚ {fmtAgo(item.cross_at)}
            </span>
          </Tooltip>
        )}
      </span>
      <span style={{ flex: '0 0 auto', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {item.chg_pct != null && (
          <Tooltip
            mouseEnterDelay={TIP_DELAY}
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

// The two lanes (2026-08-07, operator's ask + layout choice): both of their
// TV setups side by side, same universe, independently sorted — like the
// EMA tab's timeframe lanes.
const MOMO_LANES = ['5m', '2m'] as const;
const LANE_LABEL: Record<(typeof MOMO_LANES)[number], string> = {
  '5m': '5M · 3/10/8',
  '2m': '2M · 3/15/8',
};

export function MacdMomoPanel({ items, onOpenCatalyst, session }: {
  items: MacdMomoItem[];
  onOpenCatalyst: (ticker: string, catalyst: CatalystInfo | null) => void;
  session?: TradingSession;
}) {
  const { selected, setSelected } = useSelection();
  const { hidden } = useHiddenTickers();
  const visible = items.filter((x) => !hidden.has(x.ticker));

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div
        style={{
          padding: '4px 10px', background: '#1f1a0a', borderBottom: '1px solid #d48806',
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flex: '0 0 auto',
        }}
      >
        <Tooltip mouseEnterDelay={TIP_DELAY} title="The session's top gainers (top-10 by day change ∪ anything ≥30%, sticky for the ET day) with their live MACD state on both of your setups. Act on ⤴ CURLING. Each lane sorts: ⤴ curling → ✚ crossed → turning → cooling; within a state, <0 (below-zero reset) first, then newest ⤴/✚ event first.">
          <Text style={{ color: '#ffc53d', fontSize: 11, fontWeight: 600, cursor: 'help' }}>
            ⤴ TOP GAINERS · MACD
          </Text>
        </Tooltip>
        <Text type="secondary" style={{ fontSize: 10 }}>
          {visible.length === 0 ? '' : `${new Set(visible.map((x) => x.ticker)).size} names`}
        </Text>
      </div>
      <div style={{ flex: '1 1 auto', display: 'flex', gap: 1, overflow: 'hidden', background: '#d48806', minHeight: 0 }}>
        {MOMO_LANES.map((lane) => {
          const inLane = visible.filter((x) => x.variant === lane);
          const curling = inLane.filter((x) => x.state === 'curling').length;
          const crossed = inLane.filter((x) => x.state === 'crossed').length;
          return (
            <div
              key={lane}
              style={{
                flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column',
                background: '#0a0a0a', overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '3px 8px', background: '#141010', borderBottom: '1px solid #614700',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flex: '0 0 auto',
                }}
              >
                <Text style={{ color: '#ffc53d', fontSize: 11, fontWeight: 600 }}>⤴ {LANE_LABEL[lane]}</Text>
                <Text type="secondary" style={{ fontSize: 10 }}>
                  {curling > 0 && <span style={{ color: '#ffc53d', fontWeight: 600 }}>⤴{curling} </span>}
                  {crossed > 0 && <span style={{ color: '#95de64' }}>✚{crossed} </span>}
                  <span>/{inLane.length}</span>
                </Text>
              </div>
              <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
                {inLane.length === 0 ? (
                  <div style={{ padding: '18px 10px', textAlign: 'center' }}>
                    <Text type="secondary" style={{ fontSize: 10, color: '#3f3a30' }}>
                      {lane === '2m'
                        ? 'warming — the 3/15/8 needs ~46 min of banked 2m tape per name'
                        : 'no top gainers qualified yet'}
                    </Text>
                  </div>
                ) : (
                  inLane.map((x) => (
                    <MomoRow
                      key={`${x.variant}|${x.ticker}`}
                      item={x}
                      selected={x.ticker === selected}
                      onSelect={setSelected}
                      onOpenCatalyst={() => onOpenCatalyst(x.ticker, x.catalyst ?? null)}
                      session={session}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          flex: '0 0 auto', padding: '4px 10px', background: '#141414',
          borderTop: '1px solid #303030',
        }}
      >
        <Text type="secondary" style={{ fontSize: 10 }}>
          Second legs on the day's leaders: cooling → the line resets (often &lt;0) → ⤴ curls toward
          the signal (entry, tight stop) → ✚ crosses. Closed bars, TV-parity
          (&quot;wait for close&quot;). No sounds/Telegram — grading decides promotion.
        </Text>
      </div>
    </div>
  );
}

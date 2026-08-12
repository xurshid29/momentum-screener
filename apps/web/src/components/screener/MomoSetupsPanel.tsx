import { Tooltip, Typography } from 'antd';
import type { CatalystInfo, MomoSetupContext, MomoSetupItem, TradingSession } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { CatalystBadge } from '../common/CatalystBadge';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { fmtPrice, isFreshArrival } from '../../utils/format';

const { Text } = Typography;
const TIP_DELAY = 0.7;

const STATE: Record<MomoSetupItem['state'], { label: string; color: string; bg: string; tip: string }> = {
  warming: { label: 'WARMING', color: '#595959', bg: '#111', tip: 'Waiting for enough closed 5m/2m bars.' },
  resetting: { label: 'RESETTING', color: '#8c8c8c', bg: '#171717', tip: 'The 5m MACD faded; waiting for a meaningful pullback.' },
  basing: { label: 'BASING', color: '#69c0ff', bg: '#111d2c', tip: 'Pullback depth is meaningful and price has stopped making a fresh low.' },
  curling: { label: 'CURLING', color: '#ffc53d', bg: '#2b2111', tip: 'A closed 5m MACD curl exists, but structure or stop distance is not ready yet.' },
  ready: { label: 'READY', color: '#b7eb8f', bg: '#162312', tip: '5m curl plus an acceptable pullback/base. Waiting for a closed 2m pivot break with volume.' },
  triggered: { label: 'TRIGGERED', color: '#52c41a', bg: '#10250f', tip: 'A closed 2m bar broke the local pivot with at least 1.5× volume and $2k feed notional.' },
  failed: { label: 'FAILED', color: '#ff7875', bg: '#2a1215', tip: 'The pullback low broke or the setup expired before a valid trigger.' },
};

const CONTEXT: Record<MomoSetupContext, { short: string; color: string }> = {
  warming: { short: '—', color: '#434343' }, cooling: { short: '↓', color: '#8c8c8c' },
  turning: { short: '↻', color: '#d4b106' }, curling: { short: '⤴', color: '#ffc53d' },
  crossing: { short: '≈', color: '#b7eb8f' }, crossed: { short: '✓', color: '#52c41a' },
};

function pct(v: number | null, digits = 1): string {
  return v == null ? '—' : `${v.toFixed(digits)}%`;
}

function ContextChip({ tf, value }: { tf: string; value: MomoSetupContext }) {
  const c = CONTEXT[value];
  return (
    <Tooltip mouseEnterDelay={TIP_DELAY} title={`${tf} MACD: ${value}${value === 'crossing' ? ' (forming bar only)' : ''}`}>
      <span style={{ fontSize: 9, color: c.color, border: `1px solid ${c.color}`, borderRadius: 3, padding: '0 3px', marginRight: 3 }}>
        {tf}{c.short}
      </span>
    </Tooltip>
  );
}

export function MomoSetupsPanel({ items, onOpenCatalyst, session }: {
  items: MomoSetupItem[];
  onOpenCatalyst: (ticker: string, catalyst: CatalystInfo | null) => void;
  session?: TradingSession;
}) {
  const { selected, setSelected } = useSelection();
  const { hidden } = useHiddenTickers();
  const visible = items.filter((x) => !hidden.has(x.ticker));
  const actionable = visible.filter((x) => x.state === 'ready' || x.state === 'triggered').length;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '5px 10px', background: '#101d17', borderBottom: '1px solid #237804', display: 'flex', justifyContent: 'space-between' }}>
        <Tooltip mouseEnterDelay={TIP_DELAY} title="Experimental, closed-bar setup layer. 5m MACD supplies the curl; pullback structure and 2m price/volume confirm it. Dashboard only: no sound or Telegram alerts.">
          <Text style={{ color: '#95de64', fontSize: 11, fontWeight: 700, cursor: 'help' }}>🎯 MOMO SETUPS · EXPERIMENTAL</Text>
        </Tooltip>
        <Text type="secondary" style={{ fontSize: 10 }}>{actionable ? `${actionable} actionable · ` : ''}{visible.length} names</Text>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(250px,1.5fr) 80px 85px 100px 105px 85px', gap: 6, padding: '3px 8px', color: '#595959', fontSize: 9, borderBottom: '1px solid #262626' }}>
        <span>TICKER · STATE · CONTEXT</span><span>PULLBACK</span><span>VOLUME</span><span>TRIGGER / ENTRY</span><span>STOP</span><span>DAY / PRICE</span>
      </div>
      <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
        {visible.map((item) => {
          const st = STATE[item.state];
          const fresh = (item.state === 'triggered' && isFreshArrival(item.trigger_at, 600))
            || (item.state === 'ready' && isFreshArrival(item.state_at, 600));
          return (
            <div
              key={item.ticker}
              onClick={() => setSelected(item.ticker)}
              className={fresh ? 'ema-confirm-fresh' : undefined}
              style={{
                display: 'grid', gridTemplateColumns: 'minmax(250px,1.5fr) 80px 85px 100px 105px 85px',
                gap: 6, alignItems: 'center', padding: '6px 8px', cursor: 'pointer',
                borderBottom: '1px solid #1f1f1f', borderLeft: `3px solid ${st.color}`,
                background: selected === item.ticker ? '#15395b' : st.bg,
                opacity: item.state === 'failed' || item.state === 'warming' ? 0.65 : 1,
              }}
            >
              <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <span style={{ marginRight: 5, display: 'inline-flex', verticalAlign: 'middle' }}><TickerLinks ticker={item.ticker} /></span>
                <TickerLink ticker={item.ticker} onSelect={setSelected} stopPropagation style={{ color: st.color, fontWeight: 700, fontSize: 13 }} />
                {(item.catalyst || item.news_title) && (
                  <span onClick={(e) => { e.stopPropagation(); onOpenCatalyst(item.ticker, item.catalyst); }} style={{ marginLeft: 4, display: 'inline-flex', verticalAlign: 'middle' }}>
                    <CatalystBadge score={item.catalyst?.score ?? null} hype={item.catalyst?.hype} reason={item.catalyst?.reason} type={item.catalyst?.type} onOpen={() => onOpenCatalyst(item.ticker, item.catalyst)} size={12} />
                  </span>
                )}
                <Tooltip mouseEnterDelay={TIP_DELAY} title={item.failure_reason ?? st.tip}>
                  <span style={{ marginLeft: 7, color: st.color, fontSize: 10, fontWeight: 700, cursor: 'help' }}>{st.label}{item.setup_number > 0 ? ` #${item.setup_number}` : ''}</span>
                </Tooltip>
                <span style={{ marginLeft: 7 }}>
                  <ContextChip tf="15" value={item.context_15m} />
                  <ContextChip tf="5" value={item.context_5m} />
                  <ContextChip tf="2" value={item.context_2m} />
                </span>
                {item.below_zero && <span style={{ marginLeft: 3, fontSize: 9, color: '#69c0ff' }}>&lt;0</span>}
                {item.above_ema21 && <span style={{ marginLeft: 3, fontSize: 9, color: '#95de64' }}>✓21</span>}
                {item.feed_age_min != null && item.feed_age_min >= 6 && <span style={{ marginLeft: 4, fontSize: 9, color: '#595959' }}>⏱{item.feed_age_min}m</span>}
              </span>
              <Tooltip mouseEnterDelay={TIP_DELAY} title={`${item.base_bars} closed 5m bar(s) since the pullback low`}><span style={{ color: '#d9d9d9', fontSize: 11 }}>{pct(item.pullback_depth_pct)} · {item.base_bars}b</span></Tooltip>
              <Tooltip mouseEnterDelay={TIP_DELAY} title="Dry-up is base volume ÷ pre-low volume. Re-expansion is trigger-bar volume ÷ the prior 2m median."><span style={{ color: '#d9d9d9', fontSize: 11 }}>{item.volume_dryup_ratio == null ? '—' : `${item.volume_dryup_ratio.toFixed(1)}× dry`}{item.volume_reexpansion_ratio != null ? ` · ${item.volume_reexpansion_ratio.toFixed(1)}×` : ''}</span></Tooltip>
              <span style={{ fontSize: 11, color: item.entry != null ? '#52c41a' : '#d9d9d9' }}>{item.trigger != null ? fmtPrice(item.trigger) : '—'}{item.entry != null ? ` / ${fmtPrice(item.entry)}` : ''}</span>
              <Tooltip mouseEnterDelay={TIP_DELAY} title="Structure invalidation at the pullback low; stop distance is measured from the trigger entry when available."><span style={{ fontSize: 11, color: (item.stop_distance_pct ?? 0) > 10 ? '#ff7875' : '#d9d9d9' }}>{item.stop != null ? fmtPrice(item.stop) : '—'} · {pct(item.stop_distance_pct)}</span></Tooltip>
              <span style={{ textAlign: 'right', fontSize: 11 }}>
                {item.chg_pct != null && <span style={{ color: item.chg_pct >= 0 ? '#52c41a' : '#ff4d4f', marginRight: 5 }}>{item.chg_pct >= 0 ? '+' : ''}{item.chg_pct.toFixed(1)}%{session === 'afterhours' ? 'ᵈ' : ''}</span>}
                <Text type="secondary" style={{ fontSize: 11 }}>{fmtPrice(item.price)}</Text>
              </span>
            </div>
          );
        })}
        {visible.length === 0 && <div style={{ padding: 20, color: '#595959', textAlign: 'center' }}>No qualified setup candidates yet.</div>}
      </div>
    </div>
  );
}

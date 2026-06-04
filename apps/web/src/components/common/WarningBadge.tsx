// "Avoid / burned" warning marker — a ⛔ next to a ticker that pump-and-dumped.
// Two sources, surfaced together (see useTickerWarnings):
//   • manual — the operator flagged it (permanent avoid-list)
//   • auto   — detected from screener_outcomes (spiked then closed deeply red)
// Tooltip explains which, with the auto stats. Lives in common/ because every
// screen surface (Momentum / Ignition / Continuation / Swing / Quote Details)
// renders it next to the ticker symbol, like ShelfBadge.

import { Tooltip } from 'antd';
import { useTickerWarnings } from '../../hooks/useTickerWarnings';

interface Props {
  ticker: string;
  size?: number;
}

export function WarningBadge({ ticker, size = 13 }: Props) {
  const { warning } = useTickerWarnings();
  const w = warning(ticker);
  if (!w) return null;

  const parts: string[] = [];
  if (w.manual) parts.push(`Manually flagged as burned${w.manualNote ? ` — ${w.manualNote}` : ''}.`);
  if (w.auto && w.burned) {
    parts.push(
      `Pump-and-dump history: ${w.burned.events} event${w.burned.events === 1 ? '' : 's'} ` +
        `(peak +${w.burned.max_peak ?? '?'}% → closed ${w.burned.worst_chg ?? '?'}%, ` +
        `avg drawdown ${w.burned.avg_drawdown ?? '?'}%; last ${w.burned.last_event}).`,
    );
  }
  const title = `⛔ Avoid — ${parts.join(' ')}`;

  return (
    <Tooltip title={title}>
      <span style={{ cursor: 'help', fontSize: size, lineHeight: 1, marginLeft: 2 }}>⛔</span>
    </Tooltip>
  );
}

// Hook-free predicate for callers that need to dim a row — re-evaluates the
// shared warnings cache. Returns true when the ticker carries any warning.
export function useIsWarned(): (ticker: string) => boolean {
  const { warning } = useTickerWarnings();
  return (ticker: string) => warning(ticker) != null;
}

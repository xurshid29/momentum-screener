// Finviz + TradingView quick-link pair. Lives in common/ because the
// Momentum, Swing, and Continuation tables all render the same two icons in
// their leftmost column. Accepts an optional explicit finvizUrl (the
// enriched payload supplies one with the auth params already wired); falls
// back to the public quote URL for tickers we don't have a row for (e.g.
// a Continuation entry whose ticker dropped off the live screens).

import { Space } from 'antd';

interface Props {
  ticker: string;
  finvizUrl?: string;
}

export function TickerLinks({ ticker, finvizUrl }: Props) {
  const fv = finvizUrl ?? `https://elite.finviz.com/quote?t=${encodeURIComponent(ticker)}&ty=c&p=h&b=1`;
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(ticker)}`;
  return (
    <Space size={4} onClick={(e) => e.stopPropagation()}>
      <a href={fv} target="_blank" rel="noreferrer" className="screener-link-btn">
        <img src="/finviz-icon.png" alt="Finviz" />
      </a>
      <a href={tv} target="_blank" rel="noreferrer" className="screener-link-btn">
        <img src="/tradingview-icon.png" alt="TradingView" />
      </a>
    </Space>
  );
}

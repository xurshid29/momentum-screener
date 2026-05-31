// One-click "add to / remove from watchlist" star. Dropped into every row
// surface (Momentum / Swing / Continuation tables, the Ignition sidebar, and
// the Quote Details header) so a ticker can be captured from anywhere without
// a form. Filled gold = on the watchlist (click removes); hollow = not on it
// (click adds with the default +2-day expiry). Reads/writes the shared
// useWatchlist cache, so the star state stays consistent across all surfaces.

import { StarFilled, StarOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';
import type { MouseEvent } from 'react';
import { useWatchlist } from '../../hooks/useWatchlist';

interface Props {
  ticker: string;
  size?: number;   // icon font-size px. Default 14 (table density).
}

export function WatchlistStar({ ticker, size = 14 }: Props) {
  const { has, toggle } = useWatchlist();
  const on = has(ticker);

  const onClick = (e: MouseEvent) => {
    // Don't let the click also select the row / follow a link.
    e.stopPropagation();
    e.preventDefault();
    toggle(ticker);
  };

  return (
    <Tooltip title={on ? 'Remove from watchlist' : 'Add to watchlist (2d)'}>
      <span
        onClick={onClick}
        role="button"
        style={{
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          color: on ? '#fadb14' : '#666',
          fontSize: size,
          lineHeight: 1,
        }}
      >
        {on ? <StarFilled /> : <StarOutlined />}
      </span>
    </Tooltip>
  );
}

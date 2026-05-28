// Catalyst marker for a screener / sidebar row. Tier-colored fire icon
// signals strength at a glance; tooltip carries the precise score, type,
// and reason; clicking opens the catalyst/news modal upstream.
//
//   ≥70  🔥🔥 red    — major catalyst
//   40+  🔥    orange — strong
//   15+  🔥    yellow — weak
//   <15  —           — hidden
//
// score=null is shown as a dim ✨ ("classifier hasn't tagged it yet — but
// news exists; click to see"). Lives in common/ because the Momentum
// table, the Ignition sidebar, and now the Swing table all render it
// with the same logic — only the FireBadge size differs.

import type { MouseEvent } from 'react';
import { FireBadge } from './FireBadge';

interface Props {
  score: number | null;
  reason?: string;
  type?: string;
  onOpen: () => void;
  size?: number;    // FireBadge px size. Default 18 (the table density);
                    // 12 for the compact Ignition sidebar.
}

export function CatalystBadge({ score, reason, type, onOpen, size = 18 }: Props) {
  // stopPropagation so opening the modal doesn't also re-select the row.
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    onOpen();
  };
  if (score == null) {
    return (
      <span
        title="Catalyst score pending — click for news"
        onClick={open}
        style={{ marginLeft: 4, opacity: 0.55, cursor: 'pointer', fontSize: size <= 12 ? 11 : undefined }}
      >
        ✨
      </span>
    );
  }
  if (score < 15) return null;
  const tooltip = `${score} · ${type ?? ''}${reason ? ` — ${reason}` : ''} · click for news`.trim();
  return (
    <span title={tooltip} onClick={open} style={{ marginLeft: 4, cursor: 'pointer' }}>
      <FireBadge score={score} size={size} />
    </span>
  );
}

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

// Hype ≥ this with catalyst quality < this = "pump candidate" → show the 🚀.
// The STI case: buzzword PR that scores low on quality but draws a crowd.
const HYPE_HIGH = 60;
const QUALITY_LOW = 50;

interface Props {
  score: number | null;
  hype?: number | null;
  reason?: string;
  type?: string;
  onOpen: () => void;
  size?: number;    // FireBadge px size. Default 18 (the table density);
                    // 12 for the compact Ignition sidebar.
}

export function CatalystBadge({ score, hype, reason, type, onOpen, size = 18 }: Props) {
  // stopPropagation so opening the modal doesn't also re-select the row.
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    onOpen();
  };
  // 🚀 pump marker — high hype + low catalyst quality. Rendered INDEPENDENTLY
  // of the score gate below, because the whole point is the low-quality-but-
  // hyped case (STI) that the fire badge would otherwise hide.
  const pump =
    hype != null && hype >= HYPE_HIGH && (score == null || score < QUALITY_LOW) ? (
      <span
        title={`Pump candidate — hype ${hype}, low catalyst quality. Catch the spike, don't hold. Click for news.`}
        onClick={open}
        style={{ marginLeft: 4, cursor: 'pointer', fontSize: size <= 12 ? 11 : 13 }}
      >
        🚀
      </span>
    ) : null;

  if (score == null) {
    return (
      <>
        {pump}
        <span
          title="Catalyst score pending — click for news"
          onClick={open}
          style={{ marginLeft: 4, opacity: 0.55, cursor: 'pointer', fontSize: size <= 12 ? 11 : undefined }}
        >
          ✨
        </span>
      </>
    );
  }
  if (score < 15) return pump;
  const tooltip = `${score} · ${type ?? ''}${reason ? ` — ${reason}` : ''} · click for news`.trim();
  return (
    <>
      {pump}
      <span title={tooltip} onClick={open} style={{ marginLeft: 4, cursor: 'pointer' }}>
        <FireBadge score={score} size={size} />
      </span>
    </>
  );
}

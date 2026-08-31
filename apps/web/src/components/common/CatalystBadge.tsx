// Catalyst marker for a screener / sidebar row. Tier-colored fire icon
// signals strength at a glance; clicking opens the catalyst/news modal
// upstream (which carries the precise score, type and reason — hover
// tooltips were retired dashboard-wide 2026-08-31).
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

// 🚀 hype marker thresholds:
//   HYPE_SHOW  — show the rocket at all (notable buzzword/crowd pull)
//   HYPE_HIGH  — colour it orange (strong hype)
const HYPE_SHOW = 50;
const HYPE_HIGH = 60;

interface Props {
  score: number | null;
  hype?: number | null;
  reason?: string;
  type?: string;
  onOpen: () => void;
  size?: number;    // FireBadge px size. Default 18 (the table density);
                    // 12 for the compact Ignition sidebar.
}

// `reason`/`type` stay in Props (callers still pass them; the modal shows
// them) but are no longer read here since the hover tooltip went away.
export function CatalystBadge({ score, hype, onOpen, size = 18 }: Props) {
  // stopPropagation so opening the modal doesn't also re-select the row.
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    onOpen();
  };
  // 🚀 hype marker — shown whenever hype is notable (≥ HYPE_SHOW), rendered
  // INDEPENDENTLY of the fire-badge score gate below so the low-quality-but-
  // hyped case (STI) isn't hidden. A high-hype + low-quality name is a "pump
  // candidate" (catch the spike, don't hold); otherwise it's just elevated
  // crowd interest. The rocket dims slightly below HYPE_HIGH.
  const pump =
    hype != null && hype >= HYPE_SHOW ? (
      <span
        onClick={open}
        style={{
          marginLeft: 4,
          cursor: 'pointer',
          fontSize: size <= 12 ? 11 : 13,
          opacity: hype >= HYPE_HIGH ? 1 : 0.7,
        }}
      >
        🚀
      </span>
    ) : null;

  if (score == null) {
    return (
      <>
        {pump}
        <span
          onClick={open}
          style={{ marginLeft: 4, opacity: 0.55, cursor: 'pointer', fontSize: size <= 12 ? 11 : undefined }}
        >
          ✨
        </span>
      </>
    );
  }
  if (score < 15) return pump;
  return (
    <>
      {pump}
      <span onClick={open} style={{ marginLeft: 4, cursor: 'pointer' }}>
        <FireBadge score={score} size={size} />
      </span>
    </>
  );
}

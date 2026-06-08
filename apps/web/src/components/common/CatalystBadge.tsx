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

// 🚀 hype marker thresholds:
//   HYPE_SHOW  — show the rocket at all (notable buzzword/crowd pull)
//   HYPE_HIGH  — colour it orange (strong hype)
//   QUALITY_LOW — below this catalyst quality, a high-hype name is a "pump
//                 candidate" (the STI case: buzzword PR that draws a crowd
//                 without substance) → stronger tooltip warning.
const HYPE_SHOW = 50;
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
  // 🚀 hype marker — shown whenever hype is notable (≥ HYPE_SHOW), rendered
  // INDEPENDENTLY of the fire-badge score gate below so the low-quality-but-
  // hyped case (STI) isn't hidden. A high-hype + low-quality name is a "pump
  // candidate" (catch the spike, don't hold); otherwise it's just elevated
  // crowd interest. The rocket dims slightly below HYPE_HIGH.
  const lowQuality = score == null || score < QUALITY_LOW;
  const pump =
    hype != null && hype >= HYPE_SHOW ? (
      <span
        title={
          hype >= HYPE_HIGH && lowQuality
            ? `Pump candidate — hype ${hype}, low catalyst quality. Catch the spike, don't hold. Click for news.`
            : `Hype ${hype} — elevated crowd/pump potential. Click for news.`
        }
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

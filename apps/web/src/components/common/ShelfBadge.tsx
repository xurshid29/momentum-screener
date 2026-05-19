import { Tooltip } from 'antd';
import type { ShelfInfo, ShelfLevel } from '../../api/types';

// Dilution kill-switch marker. An effective shelf (S-3/F-3/S-1) plus a 424B
// prospectus is how a company sells stock into a spike — the recurring way a
// low-float runner dies. Inline SVG warning triangle so the tier colors are
// exact, matching FireBadge.
const TIER: Record<ShelfLevel, { color: string; label: string; desc: string }> = {
  active: {
    color: '#ff4d4f',
    label: 'Active offering',
    desc: 'A 424B prospectus filed within 90 days — shares are being sold into the move now.',
  },
  effective: {
    color: '#fa8c16',
    label: 'Effective shelf',
    desc: 'An effective shelf registration — the company can sell stock into a spike at any time.',
  },
  shelf: {
    color: '#fadb14',
    label: 'Shelf registration pending',
    desc: 'A registration statement on file — a dilution vehicle being set up.',
  },
};

export function ShelfBadge({ shelf, size = 14 }: { shelf: ShelfInfo; size?: number }) {
  const t = TIER[shelf.level];
  const title =
    `${t.label} — ${shelf.latest_form}, ${shelf.days_since}d ago. ${t.desc} ` +
    `Forms seen: ${shelf.forms.join(', ')}.`;
  return (
    // Click — not hover — to open: the triangle sits inside clickable rows, so
    // stopPropagation keeps a click from also selecting the row.
    <Tooltip title={title} trigger="click">
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        onClick={(e) => e.stopPropagation()}
        style={{ display: 'inline-block', verticalAlign: 'middle', marginTop: -2, cursor: 'pointer' }}
      >
        <path fill={t.color} d="M8 2 L15 14.5 L1 14.5 Z" />
        <rect x="7.15" y="6" width="1.7" height="4.2" fill="#1f1f1f" />
        <circle cx="8" cy="12" r="1" fill="#1f1f1f" />
      </svg>
    </Tooltip>
  );
}

// Tier-colored fire icon for the screener row. Single flame at weak/strong,
// double flame at major. Inline SVG so the colors are exact across browsers
// and emoji fonts don't interfere.

interface Props {
  score: number;
  size?: number;       // px height, defaults to 14
}

export function FireBadge({ score, size = 14 }: Props) {
  if (score < 15) return null;
  const { color, count } = tier(score);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 0, verticalAlign: 'middle' }}>
      {Array.from({ length: count }).map((_, i) => (
        <Flame key={i} color={color} size={size} />
      ))}
    </span>
  );
}

function tier(score: number): { color: string; count: number } {
  if (score >= 70) return { color: '#ff4d4f', count: 2 };  // double red — major
  if (score >= 40) return { color: '#fa8c16', count: 1 };  // orange — strong
  return { color: '#fadb14', count: 1 };                   // yellow — weak
}

function Flame({ color, size }: { color: string; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block' }}
    >
      <path
        d="M16 2 C18 6 22 10 22 15 C22 17 21 18 19 18 C19 16 18 14 17 14 C18 18 14 19 14 23 C14 24 14.5 25 16 25 C12 27 8 24 8 19 C8 14 12 12 12 8 C13 9 14 10 14 13 C15 9 16 6 16 2 Z"
        fill={color}
      />
    </svg>
  );
}

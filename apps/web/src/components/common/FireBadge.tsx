// Tier-colored fire icon. Inline SVG so the colors are exact and emoji
// fonts can't interfere. Sits on the baseline cleanly inside compact
// table rows.

interface Props {
  score: number;
  size?: number;       // px height, defaults to 18
}

export function FireBadge({ score, size = 18 }: Props) {
  if (score < 15) return null;
  const { color, count } = tier(score);
  return (
    <span
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        lineHeight: 0,
        marginTop: -2, // optical centering against capital-letter text
      }}
    >
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
      viewBox="0 0 16 16"
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      <path
        fill={color}
        d="M8 1.5 C5 4 2.5 7 2.5 10.5 C2.5 13.2 4.8 15 8 15 C11.2 15 13.5 13.2 13.5 10.5 C13.5 8 11.5 6.5 10 4.5 C10 6.5 9 7 8 7.5 C8 5.5 8.5 3.5 8 1.5 Z"
      />
    </svg>
  );
}

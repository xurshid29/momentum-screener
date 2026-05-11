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
        d="M8 1.5 C6.4 4 5 5.4 5 7.6 C5 8.5 5.4 9 6.1 9 C6.1 7.8 6.6 6.7 7.3 6.4 C7 8.4 5 9.4 5 11.6 C5 13.4 6.3 14.5 8 14.5 C9.7 14.5 11 13.4 11 11.6 C11 9 8.5 7.5 8.5 5 C8.5 3.7 8.4 2.5 8 1.5 Z"
      />
    </svg>
  );
}

// Tier-colored badge for a catalyst score. Shared by the news-row analyze
// button and the screener's catalyst column so the colors stay in sync.

interface Props {
  score: number;
  size?: 'sm' | 'md';
}

export function ScoreBadge({ score, size = 'md' }: Props) {
  const isSm = size === 'sm';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: isSm ? 18 : 22,
        height: isSm ? 14 : 16,
        padding: isSm ? '0 3px' : '0 4px',
        fontSize: isSm ? 10 : 11,
        fontWeight: 700,
        color: '#fff',
        background: tierBg(score),
        borderRadius: 3,
        lineHeight: 1,
        verticalAlign: 'middle',
      }}
    >
      {score}
    </span>
  );
}

export function tierBg(score: number): string {
  if (score >= 70) return '#cf1322';  // red — major catalyst
  if (score >= 40) return '#d48806';  // gold — strong
  if (score >= 15) return '#0958d9';  // blue — weak
  return '#595959';                    // gray — noise
}

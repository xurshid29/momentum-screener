// Shared P&L formatting + colors for the trade journal.

export const PROFIT = '#52c41a';
export const LOSS = '#ff4d4f';
export const NEUTRAL = '#8c8c8c';

export function pnlColor(n: number): string {
  if (n > 0) return PROFIT;
  if (n < 0) return LOSS;
  return NEUTRAL;
}

// Subtle cell tint behind a P&L value.
export function pnlTint(n: number): string {
  if (n > 0) return 'rgba(82,196,26,0.10)';
  if (n < 0) return 'rgba(255,77,79,0.10)';
  return 'transparent';
}

export function money(n: number, withSign = false): string {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? '-' : withSign && n > 0 ? '+' : '';
  return `${sign}$${abs}`;
}

// Compact form for tight calendar cells: $1,234 (no cents), $1.2k above 10k.
export function moneyCompact(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
}

// Unambiguous TradingView chart links (the SPRO lesson, 2026-07-24: TV
// resolved the bare symbol to CBOE's "S&P 500 Buffer Protect Index" instead
// of the Nasdaq stock). The API serves SEC's Nasdaq-listed ticker set; those
// get an explicit NASDAQ: prefix. Everything else stays bare — SEC lumps
// NYSE American/Arca under "NYSE" while TV files those under AMEX:, so a
// blind prefix would break Arca names. Loads lazily on first link render;
// links are bare until the set arrives and upgrade on the next re-render.
import { apiClient } from './client';

let nasdaq: Set<string> | null = null;
let loading = false;

function ensureLoaded(): void {
  if (nasdaq || loading) return;
  loading = true;
  apiClient.get<string[]>('/api/screener/tv-map')
    .then((r) => { nasdaq = new Set(r.data ?? []); })
    .catch(() => { loading = false; /* retry on a later render */ });
}

export function tvChartUrl(ticker: string): string {
  ensureLoaded();
  const t = ticker.toUpperCase();
  const sym = nasdaq?.has(t) ? `NASDAQ:${t}` : t;
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`;
}

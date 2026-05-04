// UniverseService — keeps an in-memory Set of tickers matching the *structural*
// part of the screener filter (float / price / industry / etc.), regardless of
// momentum. Used by the News Room "Universe News" tab so news for stocks the
// user might trade pre-market is surfaced even when the screener is empty.
//
// Refreshes every 10 min. Single-instance, like PollerService.

import { parseCsv } from './finviz.js';
import { poller } from './poller.js';

const FINVIZ_BASE = 'https://elite.finviz.com';
const UA = 'Mozilla/5.0';
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

// Sub-filters that describe momentum / intraday state rather than the universe
// of tradeable instruments. These get stripped when deriving the universe
// filter from the active screener filter.
const MOMENTUM_PREFIXES = [
  'sh_relvol_',
  'sh_curvol_',
  'ta_change_',
  'ta_changeopen_',
  'ta_perf_',
  'ta_perf2_',
  'ta_volatility_',
  'ta_gap_',
];

export function deriveUniverseFilter(activeFilter: string): string {
  return activeFilter
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f && !MOMENTUM_PREFIXES.some((p) => f.startsWith(p)))
    .join(',');
}

class UniverseService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private tickers = new Set<string>();
  private lastFilter = '';
  private lastRefreshedAt: Date | null = null;
  private lastError: string | null = null;

  status() {
    return {
      running: this.running,
      ticker_count: this.tickers.size,
      last_filter: this.lastFilter,
      last_refreshed_at: this.lastRefreshedAt?.toISOString() ?? null,
      last_error: this.lastError,
    };
  }

  getUniverse(): Set<string> {
    return this.tickers;
  }

  isInUniverse(ticker: string): boolean {
    return this.tickers.has(ticker.toUpperCase());
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[universe] starting (every ${REFRESH_INTERVAL_MS / 60000}m)`);
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const activeFilter = poller.getConfig().filter;
      const universeFilter = deriveUniverseFilter(activeFilter);
      const token = process.env.FINVIZ_API_TOKEN;
      if (!token) {
        this.lastError = 'FINVIZ_API_TOKEN is not set';
        return;
      }
      const url = `${FINVIZ_BASE}/export?v=110&f=${encodeURIComponent(universeFilter)}&auth=${token}`;
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`Finviz HTTP ${res.status}`);
      const text = await res.text();
      const rows = parseCsv(text);
      // v=110 header: No, Ticker, Company, Sector, Industry, Country, ...
      const next = new Set<string>();
      for (let i = 1; i < rows.length; i++) {
        const t = rows[i][1];
        if (t) next.add(t.toUpperCase());
      }
      this.tickers = next;
      this.lastFilter = universeFilter;
      this.lastRefreshedAt = new Date();
      this.lastError = null;
      console.log(`[universe] refreshed — ${next.size} tickers (filter: ${universeFilter})`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[universe] refresh failed:', this.lastError);
    } finally {
      this.inFlight = false;
    }
  }
}

export const universe = new UniverseService();

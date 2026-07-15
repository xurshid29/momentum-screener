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
  // Prior-session close per ticker, derived from the v=110 Price + Change the
  // refresh already fetches (close = price / (1 + change%/100)). Used by the
  // tick-feed detector to measure chg% from prior close for the whole universe
  // without any extra fetch. Refreshed every cycle.
  private priorCloses = new Map<string, number>();
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

  getPriorCloses(): Map<string, number> {
    return this.priorCloses;
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
      const token = process.env.FINVIZ_API_TOKEN;
      if (!token) {
        this.lastError = 'FINVIZ_API_TOKEN is not set';
        return;
      }
      // The tick feed must cover BOTH screens' structural bands: the momentum
      // filter's (operator-configurable, e.g. price $1–25) AND the ignition
      // screen's sub-$10 band — otherwise a sub-$1 runner is invisible to the
      // per-second tiers until a screen catches it mid-flight (TGHL
      // 2026-07-15: prior close $0.66 < the $1 momentum floor; the tick feed
      // first saw it at +91%). Deduped in case the filters coincide.
      const filters = [...new Set([
        deriveUniverseFilter(poller.getConfig().filter),
        deriveUniverseFilter(poller.getIgnitionFilter()),
      ])];
      const next = new Set<string>();
      const priors = new Map<string, number>();
      for (let fi = 0; fi < filters.length; fi++) {
        // Finviz's real ceiling is ~1 req/s — space consecutive exports.
        if (fi > 0) await new Promise((r) => setTimeout(r, 1300));
        const url = `${FINVIZ_BASE}/export?v=110&f=${encodeURIComponent(filters[fi])}&auth=${token}`;
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) throw new Error(`Finviz HTTP ${res.status}`);
        const text = await res.text();
        const rows = parseCsv(text);
        // v=110 header: No, Ticker, Company, Sector, Industry, Country,
        //   Market Cap, P/E, Price, Change, Volume  → Price=8, Change=9.
        for (let i = 1; i < rows.length; i++) {
          const t = rows[i][1];
          if (!t) continue;
          const tk = t.toUpperCase();
          next.add(tk);
          // prior close = price / (1 + change%/100); change% is always vs the
          // prior close, so this holds at any time of day.
          const price = parseFloat(rows[i][8]);
          const chg = parseFloat(String(rows[i][9]).replace('%', ''));
          if (Number.isFinite(price) && price > 0 && Number.isFinite(chg) && chg > -100) {
            priors.set(tk, price / (1 + chg / 100));
          }
        }
      }
      this.tickers = next;
      this.priorCloses = priors;
      this.lastFilter = filters.join(' ∪ ');
      this.lastRefreshedAt = new Date();
      this.lastError = null;
      console.log(`[universe] refreshed — ${next.size} tickers (filters: ${this.lastFilter})`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[universe] refresh failed:', this.lastError);
    } finally {
      this.inFlight = false;
    }
  }
}

export const universe = new UniverseService();

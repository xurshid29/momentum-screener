// ShelfService — the dilution kill-switch.
//
// A loaded, *effective* shelf registration (S-3 / F-3 / S-1) plus a prospectus
// to draw it down (424B*) is a company's mechanism to sell stock into a spike.
// AEHL's F-3 went effective three days before its pump. A shelf + a 500% move
// = an offering is coming. See docs/catching-runners.md ("Risk").
//
// The poller's EDGAR client (edgar.ts) reads the getcurrent firehose, which
// only holds the ~100 most-recent filings market-wide — a few hours deep. It
// catches a shelf filed *while* a ticker is on the screener, but misses one
// loaded days earlier. This service closes that gap: for every screener
// ticker it fetches SEC's per-company submissions feed
// (data.sec.gov/submissions/CIK*.json) and looks back 12 months for shelf
// activity, exposing a sticky per-ticker dilution flag.
//
// Single-instance, in-memory + rate-limited, like UniverseService.

import { cikForTicker, SEC_USER_AGENT } from './edgar.js';

const SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';
const TIMEOUT_MS = 8000;

// How far back a filing counts. SEC's `recent` block holds up to ~1000 filings
// or one year (whichever is larger) — for the rarely-filing micro-caps this
// service targets, one year of history is comfortably inside `recent`, so the
// paginated older-filings files are never needed.
const WINDOW_DAYS = 365;
// A 424B* prospectus this recent means the shelf is being actively drawn down.
const TAKEDOWN_RECENT_DAYS = 90;
// A registration statement older than this is presumed to have gone effective
// (micro-cap S-3/F-3s are typically declared effective within a few weeks).
const REG_EFFECTIVE_DAYS = 30;

// Cache lifetimes. Shelf status moves on the scale of days; a brand-new filing
// is separately caught same-cycle by the getcurrent firehose as news.
const FRESH_MS = 12 * 60 * 60 * 1000;   // re-check a known ticker twice a day
const RETRY_MS = 15 * 60 * 1000;        // re-try a failed lookup soon
// One lookup per tick. 0.67 req/s sits far under SEC's 10 req/s fair-access
// limit and still drains a cold ~130-ticker screener in ~3 minutes.
const DRAIN_INTERVAL_MS = 1500;

// Registration statements — the shelf itself.
const REGISTRATION_RE = /^(S-1|S-3|F-1|F-3|POS AM)/;
// Prospectuses filed to actually sell shares off an effective shelf.
const PROSPECTUS_RE = /^424B/;

// Graded dilution risk, increasing severity:
//   'shelf'     — a registration statement on file, not yet known-effective
//   'effective' — the loaded gun: an effective shelf, no recent takedown
//   'active'    — a 424B* prospectus within 90d: shares are being sold now
export type ShelfLevel = 'shelf' | 'effective' | 'active';

export interface ShelfInfo {
  level: ShelfLevel;
  latest_form: string;       // most recent shelf-relevant SEC form
  latest_filed_at: string;   // its filing date, YYYY-MM-DD
  days_since: number;        // days since that filing
  forms: string[];           // distinct shelf-relevant forms seen, newest-first
}

interface ShelfFiling {
  form: string;
  date: string;       // YYYY-MM-DD
  daysSince: number;
}

interface CacheEntry {
  shelf: ShelfInfo | null;
  checkedAt: number;
  failed: boolean;
}

interface SubmissionsJson {
  filings?: { recent?: { form?: unknown[]; filingDate?: unknown[] } };
}

function isShelfForm(form: string): boolean {
  return REGISTRATION_RE.test(form) || PROSPECTUS_RE.test(form) || form === 'EFFECT';
}

// Reduce a ticker's shelf-relevant filings to a single graded verdict.
function classifyFilings(filings: ShelfFiling[]): ShelfInfo | null {
  if (filings.length === 0) return null;
  filings.sort((a, b) => b.date.localeCompare(a.date)); // newest first

  const hasTakedown = filings.some((f) => PROSPECTUS_RE.test(f.form));
  const recentTakedown = filings.some(
    (f) => PROSPECTUS_RE.test(f.form) && f.daysSince <= TAKEDOWN_RECENT_DAYS,
  );
  const hasEffect = filings.some((f) => f.form === 'EFFECT');
  // A 424B can only exist against an effective registration; an EFFECT notice
  // says so outright; an aged registration has almost certainly gone effective.
  const presumedEffective =
    hasEffect ||
    hasTakedown ||
    filings.some((f) => REGISTRATION_RE.test(f.form) && f.daysSince > REG_EFFECTIVE_DAYS);

  const level: ShelfLevel = recentTakedown
    ? 'active'
    : presumedEffective
      ? 'effective'
      : 'shelf';

  const latest = filings[0];
  return {
    level,
    latest_form: latest.form,
    latest_filed_at: latest.date,
    days_since: latest.daysSince,
    forms: [...new Set(filings.map((f) => f.form))].slice(0, 6),
  };
}

function extractShelfFilings(json: SubmissionsJson): ShelfFiling[] {
  const recent = json?.filings?.recent;
  if (!recent || !Array.isArray(recent.form) || !Array.isArray(recent.filingDate)) return [];
  const now = Date.now();
  const out: ShelfFiling[] = [];
  for (let i = 0; i < recent.form.length; i++) {
    const form = String(recent.form[i] ?? '').trim().toUpperCase();
    const date = String(recent.filingDate[i] ?? '');
    if (!form || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!isShelfForm(form)) continue;
    const daysSince = Math.floor((now - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
    if (daysSince < 0 || daysSince > WINDOW_DAYS) continue;
    out.push({ form, date, daysSince });
  }
  return out;
}

class ShelfService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private cache = new Map<string, CacheEntry>();
  private queue: string[] = [];
  private queued = new Set<string>();
  private lastError: string | null = null;

  status() {
    return {
      running: this.running,
      cached: this.cache.size,
      queued: this.queue.length,
      last_error: this.lastError,
    };
  }

  // Synchronous read of whatever is cached — null until the lookup lands.
  get(ticker: string): ShelfInfo | null {
    return this.cache.get(ticker.toUpperCase())?.shelf ?? null;
  }

  // Register the cycle's tickers; stale / unknown ones get queued for refresh.
  track(tickers: string[]): void {
    const now = Date.now();
    for (const raw of tickers) {
      const ticker = raw.toUpperCase();
      if (this.queued.has(ticker)) continue;
      const entry = this.cache.get(ticker);
      if (entry && !this.isStale(entry, now)) continue;
      this.queue.push(ticker);
      this.queued.add(ticker);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[shelf] starting (1 SEC lookup / ${DRAIN_INTERVAL_MS}ms)`);
    this.timer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  private isStale(entry: CacheEntry, now: number): boolean {
    return now - entry.checkedAt > (entry.failed ? RETRY_MS : FRESH_MS);
  }

  private async drain(): Promise<void> {
    if (this.inFlight) return; // a slow lookup spans more than one tick — skip
    const ticker = this.queue.shift();
    if (!ticker) return;
    this.queued.delete(ticker);
    this.inFlight = true;
    try {
      await this.refreshOne(ticker);
    } finally {
      this.inFlight = false;
    }
  }

  private async refreshOne(ticker: string): Promise<void> {
    try {
      const cik = await cikForTicker(ticker);
      if (cik == null) {
        // Not an SEC-listed issuer — cache "no shelf" so we stop re-querying.
        this.cache.set(ticker, { shelf: null, checkedAt: Date.now(), failed: false });
        return;
      }
      const url = `${SUBMISSIONS_BASE}/CIK${String(cik).padStart(10, '0')}.json`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SubmissionsJson;
      const shelf = classifyFilings(extractShelfFilings(json));
      this.cache.set(ticker, { shelf, checkedAt: Date.now(), failed: false });
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // Keep any prior good verdict; just mark it for a sooner retry.
      const prev = this.cache.get(ticker);
      this.cache.set(ticker, {
        shelf: prev?.shelf ?? null,
        checkedAt: Date.now(),
        failed: true,
      });
    }
  }
}

export const shelf = new ShelfService();

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// SEC EDGAR filings client.
//
// Once per cycle we pull the EDGAR "latest filings" firehose
// (browse-edgar?action=getcurrent) — a single request returning the ~100 most
// recently disseminated filings across every filer — and keep only the ones
// for tickers currently on the screener. This surfaces the catalysts the news
// aggregators miss or lag on, above all the dilution filings (424B*, S-1/S-3
// shelves, ATM prospectuses) that quietly kill a low-float runner.
//
// One request per cycle means SEC's 10 req/s fair-access limit is never in
// play. SEC still requires a descriptive User-Agent carrying a contact
// address — set SEC_EDGAR_USER_AGENT in .env.

const GETCURRENT_URL =
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=&company=&dateb=&owner=include&count=100&output=atom';
const COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

// SEC requires a descriptive User-Agent carrying a contact address on every
// request — across browse-edgar AND data.sec.gov. Exported so shelf.ts (the
// per-company submissions lookup) sends the identical UA.
export const SEC_USER_AGENT =
  process.env.SEC_EDGAR_USER_AGENT?.trim() ||
  'pnldash-momentum-screener (contact@example.com)';

const TIMEOUT_MS = 8000;
// getcurrent only ever holds very recent filings; this guard keeps a quiet
// weekend feed from surfacing a filing older than a held-overnight position.
const MAX_AGE_MS = 36 * 60 * 60 * 1000;

export interface EdgarFiling {
  ticker: string;
  form: string;          // normalized form type, e.g. '8-K', '424B5', 'SC 13D'
  title: string;         // synthesized headline for the news feed
  url: string;           // filing index page — stable and unique
  published_at: Date;    // dissemination time (entry <updated>)
  raw: unknown;
}

export interface EdgarDelta {
  filings: EdgarFiling[];      // newest first
  freshTickers: Set<string>;   // tickers with a filing newer than prevWatermark
  newWatermark: number;        // max dissemination ts seen (unix seconds)
}

// ── ticker ↔ CIK map ───────────────────────────────────────────────────────
// company_tickers.json is ~1MB and changes rarely; fetch once per day. Both
// directions are kept: cikToTicker for the getcurrent firehose (CIK → ticker),
// tickerToCik for shelf.ts's per-company submissions lookup (ticker → CIK).
let cikToTicker: Map<number, string> | null = null;
let tickerToCik: Map<string, number> | null = null;
let cikMapDay = '';

async function loadCikMap(): Promise<Map<number, string>> {
  const today = new Date().toISOString().slice(0, 10);
  if (cikToTicker && cikMapDay === today) return cikToTicker;
  try {
    const res = await fetchWithTimeout(COMPANY_TICKERS_URL);
    if (!res.ok) return cikToTicker ?? new Map();
    const json = (await res.json()) as Record<string, { cik_str?: number; ticker?: string }>;
    const byCik = new Map<number, string>();
    const byTicker = new Map<string, number>();
    for (const row of Object.values(json)) {
      if (typeof row?.cik_str === 'number' && typeof row?.ticker === 'string' && row.ticker) {
        const ticker = row.ticker.toUpperCase();
        byCik.set(row.cik_str, ticker);
        byTicker.set(ticker, row.cik_str);
      }
    }
    if (byCik.size > 0) {
      cikToTicker = byCik;
      tickerToCik = byTicker;
      cikMapDay = today;
    }
  } catch {
    /* keep whatever map we already have */
  }
  return cikToTicker ?? new Map();
}

// ── ticker → TradingView symbol ────────────────────────────────────────────
// TV resolves bare tickers by search ranking, which collides for some names
// (2026-07-24: SPRO resolved to CBOE's "S&P 500 Buffer Protect Index"
// instead of Spero Therapeutics — the operator's TV verification loop landed
// on an index chart). SEC's exchange-annotated ticker file disambiguates:
// Nasdaq-listed names get an explicit NASDAQ: prefix. NYSE deliberately
// stays bare — SEC lumps NYSE American/Arca under "NYSE" while TV files
// those under AMEX: (CPHI is "NYSE Arca" on TV), so a blind NYSE: prefix
// would break Arca names, and bare NYSE tickers resolve correctly today.
// Fetched once per day, same UA rules as the CIK map above.
const COMPANY_TICKERS_EXCHANGE_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
let nasdaqTickers: Set<string> | null = null;
let exchMapDay = '';

async function loadExchangeMap(): Promise<Set<string>> {
  const today = new Date().toISOString().slice(0, 10);
  if (nasdaqTickers && exchMapDay === today) return nasdaqTickers;
  try {
    const res = await fetchWithTimeout(COMPANY_TICKERS_EXCHANGE_URL);
    if (!res.ok) return nasdaqTickers ?? new Set();
    const json = (await res.json()) as { fields?: string[]; data?: unknown[][] };
    const ti = json.fields?.indexOf('ticker') ?? -1;
    const ei = json.fields?.indexOf('exchange') ?? -1;
    if (ti >= 0 && ei >= 0 && Array.isArray(json.data)) {
      const set = new Set<string>();
      for (const row of json.data) {
        const t = row?.[ti];
        if (row?.[ei] === 'Nasdaq' && typeof t === 'string' && t) set.add(t.toUpperCase());
      }
      if (set.size > 0) {
        nasdaqTickers = set;
        exchMapDay = today;
      }
    }
  } catch {
    /* keep whatever map we already have */
  }
  return nasdaqTickers ?? new Set();
}

// Synchronous best-effort resolver for alert links: answers from the current
// map (bare ticker until the first daily load lands) and kicks the refresh
// in the background.
export function tvSymbol(ticker: string): string {
  void loadExchangeMap();
  const t = ticker.toUpperCase();
  return nasdaqTickers?.has(t) ? `NASDAQ:${t}` : t;
}

// The full Nasdaq set for the web's TV links (GET /api/screener/tv-map).
export async function nasdaqTickerSet(): Promise<Set<string>> {
  return loadExchangeMap();
}

// Resolve a ticker to its SEC CIK. Returns null for tickers SEC doesn't list
// (most OTC names, some foreign ADRs). Throws if the CIK map could not be
// loaded at all, so a transient fetch failure isn't mistaken for "not listed"
// (the caller retries instead of caching a wrong negative). Used by shelf.ts.
export async function cikForTicker(ticker: string): Promise<number | null> {
  await loadCikMap();
  if (!tickerToCik) throw new Error('SEC CIK map unavailable');
  return tickerToCik.get(ticker.toUpperCase()) ?? null;
}

// ── form taxonomy ──────────────────────────────────────────────────────────
// Only forms that can move a small-cap are kept; routine filings (10-K/10-Q,
// proxy statements, Forms 3/4/5, 144, SD, NT…) are dropped as noise.
function classifyForm(rawForm: string): { form: string; label: string } | null {
  const form = rawForm.toUpperCase().trim().replace(/^SCHEDULE\s+/, 'SC ');
  if (/^424B/.test(form) || form === '424A' || form === 'FWP')
    return { form, label: 'prospectus / offering' };
  if (/^S-1/.test(form) || /^S-3/.test(form) || /^F-1/.test(form) || /^F-3/.test(form) ||
      form === 'POS AM' || form === 'EFFECT')
    return { form, label: 'securities registration' };
  if (form === '8-K' || form === '8-K/A') return { form, label: 'material event' };
  if (form === '6-K' || form === '6-K/A') return { form, label: 'foreign-issuer event' };
  if (form === '425' || /^S-4/.test(form) || form === 'DEFM14A' || form === 'PREM14A' ||
      /^SC TO/.test(form) || form === 'SC 14D9')
    return { form, label: 'merger / acquisition' };
  if (/^SC 13D/.test(form)) return { form, label: 'activist 13D stake' };
  if (/^SC 13G/.test(form)) return { form, label: 'passive 13G stake' };
  if (form === '25' || form === '25-NSE' || /^15-12/.test(form))
    return { form, label: 'delisting notice' };
  return null;
}

export async function fetchEdgarFilings(
  watchTickers: Set<string>,
  prevWatermark: number,
): Promise<EdgarDelta | null> {
  if (watchTickers.size === 0) {
    return { filings: [], freshTickers: new Set(), newWatermark: prevWatermark };
  }

  const cikMap = await loadCikMap();
  if (cikMap.size === 0) return null;

  let xml: string;
  try {
    const res = await fetchWithTimeout(GETCURRENT_URL);
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  }

  const now = Date.now();
  let newWatermark = prevWatermark;
  const fresh = new Set<string>();
  const filings: EdgarFiling[] = [];
  const seenUrls = new Set<string>();

  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const title = tag(block, 'title');
    const updated = tag(block, 'updated');
    const href = block.match(/<link[^>]+href="([^"]+)"/)?.[1] ?? '';
    if (!title || !updated || !href) continue;

    // Entry title shape: "<FORM> - <COMPANY NAME> (<CIK10>) (<RELATION>)".
    const cikM = title.match(/\((\d{10})\)/);
    const relM = title.match(/\(([^()]+)\)\s*$/);
    const formM = title.match(/^(.+?)\s+-\s+/);
    if (!cikM || !formM) continue;

    // A 13D/13G or Form 4 appears twice — once for the investor, once for the
    // company. Drop the investor side; we only want the issuer's ticker.
    const relation = (relM?.[1] ?? '').toLowerCase();
    if (relation.includes('filed by') || relation.includes('reporting')) continue;

    const ticker = cikMap.get(parseInt(cikM[1], 10));
    if (!ticker || !watchTickers.has(ticker)) continue;

    const classified = classifyForm(formM[1]);
    if (!classified) continue;

    const disseminated = new Date(updated);
    if (Number.isNaN(disseminated.getTime())) continue;
    const ts = Math.floor(disseminated.getTime() / 1000);
    if (ts > newWatermark) newWatermark = ts;
    if (now - disseminated.getTime() > MAX_AGE_MS) continue;
    if (seenUrls.has(href)) continue;
    seenUrls.add(href);

    if (ts > prevWatermark) fresh.add(ticker);
    filings.push({
      ticker,
      form: classified.form,
      title: `SEC ${classified.form} · ${classified.label}`,
      url: href,
      published_at: disseminated,
      raw: { title, form: classified.form, url: href, updated },
    });
  }

  filings.sort((a, b) => b.published_at.getTime() - a.published_at.getTime());
  return { filings, freshTickers: fresh, newWatermark };
}

// Extract the text content of a (non-self-closing) XML tag, CDATA-aware.
function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
  if (!m) return null;
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/atom+xml, application/json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

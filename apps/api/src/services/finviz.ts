// Finviz screener client — equivalent of the two parallel curl calls in
// screener-poll_breakout.sh (v=131 ownership + v=110 overview), joined by ticker.

const FINVIZ_BASE = 'https://elite.finviz.com';
const UA = 'Mozilla/5.0';

export interface ScreenerRow {
  ticker: string;
  change_pct: number | null;
  float_m: number | null;
  // True when float_m was filled in from shares_outstanding because Finviz
  // returned no Float value for the row. The displayed value still represents
  // the best-available estimate of tradeable supply.
  float_is_proxy: boolean;
  price: number | null;
  volume: number | null;
  avg_volume: number | null;
  rel_volume: number | null;
  mcap_m: number | null;
  country: string | null;
  company: string | null;
  sector: string | null;
  industry: string | null;
  // Sentiment / ownership fields from v=131 (no extra HTTP cost)
  short_float_pct: number | null;
  short_ratio: number | null;
  insider_own_pct: number | null;
  insider_trans_pct: number | null;
  inst_own_pct: number | null;
  inst_trans_pct: number | null;
  shares_out_m: number | null;
}

function token(): string {
  const t = process.env.FINVIZ_API_TOKEN;
  if (!t) throw new Error('FINVIZ_API_TOKEN is not set');
  return t;
}

async function fetchCsv(url: string): Promise<string[][]> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Finviz HTTP ${res.status}`);
  const text = await res.text();
  return parseCsv(text);
}

// Minimal CSV parser tolerant of quoted fields with commas (Finviz quotes
// company/title fields with embedded commas).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // skip
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1);
}

// Parses Finviz volume-like values returned by v=131. Confirmed by direct
// export inspection (UONE → "42.99" in Average Volume = 42,990 shares):
//   "42.99"   (no suffix)  → 42_990    (implicit K = thousands)
//   "1.5M"    (M suffix)    → 1_500_000
//   "12345"   (no-suffix integer) → 12_345_000  (still K-based by convention)
// Use this for fields that semantically are share counts. For mcap/float that
// the rest of the pipeline stores as `_m` (already in millions), use `num()`.
const SCALE: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
function numScaled(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-') return null;
  const m = cleaned.match(/^([+-]?\d*\.?\d+)([KMBT])?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (Number.isNaN(v)) return null;
  const suffix = m[2]?.toUpperCase();
  if (suffix) return Math.round(v * SCALE[suffix]);
  // No suffix — Finviz exports these fields with implicit K base.
  return Math.round(v * 1000);
}

function num(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[%,]/g, '').trim();
  if (!cleaned || cleaned === '-') return null;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

export interface ScreenerOptions {
  filter: string;       // e.g. ind_stocksonly,sh_float_u50,...
  floatMaxM: number;    // post-filter ceiling
  topN: number;
}

// Fetch one cycle worth of screener rows.
// Mirrors lines 63-114 of screener-poll_breakout.sh.
export async function fetchScreener(opts: ScreenerOptions): Promise<ScreenerRow[]> {
  const f = encodeURIComponent(opts.filter);
  const ownershipUrl = `${FINVIZ_BASE}/export?v=131&f=${f}&o=-change&auth=${token()}`;
  const overviewUrl = `${FINVIZ_BASE}/export?v=110&f=${f}&o=-change&auth=${token()}`;

  const [ownership, overview] = await Promise.all([
    fetchCsv(ownershipUrl),
    fetchCsv(overviewUrl),
  ]);

  // v=110 (overview) header order: No, Ticker, Company, Sector, Industry, Country, ...
  type Meta = { company: string | null; sector: string | null; industry: string | null; country: string | null };
  const metaByTicker = new Map<string, Meta>();
  for (let i = 1; i < overview.length; i++) {
    const r = overview[i];
    if (r.length >= 6) {
      metaByTicker.set(r[1], {
        company: r[2] || null,
        sector: r[3] || null,
        industry: r[4] || null,
        country: r[5] || null,
      });
    }
  }

  // v=131 (ownership) header order: No, Ticker, Market Cap, Outstanding,
  // Float, Insider Own, Insider Trans, Inst Own, Inst Trans, Float Short,
  // Short Ratio, Avg Volume, Price, Change, Volume.
  const out: ScreenerRow[] = [];
  for (let i = 1; i < ownership.length && out.length < opts.topN; i++) {
    const r = ownership[i];
    if (r.length < 15) continue;
    const ticker = r[1];
    const rawFloat = num(r[4]);
    const sharesOut = num(r[3]);
    // Size cap based on best-available "tradeable supply" estimate. If Finviz
    // returned a Float value, use it. If not (Finviz often misses Float for
    // recent IPOs / nano-caps like CNSP), fall back to Shares Outstanding —
    // for tiny issuers these are effectively equal anyway, and skipping these
    // rows would silently drop legitimate momentum candidates.
    let floatValue: number | null;
    let floatIsProxy: boolean;
    if (rawFloat != null && rawFloat > 0) {
      floatValue = rawFloat;
      floatIsProxy = false;
    } else if (sharesOut != null && sharesOut > 0) {
      floatValue = sharesOut;
      floatIsProxy = true;
    } else {
      continue;
    }
    if (floatValue >= opts.floatMaxM) continue;
    const meta = metaByTicker.get(ticker);
    const avg_volume = numScaled(r[11]);   // v=131 col 11 = Avg Volume; Finviz returns this with K/M/B suffix
    const volume = num(r[14]);
    const rel_volume = avg_volume && avg_volume > 0 && volume != null
      ? +(volume / avg_volume).toFixed(2)
      : null;
    out.push({
      ticker,
      change_pct: num(r[13]),
      float_m: floatValue,
      float_is_proxy: floatIsProxy,
      price: num(r[12]),
      volume,
      avg_volume,
      rel_volume,
      mcap_m: num(r[2]),
      country: meta?.country ?? null,
      company: meta?.company ?? null,
      sector: meta?.sector ?? null,
      industry: meta?.industry ?? null,
      // v=131 columns 3, 5–10. Insider/Inst Own & Trans, Short Float & Ratio,
      // Shares Outstanding (returned in millions like Float).
      shares_out_m:      num(r[3]),
      insider_own_pct:   num(r[5]),
      insider_trans_pct: num(r[6]),
      inst_own_pct:      num(r[7]),
      inst_trans_pct:    num(r[8]),
      short_float_pct:   num(r[9]),
      short_ratio:       num(r[10]),
    });
  }
  return out;
}

// Batch news fetch. Returns ticker → { title, url, published_at } where
// published_at is the Finviz date string (ET-local, no TZ).
export interface FinvizNewsItem {
  ticker: string;
  title: string;
  url: string;
  date: string; // raw "YYYY-MM-DD HH:MM:SS"
}

export async function fetchFinvizNews(tickers: string[], todayEt: string): Promise<FinvizNewsItem[]> {
  if (tickers.length === 0) return [];
  const t = tickers.join(',');
  const url = `${FINVIZ_BASE}/news_export?v=3&t=${t}&auth=${token()}`;
  let rows: string[][];
  try {
    rows = await fetchCsv(url);
  } catch {
    return [];
  }

  // header: Title, Source, Date, Url, Category, Ticker
  const out: FinvizNewsItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 6) continue;
    const [title, , date, link, , ticker] = r;
    if (!title || !ticker) continue;
    if (todayEt && !date.startsWith(todayEt)) continue;
    out.push({
      ticker,
      title: title.replace(/[\t\n]/g, ' ').trim(),
      url: link,
      date,
    });
  }
  return out;
}

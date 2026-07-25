// Benzinga news delta client. Mirrors the bash script's overlap-then-strict-dedup
// pattern: query with `updatedSince = stored_max - 5` to absorb race conditions,
// but classify articles as truly fresh ONLY if their ts > stored_max.

const ENDPOINT = 'https://api.benzinga.com/api/v2/news';

export interface BenzingaArticle {
  title: string;
  url: string;
  published_at: Date;
  updated_ts: number;       // raw unix seconds from API
  tickers: string[];
  raw: unknown;
}

export interface BenzingaDelta {
  articles: BenzingaArticle[];
  freshTickers: Set<string>;  // tickers whose ts > prevWatermark
  newWatermark: number;
}

let disabledLogged = false;

export async function fetchBenzingaDelta(
  prevWatermark: number,
  todayEt: string,
): Promise<BenzingaDelta | null> {
  // BENZINGA_DISABLED=true parks the subscription without unwiring the
  // token (2026-07-25, operator's call — EMA layers are the primary
  // instrument; the 📰 radar, this feed's main consumer, is Telegram-muted
  // anyway). Consequences while off: the radar goes dark (this delta is its
  // only source), market-wide news coverage shrinks to Finviz/Yahoo/SEC/
  // halts. Re-enable: flip the env + `up -d api`.
  if (process.env.BENZINGA_DISABLED === 'true') {
    if (!disabledLogged) {
      disabledLogged = true;
      console.log('[benzinga] BENZINGA_DISABLED — market-wide delta off (radar dark; Finviz/Yahoo/SEC/halt news continue)');
    }
    return null;
  }
  const tk = process.env.BENZINGA_API_TOKEN;
  if (!tk) return null;

  const since = Math.max(0, prevWatermark - 5);
  // Paginate: a market-wide news burst (8:30/9:30 ET) can exceed one page per
  // 20s cycle, and articles past the page silently vanish behind the advanced
  // watermark. Verified live: `page` is 0-based with no overlap between pages.
  const PAGE_SIZE = 100;
  const MAX_PAGES = 3;
  const items: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let json: unknown;
    try {
      const url = `${ENDPOINT}?pageSize=${PAGE_SIZE}&page=${page}&updatedSince=${since}&displayOutput=headline&token=${tk}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } catch {
      // First page failed → no delta this cycle (watermark unmoved, retried
      // next cycle). A later page failing → process the pages we did get.
      if (page === 0) return null;
      break;
    }
    if (!Array.isArray(json)) break;
    items.push(...json);
    if (json.length < PAGE_SIZE) break;
  }

  let newWatermark = prevWatermark;
  const fresh = new Set<string>();
  const articles: BenzingaArticle[] = [];

  for (const it of items as Array<Record<string, unknown>>) {
    const updated = typeof it.updated === 'string' ? it.updated : '';
    const dt = new Date(updated);
    if (Number.isNaN(dt.getTime())) continue;
    const ts = Math.floor(dt.getTime() / 1000);
    if (ts > newWatermark) newWatermark = ts;

    if (todayEt && etDateString(dt) !== todayEt) continue;

    const title = typeof it.title === 'string' ? it.title.replace(/[\t\n]/g, ' ').trim() : '';
    const url = typeof it.url === 'string' ? it.url : '';
    const stocks = Array.isArray(it.stocks) ? it.stocks : [];
    const tickers: string[] = [];
    for (const s of stocks) {
      const name = (s as Record<string, unknown>)?.name;
      if (typeof name === 'string' && name.trim()) tickers.push(name.trim().toUpperCase());
    }

    if (!title || !url || tickers.length === 0) continue;

    const isFresh = ts > prevWatermark;
    if (isFresh) for (const t of tickers) fresh.add(t);

    articles.push({
      title,
      url,
      published_at: dt,
      updated_ts: ts,
      tickers,
      raw: it,
    });
  }

  return { articles, freshTickers: fresh, newWatermark };
}

function etDateString(dt: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt);
}

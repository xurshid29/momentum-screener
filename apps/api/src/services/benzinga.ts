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

export async function fetchBenzingaDelta(
  prevWatermark: number,
  todayEt: string,
): Promise<BenzingaDelta | null> {
  const tk = process.env.BENZINGA_API_TOKEN;
  if (!tk) return null;

  const since = Math.max(0, prevWatermark - 5);
  const url = `${ENDPOINT}?pageSize=100&updatedSince=${since}&displayOutput=headline&token=${tk}`;
  let json: unknown;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    json = await res.json();
  } catch {
    return null;
  }

  if (!Array.isArray(json)) return { articles: [], freshTickers: new Set(), newWatermark: prevWatermark };

  let newWatermark = prevWatermark;
  const fresh = new Set<string>();
  const articles: BenzingaArticle[] = [];

  for (const it of json as Array<Record<string, unknown>>) {
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

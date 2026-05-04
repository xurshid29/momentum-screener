// Yahoo Finance RSS news client. Per-ticker fan-out, parallel via Promise.all.
// Returns at most one (latest) headline per ticker, filtered to today in ET.

const UA = 'Mozilla/5.0';
const TIMEOUT_MS = 5000;

export interface YahooNewsItem {
  ticker: string;
  title: string;
  url: string;
  published_at: Date;
}

export async function fetchYahooNews(tickers: string[], todayEt: string): Promise<YahooNewsItem[]> {
  if (tickers.length === 0) return [];
  const results = await Promise.all(
    tickers.map((t) => fetchOne(t, todayEt).catch(() => null)),
  );
  return results.filter((r): r is YahooNewsItem => r !== null);
}

async function fetchOne(ticker: string, todayEt: string): Promise<YahooNewsItem | null> {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let xml: string;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  // Yahoo RSS is well-formed; lightweight regex extraction is enough and avoids
  // pulling in an XML parser dep. Item shape:
  //   <item><title>...</title><link>...</link><pubDate>Wed, 03 May 2026 12:34:56 +0000</pubDate>...</item>
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let best: YahooNewsItem | null = null;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = extract(block, 'title');
    const link = extract(block, 'link');
    const pub = extract(block, 'pubDate');
    if (!title || !pub) continue;
    const dt = new Date(pub);
    if (Number.isNaN(dt.getTime())) continue;
    if (todayEt && etDateString(dt) !== todayEt) continue;
    if (!best || dt > best.published_at) {
      best = {
        ticker,
        title: title.replace(/[\t\n]/g, ' ').trim(),
        url: link ?? '',
        published_at: dt,
      };
    }
  }
  return best;
}

function extract(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
  const m = block.match(re);
  if (!m) return null;
  // strip CDATA + decode minimal entities
  let v = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  v = v
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return v.trim();
}

// Format a Date as YYYY-MM-DD in America/New_York.
function etDateString(dt: Date): string {
  // en-CA gives ISO-like YYYY-MM-DD ordering reliably.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(dt);
}
